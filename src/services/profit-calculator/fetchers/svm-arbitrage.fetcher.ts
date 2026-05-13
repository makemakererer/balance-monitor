import { ConfirmedSignatureInfo, Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import {
	enabledNetworks,
	loadMonitoredSvmWallet,
	rpcScanLimits,
	svmExecutorProgramId,
	svmScanPrivateRpcUrl,
	svmScanPublicRpcUrl,
	tokenConfig,
	tokensToChain
} from "../../../config";
import { Network, TokenSymbol } from "../../../types";
import { FetcherResult, ParsedTransaction, ProfitWindow, ScanFailure, TypeRoute } from "../../../types/profit-calculator.types";
import { log, sleep } from "../../../utils";

interface MintMeta {
	symbol: TokenSymbol;
	decimals: number;
}

class SvmArbitrageFetcher {
	public async fetchByToken(token: TokenSymbol, window: ProfitWindow): Promise<FetcherResult> {
		if (!enabledNetworks[Network.SOLANA]) {
			log.info(`[profit:${token}][SOLANA] disabled in enabledNetworks, skipping`);
			return { transactions: [], failures: [] };
		}

		const solanaTokenAddress = tokensToChain[Network.SOLANA]?.[token];
		if (!solanaTokenAddress) {
			log.info(`[profit:${token}][SOLANA] no mint configured for this token, skipping`);
			return { transactions: [], failures: [] };
		}

		const wallet = new PublicKey(loadMonitoredSvmWallet());
		const publicConnection = new Connection(svmScanPublicRpcUrl, {
			commitment: "confirmed",
			disableRetryOnRateLimit: true
		});
		const privateConnection = new Connection(svmScanPrivateRpcUrl, "confirmed");
		const mintLookup = this.buildMintLookup();

		log.info(`[profit:${token}][SOLANA] step 1: collecting signatures within window`);
		let signatures;
		try {
			signatures = await this.collectSignaturesInWindow(publicConnection, wallet, window);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`[profit:${token}][SOLANA] signature scan failed: ${message}`);
			return { transactions: [], failures: [{ network: Network.SOLANA, detail: `signature scan threw: ${message}` }] };
		}
		log.success(`[profit:${token}][SOLANA] signatures in window: ${signatures.length}`);
		if (signatures.length === 0) return { transactions: [], failures: [] };

		log.info(`[profit:${token}][SOLANA] step 2: fetching parsed transactions in batches of ${rpcScanLimits.svmTransactionsBatchSize}`);
		const scan = await this.parseSvmTradesFromSignatures(
			privateConnection,
			signatures,
			wallet.toBase58(),
			token,
			mintLookup
		);
		const failures: ScanFailure[] = scan.failure ? [scan.failure] : [];
		if (scan.failure) {
			log.error(
				`[profit:${token}][SOLANA] arbitrage scan INCOMPLETE: ${scan.transactions.length} event(s) collected, but chain data is partial`
			);
		} else {
			log.success(`[profit:${token}][SOLANA] arbitrage events: ${scan.transactions.length}`);
		}
		return { transactions: scan.transactions, failures };
	}

	private buildMintLookup(): Map<string, MintMeta> {
		const solanaTokens = tokensToChain[Network.SOLANA] ?? {};
		const map = new Map<string, MintMeta>();
		for (const mint of Object.values(solanaTokens)) {
			const meta = tokenConfig[mint];
			if (!meta) {
				log.warning(`[SOLANA] mint ${mint} present in tokensToChain but absent from tokenConfig — skipping in lookup`);
				continue;
			}
			map.set(mint, { symbol: meta.symbol, decimals: meta.decimals });
		}
		return map;
	}

	private async collectSignaturesInWindow(
		connection: Connection,
		wallet: PublicKey,
		window: ProfitWindow
	): Promise<ConfirmedSignatureInfo[]> {
		const collected: ConfirmedSignatureInfo[] = [];
		let before: string | undefined = undefined;
		let stoppedByWindow = false;
		let consecutiveErrors = 0;

		while (!stoppedByWindow) {
			try {
				const page: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(wallet, {
					limit: rpcScanLimits.svmSignaturesPerCall,
					before
				});
				consecutiveErrors = 0;
				if (page.length === 0) break;

				for (const sig of page) {
					if (sig.blockTime === null || sig.blockTime === undefined) continue;
					if (sig.blockTime >= window.toTimestampSeconds) continue;
					if (sig.blockTime < window.fromTimestampSeconds) {
						stoppedByWindow = true;
						break;
					}
					if (sig.err) continue;
					collected.push(sig);
				}

				before = page[page.length - 1].signature;
				log.info(`[SOLANA] signatures scanned: page=${page.length} kept=${collected.length}`);
				await sleep(rpcScanLimits.svmSignatureCallDelayMs);
			} catch (error) {
				consecutiveErrors++;
				const message = error instanceof Error ? error.message : String(error);
				if (consecutiveErrors >= rpcScanLimits.svmSignatureMaxConsecutiveErrors) {
					throw new Error(`[SOLANA] signature scan aborted after ${consecutiveErrors} consecutive errors: ${message}`);
				}
				if (message.includes("429")) {
					log.warning(
						`[SOLANA] rate limit (429) ${consecutiveErrors}/${rpcScanLimits.svmSignatureMaxConsecutiveErrors}, backing off ${rpcScanLimits.svmRateLimitBackoffMs}ms`
					);
					await sleep(rpcScanLimits.svmRateLimitBackoffMs);
					continue;
				}
				log.warning(
					`[SOLANA] signature page error ${consecutiveErrors}/${rpcScanLimits.svmSignatureMaxConsecutiveErrors}, retrying: ${message}`
				);
				await sleep(rpcScanLimits.svmGenericErrorBackoffMs);
			}
		}

		return collected;
	}

	private async parseSvmTradesFromSignatures(
		connection: Connection,
		signatures: ConfirmedSignatureInfo[],
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, MintMeta>
	): Promise<{ transactions: ParsedTransaction[]; failure: ScanFailure | null }> {
		const transactions: ParsedTransaction[] = [];

		const allBatches: ConfirmedSignatureInfo[][] = [];
		for (let offset = 0; offset < signatures.length; offset += rpcScanLimits.svmTransactionsBatchSize) {
			allBatches.push(signatures.slice(offset, offset + rpcScanLimits.svmTransactionsBatchSize));
		}
		const totalBatches = allBatches.length;

		let pending = allBatches;
		for (let pass = 1; pass <= rpcScanLimits.svmTransactionsBatchMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[SOLANA] arbitrage parsed-tx retry pass ${pass}/${rpcScanLimits.svmTransactionsBatchMaxPasses}: re-fetching ${pending.length} batch(es) that failed earlier`
				);
			}

			const stillFailing: ConfirmedSignatureInfo[][] = [];
			for (const batch of pending) {
				const batchTxs = await this.tryFetchBatchTrades(connection, batch, walletAddress, targetToken, mintLookup);
				if (batchTxs === null) {
					stillFailing.push(batch);
				} else {
					transactions.push(...batchTxs);
				}
			}

			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[SOLANA] arbitrage parsed-tx retry pass ${pass}: recovered ${recovered}/${pending.length} batch(es)`);
			}
			pending = stillFailing;
		}

		if (pending.length === 0) return { transactions, failure: null };

		const droppedSigs = pending.reduce((sum, batch) => sum + batch.length, 0);
		const detail = `parsed-tx lost ${pending.length}/${totalBatches} batch(es) = ${droppedSigs} signature(s) after ${rpcScanLimits.svmTransactionsBatchMaxPasses} pass(es)`;
		log.error(`[SOLANA] ${detail}; arbitrages inside those sigs will be missing from this run`);
		return { transactions, failure: { network: Network.SOLANA, detail } };
	}

	private async tryFetchBatchTrades(
		connection: Connection,
		batch: ConfirmedSignatureInfo[],
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, MintMeta>
	): Promise<ParsedTransaction[] | null> {
		let retries = rpcScanLimits.svmTransactionsBatchRetries;
		while (retries > 0) {
			try {
				const sigStrings = batch.map((s) => s.signature);
				const txs = await connection.getParsedTransactions(sigStrings, {
					maxSupportedTransactionVersion: 0,
					commitment: "confirmed"
				});
				const trades: ParsedTransaction[] = [];
				for (let index = 0; index < txs.length; index++) {
					const tx = txs[index];
					const sigInfo = batch[index];
					if (!tx || !tx.meta || tx.meta.err) continue;
					if (!this.isWalletSigner(tx, walletAddress)) continue;
					if (!this.invokesExecutor(tx)) continue;

					const parsed = this.parseTradeTx(tx, sigInfo, walletAddress, targetToken, mintLookup);
					if (parsed) trades.push(parsed);
				}
				await sleep(rpcScanLimits.svmTransactionsBatchInterDelayMs);
				return trades;
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[SOLANA] arbitrage batch failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[SOLANA] gave up on arbitrage batch of ${batch.length} signature(s)`);
					return null;
				}
				await sleep(rpcScanLimits.svmTransactionsBatchRetryDelayMs);
			}
		}
		return null;
	}

	private isWalletSigner(tx: ParsedTransactionWithMeta, walletAddress: string): boolean {
		const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58());
		return signers.includes(walletAddress);
	}

	private invokesExecutor(tx: ParsedTransactionWithMeta): boolean {
		for (const instruction of tx.transaction.message.instructions) {
			if (instruction.programId.toBase58() === svmExecutorProgramId) return true;
		}
		for (const inner of tx.meta?.innerInstructions ?? []) {
			for (const instruction of inner.instructions) {
				if (instruction.programId.toBase58() === svmExecutorProgramId) return true;
			}
		}
		return false;
	}

	private getTokenBalanceChanges(
		tx: ParsedTransactionWithMeta,
		walletAddress: string,
		mintLookup: Map<string, MintMeta>
	): { mint: string; change: bigint }[] {
		const pre = tx.meta?.preTokenBalances ?? [];
		const post = tx.meta?.postTokenBalances ?? [];
		const changes: { mint: string; change: bigint }[] = [];

		for (const postEntry of post) {
			if (postEntry.owner !== walletAddress) continue;

			const preEntry = pre.find((b) => b.mint === postEntry.mint && b.owner === postEntry.owner);
			const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
			const postAmount = BigInt(postEntry.uiTokenAmount.amount);
			const change = postAmount - preAmount;

			if (change !== 0n && mintLookup.has(postEntry.mint)) {
				changes.push({ mint: postEntry.mint, change });
			}
		}
		return changes;
	}

	private parseTradeTx(
		tx: ParsedTransactionWithMeta,
		sigInfo: ConfirmedSignatureInfo,
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, MintMeta>
	): ParsedTransaction | null {
		const changes = this.getTokenBalanceChanges(tx, walletAddress, mintLookup);
		if (changes.length < 2) return null;

		const received = changes.find((c) => c.change > 0n);
		const sent = changes.find((c) => c.change < 0n);
		if (!received || !sent) return null;

		const receivedMeta = mintLookup.get(received.mint);
		const sentMeta = mintLookup.get(sent.mint);
		if (!receivedMeta || !sentMeta) return null;

		if (receivedMeta.symbol !== targetToken && sentMeta.symbol !== targetToken) return null;
		if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) return null;

		const type = sentMeta.symbol === targetToken ? TypeRoute.SELL : TypeRoute.BUY;
		const amountIn = parseFloat(ethers.formatUnits(-sent.change, sentMeta.decimals)).toFixed(5);
		const amountOut = parseFloat(ethers.formatUnits(received.change, receivedMeta.decimals)).toFixed(5);

		return {
			hash: sigInfo.signature,
			timestamp: new Date(sigInfo.blockTime * 1000).toISOString(),
			network: Network.SOLANA,
			type,
			tokenIn: sentMeta.symbol,
			tokenOut: receivedMeta.symbol,
			amountIn,
			amountOut,
			blockNumber: sigInfo.slot
		};
	}
}

export { SvmArbitrageFetcher };
