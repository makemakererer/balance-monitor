import { ethers } from "ethers";
import { ConfirmedSignatureInfo, Connection, ParsedInstruction, PartiallyDecodedInstruction, PublicKey } from "@solana/web3.js";
import { TOKEN_MESSENGER_V2_ABI } from "../../abis";
import {
	cctpDomainIds,
	cctpEvmTokenMessengerAddress,
	cctpRateLimits,
	cctpSolanaPublicRpcUrl,
	cctpSolanaPrivateRpcUrl,
	cctpSvmTokenMessengerProgramId,
	enabledNetworks,
	evmChainMetadata,
	loadMonitoredSvmWallet,
	networkRpcUrls,
	vaultExecutorAddresses
} from "../../config";
import { BurnTx, Network, RemintWindow } from "../../types";
import { findEvmBlockAfterTimestamp, findEvmBlockAtOrBeforeTimestamp, log, reportProgress, sleep } from "../../utils";

class BurnFetcherService {
	public async fetchBurns(window: RemintWindow): Promise<Map<Network, BurnTx[]>> {
		const burnsByNetwork = new Map<Network, BurnTx[]>();
		const networks = Object.keys(cctpDomainIds).filter((network) => enabledNetworks[network as Network]) as Network[];

		log.important(`PHASE 1: fetch burns — ${networks.length} chain(s): ${networks.join(", ")}`);

		for (const network of networks) {
			try {
				log.important(`[${network}] starting burn fetch`);
				const burns = network === Network.SOLANA
					? await this.fetchSvmBurns(window)
					: await this.fetchEvmBurns(network, window);
				burnsByNetwork.set(network, burns);
				log.success(`[${network}] burns collected: ${burns.length}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`[${network}] burn fetch failed: ${message}`);
				burnsByNetwork.set(network, []);
			}
		}

		return burnsByNetwork;
	}

	private async fetchEvmBurns(network: Network, window: RemintWindow): Promise<BurnTx[]> {
		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[burn-fetcher] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[burn-fetcher] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });

		try {
			const tokenMessenger = new ethers.Contract(cctpEvmTokenMessengerAddress, TOKEN_MESSENGER_V2_ABI, provider);

			const vaults = Object.values(vaultExecutorAddresses[network] ?? {});
			if (vaults.length === 0) {
				log.warning(`[${network}] no vault executors configured, skipping`);
				return [];
			}

			const fromBlock = await findEvmBlockAfterTimestamp(provider, window.fromTimestampSeconds, network);
			const toBlock = await findEvmBlockAtOrBeforeTimestamp(provider, window.toTimestampSeconds, network);
			if (toBlock < fromBlock) {
				log.warning(`[${network}] window empty (fromBlock=${fromBlock} > toBlock=${toBlock})`);
				return [];
			}
			log.info(`[${network}] scanning blocks ${fromBlock}…${toBlock} (${(toBlock - fromBlock).toLocaleString()}) over ${vaults.length} vault(s)`);

			const allEvents: BurnTx[] = [];
			for (const vault of vaults) {
				const filter = tokenMessenger.filters.DepositForBurn(null, null, vault);
				const events = await this.scanEvmInChunks(network, tokenMessenger, filter, fromBlock, toBlock);
				allEvents.push(...events);
			}

			return Array.from(new Map(allEvents.map((tx) => [tx.transactionHash, tx])).values());
		} finally {
			provider.destroy();
		}
	}

	private async scanEvmInChunks(
		network: Network,
		tokenMessenger: ethers.Contract,
		filter: ethers.ContractEventName,
		fromBlock: number,
		toBlock: number
	): Promise<BurnTx[]> {
		const events: BurnTx[] = [];
		const totalBlocks = toBlock - fromBlock;

		const allChunks: Array<{ start: number; end: number }> = [];
		for (let start = fromBlock; start <= toBlock; start += cctpRateLimits.evmChunkSize) {
			allChunks.push({ start, end: Math.min(start + cctpRateLimits.evmChunkSize - 1, toBlock) });
		}
		const totalChunks = allChunks.length;

		let pending = allChunks;
		for (let pass = 1; pass <= cctpRateLimits.evmChunkMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[${network}] phase 1 retry pass ${pass}/${cctpRateLimits.evmChunkMaxPasses}: re-fetching ${pending.length} chunk(s) that failed earlier`
				);
			}

			const stillFailing: Array<{ start: number; end: number }> = [];
			let bucket = -1;
			for (const { start, end } of pending) {
				const chunkEvents = await this.tryFetchChunkEvents(network, tokenMessenger, filter, start, end);
				if (chunkEvents === null) {
					stillFailing.push({ start, end });
				} else {
					events.push(...chunkEvents);
				}
				if (pass === 1) {
					bucket = reportProgress(`[${network}] phase 1`, end - fromBlock, totalBlocks, bucket);
				}
			}

			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[${network}] phase 1 retry pass ${pass}: recovered ${recovered}/${pending.length} chunk(s)`);
			}
			pending = stillFailing;
		}

		if (pending.length > 0) {
			const droppedBlocks = pending.reduce((sum, { start, end }) => sum + (end - start + 1), 0);
			log.error(
				`[${network}] phase 1 permanently lost ${pending.length}/${totalChunks} chunk(s) = ${droppedBlocks.toLocaleString()} block(s) after ${cctpRateLimits.evmChunkMaxPasses} pass(es); burns inside that range will be missing from this run`
			);
		}

		return events;
	}

	// One attempt at a single block range, with the per-chunk retry loop inside.
	// Returns null if all retries are exhausted — the caller will park the range for
	// a later pass instead of swallowing the loss.
	private async tryFetchChunkEvents(
		network: Network,
		tokenMessenger: ethers.Contract,
		filter: ethers.ContractEventName,
		start: number,
		end: number
	): Promise<BurnTx[] | null> {
		let retries: number = cctpRateLimits.evmChunkRetries;
		while (retries > 0) {
			try {
				const logs = await tokenMessenger.queryFilter(filter, start, end);
				return logs.map((entry) => ({
					transactionHash: entry.transactionHash,
					blockNumber: Number(entry.blockNumber)
				}));
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[${network}] chunk ${start}-${end} failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[${network}] gave up on chunk ${start}-${end}`);
					return null;
				}
				await sleep(cctpRateLimits.evmChunkRetryDelayMs);
			}
		}
		return null;
	}

	private async fetchSvmBurns(window: RemintWindow): Promise<BurnTx[]> {
		const wallet = new PublicKey(loadMonitoredSvmWallet());
		const publicConnection = new Connection(cctpSolanaPublicRpcUrl, {
			commitment: "confirmed",
			disableRetryOnRateLimit: true
		});
		const privateConnection = new Connection(cctpSolanaPrivateRpcUrl, "confirmed");

		log.info(`[SOLANA] step 1: collecting signatures within window`);
		const signatures = await this.collectSvmSignaturesInWindow(publicConnection, wallet, window);
		log.success(`[SOLANA] signatures in window: ${signatures.length}`);

		if (signatures.length === 0) return [];

		log.info(`[SOLANA] step 2: fetching parsed transactions in batches of ${cctpRateLimits.svmTransactionsBatchSize}`);
		return this.parseSvmBurnsFromSignatures(privateConnection, signatures);
	}

	private async collectSvmSignaturesInWindow(
		connection: Connection,
		wallet: PublicKey,
		window: RemintWindow
	): Promise<ConfirmedSignatureInfo[]> {
		const collected: ConfirmedSignatureInfo[] = [];
		let before: string | undefined = undefined;
		let stoppedByWindow = false;
		let consecutiveErrors = 0;

		while (!stoppedByWindow) {
			try {
				const page: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(wallet, {
					limit: cctpRateLimits.svmSignaturesPerCall,
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
				await sleep(cctpRateLimits.svmSignatureCallDelayMs);
			} catch (error) {
				consecutiveErrors++;
				const message = error instanceof Error ? error.message : String(error);
				if (consecutiveErrors >= cctpRateLimits.svmSignatureMaxConsecutiveErrors) {
					throw new Error(
						`[SOLANA] signature scan aborted after ${consecutiveErrors} consecutive errors: ${message}`
					);
				}
				if (message.includes("429")) {
					log.warning(
						`[SOLANA] rate limit (429) ${consecutiveErrors}/${cctpRateLimits.svmSignatureMaxConsecutiveErrors}, backing off ${cctpRateLimits.svmRateLimitBackoffMs}ms`
					);
					await sleep(cctpRateLimits.svmRateLimitBackoffMs);
					continue;
				}
				log.warning(
					`[SOLANA] signature page error ${consecutiveErrors}/${cctpRateLimits.svmSignatureMaxConsecutiveErrors}, retrying: ${message}`
				);
				await sleep(cctpRateLimits.svmGenericErrorBackoffMs);
			}
		}

		return collected;
	}

	private async parseSvmBurnsFromSignatures(
		connection: Connection,
		signatures: ConfirmedSignatureInfo[]
	): Promise<BurnTx[]> {
		const burns: BurnTx[] = [];
		const signatureStrings = signatures.map((s) => s.signature);

		const allBatches: string[][] = [];
		for (let offset = 0; offset < signatureStrings.length; offset += cctpRateLimits.svmTransactionsBatchSize) {
			allBatches.push(signatureStrings.slice(offset, offset + cctpRateLimits.svmTransactionsBatchSize));
		}
		const totalBatches = allBatches.length;

		let pending = allBatches;
		for (let pass = 1; pass <= cctpRateLimits.svmTransactionsBatchMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[SOLANA] phase 1 retry pass ${pass}/${cctpRateLimits.svmTransactionsBatchMaxPasses}: re-fetching ${pending.length} batch(es) that failed earlier`
				);
			}

			const stillFailing: string[][] = [];
			let bucket = -1;
			let processed = 0;
			for (const batch of pending) {
				const batchBurns = await this.tryFetchBatchBurns(connection, batch);
				if (batchBurns === null) {
					stillFailing.push(batch);
				} else {
					burns.push(...batchBurns);
				}
				processed += batch.length;
				if (pass === 1) {
					bucket = reportProgress(`[SOLANA] phase 1`, processed, signatureStrings.length, bucket);
				}
			}

			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[SOLANA] phase 1 retry pass ${pass}: recovered ${recovered}/${pending.length} batch(es)`);
			}
			pending = stillFailing;
		}

		if (pending.length > 0) {
			const droppedSigs = pending.reduce((sum, batch) => sum + batch.length, 0);
			log.error(
				`[SOLANA] phase 1 permanently lost ${pending.length}/${totalBatches} batch(es) = ${droppedSigs} signature(s) after ${cctpRateLimits.svmTransactionsBatchMaxPasses} pass(es); burns inside those sigs will be missing from this run`
			);
		}

		return burns;
	}

	// One attempt at a single signature batch, retried internally up to
	// svmTransactionsBatchRetries times. Returns null if all retries are exhausted —
	// the caller will park the batch for the retry pass instead of dropping it.
	private async tryFetchBatchBurns(connection: Connection, batch: string[]): Promise<BurnTx[] | null> {
		let retries = cctpRateLimits.svmTransactionsBatchRetries;
		while (retries > 0) {
			try {
				const txs = await connection.getParsedTransactions(batch, {
					maxSupportedTransactionVersion: 0,
					commitment: "confirmed"
				});
				const batchBurns: BurnTx[] = [];
				for (const tx of txs) {
					if (!tx || !tx.meta || tx.meta.err) continue;
					const logs = tx.meta.logMessages?.join(" ") ?? "";
					if (!logs.includes("DepositForBurn")) continue;

					const allInstructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
						...tx.transaction.message.instructions,
						...(tx.meta.innerInstructions?.flatMap((ix) => ix.instructions) ?? [])
					];

					let eventAccount: string | undefined;
					for (const instruction of allInstructions) {
						if (instruction.programId.toBase58() !== cctpSvmTokenMessengerProgramId) continue;
						if ("accounts" in instruction && instruction.accounts.length >= 12) {
							eventAccount = instruction.accounts[11].toBase58();
							break;
						}
					}

					batchBurns.push({
						transactionHash: tx.transaction.signatures[0],
						blockNumber: tx.slot,
						blockTime: tx.blockTime ?? undefined,
						eventAccount
					});
				}
				await sleep(cctpRateLimits.svmTransactionsBatchInterDelayMs);
				return batchBurns;
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[SOLANA] batch failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[SOLANA] gave up on batch of ${batch.length} signature(s)`);
					return null;
				}
				await sleep(cctpRateLimits.svmTransactionsBatchRetryDelayMs);
			}
		}
		return null;
	}
}

export { BurnFetcherService };
