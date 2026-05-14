import {
	ConfirmedSignatureInfo,
	Connection,
	ParsedInstruction,
	ParsedTransactionWithMeta,
	PublicKey,
	SystemProgram
} from "@solana/web3.js";
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
import {
	FetcherSpendResult,
	NativeSpendScanFailure,
	NativeSpendWindow,
	Network,
	SpendIntent,
	SpendRecord,
	SpendStatus,
	TokenSymbol
} from "../../../types";
import { log, sleep } from "../../../utils";

const SYSTEM_PROGRAM_ID: string = SystemProgram.programId.toBase58();

class SvmArbSpendFetcher {
	public async fetchByToken(token: TokenSymbol, window: NativeSpendWindow): Promise<FetcherSpendResult> {
		if (!enabledNetworks[Network.SOLANA]) {
			log.info(`[native-spend:${token}][SOLANA] disabled in enabledNetworks, skipping`);
			return { records: [], unattributedRecords: [], failures: [] };
		}

		const tokenMint = tokensToChain[Network.SOLANA]?.[token];
		if (!tokenMint) {
			log.info(`[native-spend:${token}][SOLANA] no mint configured for this token, skipping`);
			return { records: [], unattributedRecords: [], failures: [] };
		}

		const walletAddress = loadMonitoredSvmWallet();
		const wallet = new PublicKey(walletAddress);
		const publicConnection = new Connection(svmScanPublicRpcUrl, {
			commitment: "confirmed",
			disableRetryOnRateLimit: true
		});
		const privateConnection = new Connection(svmScanPrivateRpcUrl, "confirmed");
		const mintLookup = this.buildMintLookup();

		log.info(`[native-spend:${token}][SOLANA] step 1: collecting signatures within window`);
		let signatures: ConfirmedSignatureInfo[];
		try {
			signatures = await this.collectSignaturesInWindow(publicConnection, wallet, window);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`[native-spend:${token}][SOLANA] signature scan failed: ${message}`);
			return {
				records: [],
				unattributedRecords: [],
				failures: [{ network: Network.SOLANA, intent: SpendIntent.ARBITRAGE, detail: `signature scan threw: ${message}` }]
			};
		}
		log.success(`[native-spend:${token}][SOLANA] signatures in window: ${signatures.length}`);
		if (signatures.length === 0) return { records: [], unattributedRecords: [], failures: [] };

		log.info(
			`[native-spend:${token}][SOLANA] step 2: fetching parsed transactions in batches of ${rpcScanLimits.svmTransactionsBatchSize}`
		);
		const scan = await this.parseArbSpendFromSignatures(privateConnection, signatures, walletAddress, token, mintLookup);
		const failures: NativeSpendScanFailure[] = scan.failure ? [scan.failure] : [];
		if (scan.failure) {
			log.error(
				`[native-spend:${token}][SOLANA] arb-spend scan INCOMPLETE: ${scan.records.length} record(s) collected, but chain data is partial`
			);
		} else {
			log.success(`[native-spend:${token}][SOLANA] records: ${scan.records.length}`);
		}
		return { records: scan.records, unattributedRecords: [], failures };
	}

	private buildMintLookup(): Map<string, TokenSymbol> {
		const map = new Map<string, TokenSymbol>();
		const solanaTokens = tokensToChain[Network.SOLANA] ?? {};
		for (const mint of Object.values(solanaTokens)) {
			const meta = tokenConfig[mint];
			if (!meta) {
				log.warning(`[SOLANA] mint ${mint} present in tokensToChain but absent from tokenConfig — skipping in lookup`);
				continue;
			}
			map.set(mint, meta.symbol);
		}
		return map;
	}

	private async collectSignaturesInWindow(
		connection: Connection,
		wallet: PublicKey,
		window: NativeSpendWindow
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

	private async parseArbSpendFromSignatures(
		connection: Connection,
		signatures: ConfirmedSignatureInfo[],
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, TokenSymbol>
	): Promise<{ records: SpendRecord[]; failure: NativeSpendScanFailure | null }> {
		const records: SpendRecord[] = [];

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
					`[SOLANA] arb-spend parsed-tx retry pass ${pass}/${rpcScanLimits.svmTransactionsBatchMaxPasses}: re-fetching ${pending.length} batch(es) that failed earlier`
				);
			}

			const stillFailing: ConfirmedSignatureInfo[][] = [];
			for (const batch of pending) {
				const batchRecords = await this.tryFetchBatchSpend(connection, batch, walletAddress, targetToken, mintLookup);
				if (batchRecords === null) stillFailing.push(batch);
				else records.push(...batchRecords);
			}

			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[SOLANA] arb-spend parsed-tx retry pass ${pass}: recovered ${recovered}/${pending.length} batch(es)`);
			}
			pending = stillFailing;
		}

		if (pending.length === 0) return { records, failure: null };

		const droppedSigs = pending.reduce((sum, batch) => sum + batch.length, 0);
		const detail = `parsed-tx lost ${pending.length}/${totalBatches} batch(es) = ${droppedSigs} signature(s) after ${rpcScanLimits.svmTransactionsBatchMaxPasses} pass(es)`;
		log.error(`[SOLANA] ${detail}; arb-spend records inside those sigs will be missing from this run`);
		return { records, failure: { network: Network.SOLANA, intent: SpendIntent.ARBITRAGE, detail } };
	}

	private async tryFetchBatchSpend(
		connection: Connection,
		batch: ConfirmedSignatureInfo[],
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, TokenSymbol>
	): Promise<SpendRecord[] | null> {
		let retries = rpcScanLimits.svmTransactionsBatchRetries;
		while (retries > 0) {
			try {
				const sigStrings = batch.map((s) => s.signature);
				const txs = await connection.getParsedTransactions(sigStrings, {
					maxSupportedTransactionVersion: 0,
					commitment: "confirmed"
				});
				const out: SpendRecord[] = [];
				for (let index = 0; index < txs.length; index++) {
					const tx = txs[index];
					const sigInfo = batch[index];
					if (!tx || !tx.meta) continue;
					if (!this.isWalletSigner(tx, walletAddress)) continue;
					if (!this.invokesExecutor(tx)) continue;
					if (!this.involvesTargetToken(tx, walletAddress, targetToken, mintLookup)) continue;
					if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) continue;

					const status = tx.meta.err === null ? SpendStatus.SUCCESS : SpendStatus.REVERTED;
					const built = this.buildRecordsForTx(tx, sigInfo, walletAddress, targetToken, status);
					out.push(...built);
				}
				await sleep(rpcScanLimits.svmTransactionsBatchInterDelayMs);
				return out;
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[SOLANA] arb-spend batch failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[SOLANA] gave up on arb-spend batch of ${batch.length} signature(s)`);
					return null;
				}
				await sleep(rpcScanLimits.svmTransactionsBatchRetryDelayMs);
			}
		}
		return null;
	}

	private buildRecordsForTx(
		tx: ParsedTransactionWithMeta,
		sigInfo: ConfirmedSignatureInfo,
		walletAddress: string,
		targetToken: TokenSymbol,
		status: SpendStatus
	): SpendRecord[] {
		const blockTime = sigInfo.blockTime as number;
		const fee = BigInt(tx.meta?.fee ?? 0);
		// SystemProgram.Transfer instructions roll back on revert — only the
		// base+priority fee is actually charged for a failed tx.
		const tips = status === SpendStatus.SUCCESS ? this.sumSystemTransfersFromWallet(tx, walletAddress) : 0n;
		const total = fee + tips;
		if (total === 0n) return [];

		const detailParts: string[] = [];
		if (fee > 0n) detailParts.push("base+priority fee");
		if (tips > 0n) detailParts.push("validator tips");
		const label = status === SpendStatus.SUCCESS ? "Solana arb tx" : "Solana arb tx reverted";
		return [
			{
				network: Network.SOLANA,
				intent: SpendIntent.ARBITRAGE,
				status,
				token: targetToken,
				txHash: sigInfo.signature,
				blockNumber: sigInfo.slot,
				timestampSeconds: blockTime,
				timestampIso: new Date(blockTime * 1000).toISOString(),
				payer: walletAddress,
				nativeAmount: total.toString(),
				usdAmount: null,
				breakdown: {
					gas: fee.toString(),
					...(tips > 0n ? { tips: tips.toString() } : {})
				},
				detail: `${label} (${detailParts.join(" + ")})`
			}
		];
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

	private involvesTargetToken(
		tx: ParsedTransactionWithMeta,
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, TokenSymbol>
	): boolean {
		const pre = tx.meta?.preTokenBalances ?? [];
		const post = tx.meta?.postTokenBalances ?? [];
		for (const entry of [...pre, ...post]) {
			if (entry.owner !== walletAddress) continue;
			const symbol = mintLookup.get(entry.mint);
			if (symbol === targetToken) return true;
		}
		return false;
	}

	private sumSystemTransfersFromWallet(tx: ParsedTransactionWithMeta, walletAddress: string): bigint {
		let total = 0n;

		const accumulate = (instructions: ReadonlyArray<unknown>): void => {
			for (const raw of instructions) {
				const ix = raw as ParsedInstruction;
				if (!ix.programId) continue;
				if (ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) continue;
				if (!ix.parsed || ix.parsed.type !== "transfer") continue;
				const info = ix.parsed.info as { source?: string; lamports?: number | string } | undefined;
				if (!info || info.source !== walletAddress || info.lamports === undefined) continue;
				total += BigInt(info.lamports);
			}
		};

		accumulate(tx.transaction.message.instructions);
		for (const inner of tx.meta?.innerInstructions ?? []) {
			accumulate(inner.instructions);
		}
		return total;
	}
}

export { SvmArbSpendFetcher };
