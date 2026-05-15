import { ethers } from "ethers";
import { Connection, ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction, PublicKey } from "@solana/web3.js";
import { TOKEN_MESSENGER_V2_ABI } from "../../abis";
import {
	cctpDomainIds,
	cctpEvmTokenMessengerAddress,
	cctpSvmTokenMessengerProgramId,
	enabledNetworks,
	evmChainMetadata,
	loadMonitoredSvmWallet,
	networkRpcUrls,
	rpcScanLimits,
	svmScanPrivateRpcUrl,
	svmScanPublicRpcUrl,
	vaultExecutorAddresses
} from "../../config";
import { BurnTx, Network, RemintWindow } from "../../types";
import { errorMessage, findEvmBlockAfterTimestamp, findEvmBlockAtOrBeforeTimestamp, log, reportProgress, sleep } from "../../utils";
import { collectSvmSignaturesInWindow, parseSvmTransactionsInBatches } from "../collectors/svm-rpc-batch";

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
				const message = errorMessage(error);
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
			log.info(`[${network}] scanning blocks ${fromBlock} → ${toBlock} (${(toBlock - fromBlock).toLocaleString()} blocks) over ${vaults.length} vault(s)`);

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
		for (let start = fromBlock; start <= toBlock; start += rpcScanLimits.evmChunkSize) {
			allChunks.push({ start, end: Math.min(start + rpcScanLimits.evmChunkSize - 1, toBlock) });
		}
		const totalChunks = allChunks.length;

		let pending = allChunks;
		for (let pass = 1; pass <= rpcScanLimits.evmChunkMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[${network}] phase 1 retry pass ${pass}/${rpcScanLimits.evmChunkMaxPasses}: re-fetching ${pending.length} chunk(s) that failed earlier`
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
				`[${network}] phase 1 permanently lost ${pending.length}/${totalChunks} chunk(s) = ${droppedBlocks.toLocaleString()} block(s) after ${rpcScanLimits.evmChunkMaxPasses} pass(es); burns inside that range will be missing from this run`
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
		let retries: number = rpcScanLimits.evmChunkRetries;
		while (retries > 0) {
			try {
				const logs = await tokenMessenger.queryFilter(filter, start, end);
				return logs.map((entry) => ({
					transactionHash: entry.transactionHash,
					blockNumber: Number(entry.blockNumber)
				}));
			} catch (error) {
				retries--;
				const message = errorMessage(error);
				log.warning(`[${network}] chunk ${start}-${end} failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[${network}] gave up on chunk ${start}-${end}`);
					return null;
				}
				await sleep(rpcScanLimits.evmChunkRetryDelayMs);
			}
		}
		return null;
	}

	private async fetchSvmBurns(window: RemintWindow): Promise<BurnTx[]> {
		const wallet = new PublicKey(loadMonitoredSvmWallet());
		const publicConnection = new Connection(svmScanPublicRpcUrl, {
			commitment: "confirmed",
			disableRetryOnRateLimit: true
		});
		const privateConnection = new Connection(svmScanPrivateRpcUrl, "confirmed");

		log.info(`[SOLANA] step 1: collecting signatures within window`);
		const signatures = await collectSvmSignaturesInWindow(publicConnection, wallet, window);
		log.success(`[SOLANA] signatures in window: ${signatures.length}`);
		if (signatures.length === 0) return [];

		log.info(`[SOLANA] step 2: fetching parsed transactions in batches of ${rpcScanLimits.svmTransactionsBatchSize}`);
		const result = await parseSvmTransactionsInBatches<BurnTx>({
			connection: privateConnection,
			signatures,
			progressLabel: "phase 1",
			mapper: (_sigInfo, tx) => this.svmTxToBurnTx(tx)
		});
		if (result.failure) {
			log.error(`[SOLANA] burn scan partial: ${result.failure.detail}; burns inside those sigs will be missing from this run`);
		}
		return result.items;
	}

	// Filter: must be a successful CCTP burn tx (DepositForBurn log + TokenMessenger
	// instruction with the event_account at slot 11). Returns null to skip otherwise.
	private svmTxToBurnTx(tx: ParsedTransactionWithMeta): BurnTx | null {
		if (!tx.meta || tx.meta.err) return null;
		const logs = tx.meta.logMessages?.join(" ") ?? "";
		if (!logs.includes("DepositForBurn")) return null;

		const allInstructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
			...tx.transaction.message.instructions,
			...(tx.meta.innerInstructions?.flatMap((inner) => inner.instructions) ?? [])
		];

		let eventAccount: string | undefined;
		for (const instruction of allInstructions) {
			if (instruction.programId.toBase58() !== cctpSvmTokenMessengerProgramId) continue;
			if ("accounts" in instruction && instruction.accounts.length >= 12) {
				eventAccount = instruction.accounts[11].toBase58();
				break;
			}
		}

		return {
			transactionHash: tx.transaction.signatures[0],
			blockNumber: tx.slot,
			blockTime: tx.blockTime ?? undefined,
			eventAccount
		};
	}
}

export { BurnFetcherService };
