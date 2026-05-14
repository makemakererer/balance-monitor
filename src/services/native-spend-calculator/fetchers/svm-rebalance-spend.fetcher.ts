import {
	ConfirmedSignatureInfo,
	Connection,
	ParsedInstruction,
	ParsedTransactionWithMeta,
	PartiallyDecodedInstruction,
	PublicKey
} from "@solana/web3.js";
import {
	cctpSvmTokenMessengerProgramId,
	enabledNetworks,
	loadMonitoredSvmWallet,
	rpcScanLimits,
	svmExecutorProgramId,
	svmOftProgramId,
	svmScanPrivateRpcUrl,
	svmScanPublicRpcUrl,
	tokenConfig,
	tokensToChain
} from "../../../config";
import {
	BridgeKind,
	FetcherSpendResult,
	NativeSpendScanFailure,
	NativeSpendWindow,
	Network,
	SpendIntent,
	SpendRecord,
	SpendStatus,
	TokenSymbol,
	UnattributedSpendRecord
} from "../../../types";
import { log, sleep } from "../../../utils";

class SvmRebalanceSpendFetcher {
	public async fetch(window: NativeSpendWindow): Promise<FetcherSpendResult> {
		if (!enabledNetworks[Network.SOLANA]) {
			log.info(`[native-spend:rebalance][SOLANA] disabled in enabledNetworks, skipping`);
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

		log.info(`[native-spend:rebalance][SOLANA] step 1: collecting signatures within window`);
		let signatures: ConfirmedSignatureInfo[];
		try {
			signatures = await this.collectSignaturesInWindow(publicConnection, wallet, window);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`[native-spend:rebalance][SOLANA] signature scan failed: ${message}`);
			return {
				records: [],
				unattributedRecords: [],
				failures: [
					{ network: Network.SOLANA, intent: SpendIntent.REBALANCE, detail: `signature scan threw: ${message}` }
				]
			};
		}
		log.success(`[native-spend:rebalance][SOLANA] signatures in window: ${signatures.length}`);
		if (signatures.length === 0) return { records: [], unattributedRecords: [], failures: [] };

		log.info(
			`[native-spend:rebalance][SOLANA] step 2: fetching parsed transactions in batches of ${rpcScanLimits.svmTransactionsBatchSize}`
		);
		const scan = await this.parseRebalanceSpendFromSignatures(
			privateConnection,
			signatures,
			walletAddress,
			mintLookup
		);
		const failures: NativeSpendScanFailure[] = scan.failure ? [scan.failure] : [];
		if (scan.failure) {
			log.error(
				`[native-spend:rebalance][SOLANA] rebalance-spend scan INCOMPLETE: ${scan.records.length} record(s) collected, but chain data is partial`
			);
		} else {
			log.success(
				`[native-spend:rebalance][SOLANA] records: ${scan.records.length}, unattributed: ${scan.unattributedRecords.length}`
			);
		}
		return { records: scan.records, unattributedRecords: scan.unattributedRecords, failures };
	}

	private buildMintLookup(): Map<string, TokenSymbol> {
		const map = new Map<string, TokenSymbol>();
		const solanaTokens = tokensToChain[Network.SOLANA] ?? {};
		for (const mint of Object.values(solanaTokens)) {
			const meta = tokenConfig[mint];
			if (!meta) continue;
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

	private async parseRebalanceSpendFromSignatures(
		connection: Connection,
		signatures: ConfirmedSignatureInfo[],
		walletAddress: string,
		mintLookup: Map<string, TokenSymbol>
	): Promise<{
		records: SpendRecord[];
		unattributedRecords: UnattributedSpendRecord[];
		failure: NativeSpendScanFailure | null;
	}> {
		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];

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
					`[SOLANA] rebalance-spend parsed-tx retry pass ${pass}/${rpcScanLimits.svmTransactionsBatchMaxPasses}: re-fetching ${pending.length} batch(es) that failed earlier`
				);
			}

			const stillFailing: ConfirmedSignatureInfo[][] = [];
			for (const batch of pending) {
				const batchResult = await this.tryFetchBatchSpend(connection, batch, walletAddress, mintLookup);
				if (batchResult === null) stillFailing.push(batch);
				else {
					records.push(...batchResult.records);
					unattributedRecords.push(...batchResult.unattributedRecords);
				}
			}

			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(
					`[SOLANA] rebalance-spend parsed-tx retry pass ${pass}: recovered ${recovered}/${pending.length} batch(es)`
				);
			}
			pending = stillFailing;
		}

		if (pending.length === 0) return { records, unattributedRecords, failure: null };

		const droppedSigs = pending.reduce((sum, batch) => sum + batch.length, 0);
		const detail = `parsed-tx lost ${pending.length}/${totalBatches} batch(es) = ${droppedSigs} signature(s) after ${rpcScanLimits.svmTransactionsBatchMaxPasses} pass(es)`;
		log.error(`[SOLANA] ${detail}; rebalance-spend records inside those sigs will be missing from this run`);
		return {
			records,
			unattributedRecords,
			failure: { network: Network.SOLANA, intent: SpendIntent.REBALANCE, detail }
		};
	}

	private async tryFetchBatchSpend(
		connection: Connection,
		batch: ConfirmedSignatureInfo[],
		walletAddress: string,
		mintLookup: Map<string, TokenSymbol>
	): Promise<{ records: SpendRecord[]; unattributedRecords: UnattributedSpendRecord[] } | null> {
		let retries = rpcScanLimits.svmTransactionsBatchRetries;
		while (retries > 0) {
			try {
				const sigStrings = batch.map((s) => s.signature);
				const txs = await connection.getParsedTransactions(sigStrings, {
					maxSupportedTransactionVersion: 0,
					commitment: "confirmed"
				});
				const out: SpendRecord[] = [];
				const unattributedOut: UnattributedSpendRecord[] = [];
				for (let index = 0; index < txs.length; index++) {
					const tx = txs[index];
					const sigInfo = batch[index];
					if (!tx || !tx.meta) continue;
					if (!this.isWalletSigner(tx, walletAddress)) continue;
					if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) continue;

					if (this.invokesProgram(tx, svmExecutorProgramId)) continue;

					const bridge = this.detectBridge(tx);
					if (!bridge) {
						// Failed sig that touches none of our known programs (executor / CCTP /
						// OFT) = unattributed spend on the SVM wallet (approval, claim, etc).
						if (tx.meta.err !== null) {
							const fee = BigInt(tx.meta.fee ?? 0);
							if (fee > 0n) {
								unattributedOut.push({
									network: Network.SOLANA,
									txHash: sigInfo.signature,
									blockNumber: sigInfo.slot,
									timestampSeconds: sigInfo.blockTime,
									timestampIso: new Date(sigInfo.blockTime * 1000).toISOString(),
									payer: walletAddress,
									nativeAmount: fee.toString(),
									usdAmount: null,
									detail: "Solana tx reverted (no known program)"
								});
							}
						}
						continue;
					}

					const tokenSymbol = this.attributeBridgedToken(tx, walletAddress, mintLookup);
					if (!tokenSymbol) {
						log.warning(
							`[SOLANA] rebalance tx ${sigInfo.signature}: no token balance change for our wallet — dropping record`
						);
						continue;
					}

					const status = tx.meta.err === null ? SpendStatus.SUCCESS : SpendStatus.REVERTED;
					let nativeAmount: bigint;
					if (status === SpendStatus.SUCCESS) {
						const walletIndex = tx.transaction.message.accountKeys.findIndex(
							(key) => key.pubkey.toBase58() === walletAddress
						);
						if (walletIndex === -1) continue;
						const preLamports = BigInt(tx.meta.preBalances[walletIndex] ?? 0);
						const postLamports = BigInt(tx.meta.postBalances[walletIndex] ?? 0);
						nativeAmount = preLamports - postLamports;
						// CCTP burns fund the event_account PDA rent that we reclaim later;
						// subtract so daily spend isn't inflated. CCTP mints have a different
						// layout — helper returns 0n there.
						if (bridge === BridgeKind.CCTP) {
							nativeAmount -= this.findReclaimableEventAccountRent(tx);
						}
					} else {
						// Reverted tx: state rolled back, only base+priority fee is actually charged.
						nativeAmount = BigInt(tx.meta.fee ?? 0);
					}
					if (nativeAmount <= 0n) continue;

					const label = status === SpendStatus.SUCCESS ? `${bridge} rebalance` : `${bridge} rebalance reverted`;
					out.push({
						network: Network.SOLANA,
						intent: SpendIntent.REBALANCE,
						status,
						token: tokenSymbol,
						txHash: sigInfo.signature,
						blockNumber: sigInfo.slot,
						timestampSeconds: sigInfo.blockTime,
						timestampIso: new Date(sigInfo.blockTime * 1000).toISOString(),
						payer: walletAddress,
						nativeAmount: nativeAmount.toString(),
						usdAmount: null,
						breakdown: { gas: nativeAmount.toString() },
						bridge,
						detail: `${label} — ${tokenSymbol}`
					});
				}
				await sleep(rpcScanLimits.svmTransactionsBatchInterDelayMs);
				return { records: out, unattributedRecords: unattributedOut };
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[SOLANA] rebalance-spend batch failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[SOLANA] gave up on rebalance-spend batch of ${batch.length} signature(s)`);
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

	private invokesProgram(tx: ParsedTransactionWithMeta, programId: string): boolean {
		for (const instruction of tx.transaction.message.instructions) {
			if (instruction.programId.toBase58() === programId) return true;
		}
		for (const inner of tx.meta?.innerInstructions ?? []) {
			for (const instruction of inner.instructions) {
				if (instruction.programId.toBase58() === programId) return true;
			}
		}
		return false;
	}

	private detectBridge(tx: ParsedTransactionWithMeta): BridgeKind | null {
		if (this.invokesProgram(tx, cctpSvmTokenMessengerProgramId)) return BridgeKind.CCTP;
		if (this.invokesProgram(tx, svmOftProgramId)) return BridgeKind.OFT;
		return null;
	}

	private attributeBridgedToken(
		tx: ParsedTransactionWithMeta,
		walletAddress: string,
		mintLookup: Map<string, TokenSymbol>
	): TokenSymbol | null {
		const pre = tx.meta?.preTokenBalances ?? [];
		const post = tx.meta?.postTokenBalances ?? [];
		for (const postEntry of post) {
			if (postEntry.owner !== walletAddress) continue;
			const symbol = mintLookup.get(postEntry.mint);
			if (!symbol) continue;
			const preEntry = pre.find((entry) => entry.mint === postEntry.mint && entry.owner === postEntry.owner);
			const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
			const postAmount = BigInt(postEntry.uiTokenAmount.amount);
			if (postAmount !== preAmount) return symbol;
		}
		return null;
	}

	// CCTP burn (DepositForBurn) funds the MessageSent PDA at accounts[11] of the
	// TokenMessenger instruction. That rent is refunded when the reclaim service
	// closes the account ~5 days later, so it isn't a real spend. CCTP receive
	// has a different account layout (no freshly-created PDA at index 11), so
	// `preBalances[idx] !== 0n` filters those out and we return 0n.
	private findReclaimableEventAccountRent(tx: ParsedTransactionWithMeta): bigint {
		if (!tx.meta) return 0n;
		const allInstructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
			...tx.transaction.message.instructions,
			...(tx.meta.innerInstructions?.flatMap((inner) => inner.instructions) ?? [])
		];
		for (const instruction of allInstructions) {
			if (instruction.programId.toBase58() !== cctpSvmTokenMessengerProgramId) continue;
			if (!("accounts" in instruction) || instruction.accounts.length < 12) continue;
			const eventAccount = instruction.accounts[11];
			const accountIndex = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.equals(eventAccount));
			if (accountIndex === -1) continue;
			const preLamports = BigInt(tx.meta.preBalances[accountIndex] ?? 0);
			if (preLamports !== 0n) continue;
			return BigInt(tx.meta.postBalances[accountIndex] ?? 0);
		}
		return 0n;
	}
}

export { SvmRebalanceSpendFetcher };
