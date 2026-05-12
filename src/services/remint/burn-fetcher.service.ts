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
import { BurnTx, ChainType, Network, RemintWindow } from "../../types";
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
		let bucket = -1;

		for (let start = fromBlock; start <= toBlock; start += cctpRateLimits.evmChunkSize) {
			const end = Math.min(start + cctpRateLimits.evmChunkSize - 1, toBlock);
			let retries: number = cctpRateLimits.evmChunkRetries;
			while (retries > 0) {
				try {
					const logs = await tokenMessenger.queryFilter(filter, start, end);
					for (const entry of logs) {
						events.push({ transactionHash: entry.transactionHash, blockNumber: Number(entry.blockNumber) });
					}
					break;
				} catch (error) {
					retries--;
					const message = error instanceof Error ? error.message : String(error);
					log.warning(`[${network}] chunk ${start}-${end} failed (${retries} retries left): ${message}`);
					await sleep(cctpRateLimits.evmChunkRetryDelayMs);
				}
			}
			if (retries === 0) log.error(`[${network}] gave up on chunk ${start}-${end}`);
			bucket = reportProgress(`[${network}] phase 1`, end - fromBlock, totalBlocks, bucket);
		}

		return events;
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

		while (!stoppedByWindow) {
			try {
				const page: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(wallet, {
					limit: cctpRateLimits.svmSignaturesPerCall,
					before
				});
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
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("429")) {
					log.warning(`[SOLANA] rate limit (429), backing off ${cctpRateLimits.svmRateLimitBackoffMs}ms`);
					await sleep(cctpRateLimits.svmRateLimitBackoffMs);
					continue;
				}
				log.warning(`[SOLANA] signature page error, retrying: ${message}`);
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
		let bucket = -1;

		for (let offset = 0; offset < signatureStrings.length; offset += cctpRateLimits.svmTransactionsBatchSize) {
			const batch = signatureStrings.slice(offset, offset + cctpRateLimits.svmTransactionsBatchSize);
			let retries = cctpRateLimits.svmTransactionsBatchRetries;

			while (retries > 0) {
				try {
					const txs = await connection.getParsedTransactions(batch, {
						maxSupportedTransactionVersion: 0,
						commitment: "confirmed"
					});
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

						burns.push({
							transactionHash: tx.transaction.signatures[0],
							blockNumber: tx.slot,
							blockTime: tx.blockTime ?? undefined,
							eventAccount
						});
					}
					await sleep(cctpRateLimits.svmTransactionsBatchInterDelayMs);
					break;
				} catch (error) {
					retries--;
					const message = error instanceof Error ? error.message : String(error);
					if (retries > 0) {
						log.warning(`[SOLANA] batch failed, retrying (${retries} left): ${message}`);
						await sleep(cctpRateLimits.svmTransactionsBatchRetryDelayMs);
					} else {
						log.error(`[SOLANA] batch skipped after ${cctpRateLimits.svmTransactionsBatchRetries} retries: ${message}`);
					}
				}
			}

			bucket = reportProgress(`[SOLANA] phase 1`, Math.min(offset + batch.length, signatureStrings.length), signatureStrings.length, bucket);
		}

		return burns;
	}
}

export { BurnFetcherService };
