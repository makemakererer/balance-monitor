import { ethers } from "ethers";
import { VAULT_ABI } from "../../abis";
import {
	chainTypeByNetwork,
	enabledNetworks,
	evmChainMetadata,
	nativeSpendScanLimits,
	networkRpcUrls,
	rpcScanLimits,
	vaultExecutorAddresses
} from "../../config";
import {
	ChainType,
	EvmArbCollected,
	EvmArbCollectedNetwork,
	EvmBlockInfo,
	EvmReceiptInfo,
	Network,
	ProfitWindow,
	RawArbitrageEvent,
	ScanFailure,
	TokenSymbol,
	TypeRoute
} from "../../types";
import { errorMessage, log } from "../../utils";
import { BlockRange, EvmBlockRangeResolver } from "./evm-block-range.resolver";
import { fetchInBatchesWithRetry, retryUntilNull, scanBlockRangeInChunks } from "./evm-rpc-batch";

// Pure RPC collector — no domain shapes, no FailedTx, no attribution. Per
// (token, network): vault arb events + tx receipts + blocks. Calculators
// classify, attribute, and convert to domain records downstream.
class EvmArbTxCollector {
	constructor(private readonly blockRange: EvmBlockRangeResolver) {}

	public async collectByToken(token: TokenSymbol, window: ProfitWindow): Promise<EvmArbCollected> {
		const networks = Object.keys(vaultExecutorAddresses).filter((name) => {
			const network = name as Network;
			if (!enabledNetworks[network]) return false;
			if (chainTypeByNetwork[network] !== ChainType.EVM) return false;
			return Boolean(vaultExecutorAddresses[network]?.[token]);
		}) as Network[];

		if (networks.length === 0) {
			log.info(`[evm-arb-collector:${token}] no EVM networks configured for this token`);
			return { token, perNetwork: [], failures: [] };
		}

		const perNetwork: EvmArbCollectedNetwork[] = [];
		const failures: ScanFailure[] = [];
		for (const network of networks) {
			try {
				const result = await this.collectForNetwork(token, network, window);
				if (result.entry) perNetwork.push(result.entry);
				failures.push(...result.failures);
				if (result.entry) {
					if (result.failures.length > 0) {
						log.error(
							`[evm-arb-collector:${token}][${network}] scan INCOMPLETE: ${result.entry.events.length} event(s), ${result.entry.receipts.size} receipt(s) — chain data partial`
						);
					} else {
						log.success(
							`[evm-arb-collector:${token}][${network}] events: ${result.entry.events.length}, receipts: ${result.entry.receipts.size}, blocks: ${result.entry.blocks.size}`
						);
					}
				}
			} catch (error) {
				const message = errorMessage(error);
				log.error(`[evm-arb-collector:${token}][${network}] scan failed: ${message}`);
				failures.push({ network, detail: `scan threw: ${message}` });
			}
		}

		return { token, perNetwork, failures };
	}

	private async collectForNetwork(
		token: TokenSymbol,
		network: Network,
		window: ProfitWindow
	): Promise<{ entry: EvmArbCollectedNetwork | null; failures: ScanFailure[] }> {
		const vaultAddress = vaultExecutorAddresses[network]?.[token];
		if (!vaultAddress) return { entry: null, failures: [] };

		const blockRange = await this.blockRange.resolve(network, window);
		if (!blockRange) {
			log.warning(`[evm-arb-collector:${token}][${network}] window empty`);
			return { entry: null, failures: [] };
		}

		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[evm-arb-collector] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[evm-arb-collector] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });
		try {
			log.info(
				`[evm-arb-collector:${token}][${network}] scanning blocks ${blockRange.fromBlock} → ${blockRange.toBlock} (${(blockRange.toBlock - blockRange.fromBlock).toLocaleString()} blocks) vault=${vaultAddress}`
			);

			const failures: ScanFailure[] = [];
			const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

			const [inputScan, outputScan] = await Promise.all([
				this.scanEvents(network, vault, "InputArbitrageExecuted", TypeRoute.SELL, blockRange),
				this.scanEvents(network, vault, "OutputArbitrageExecuted", TypeRoute.BUY, blockRange)
			]);
			const events: RawArbitrageEvent[] = [...inputScan.events, ...outputScan.events];
			if (inputScan.failure) failures.push(inputScan.failure);
			if (outputScan.failure) failures.push(outputScan.failure);

			if (events.length === 0) {
				return {
					entry: { network, vaultAddress, events: [], receipts: new Map(), blocks: new Map() },
					failures
				};
			}

			const uniqueTxHashes = dedupBy(events, (e) => e.transactionHash);
			const uniqueBlockNumbers = dedupBy(events, (e) => e.blockNumber);

			const receiptResult = await this.fetchReceipts(provider, network, uniqueTxHashes);
			if (receiptResult.failure) failures.push(receiptResult.failure);

			const needFullBlocks = network === Network.ETH || network === Network.BSC;
			const blockResult = await this.fetchBlocks(provider, network, uniqueBlockNumbers, needFullBlocks);
			if (blockResult.failure) failures.push(blockResult.failure);

			return {
				entry: {
					network,
					vaultAddress,
					events,
					receipts: receiptResult.items,
					blocks: blockResult.items
				},
				failures
			};
		} finally {
			provider.destroy();
		}
	}

	private scanEvents(
		network: Network,
		vault: ethers.Contract,
		eventName: "InputArbitrageExecuted" | "OutputArbitrageExecuted",
		legType: TypeRoute,
		blockRange: BlockRange
	): Promise<{ events: RawArbitrageEvent[]; failure: ScanFailure | null }> {
		return scanBlockRangeInChunks<RawArbitrageEvent>({
			network,
			label: eventName,
			blockRange,
			chunkSize: rpcScanLimits.evmChunkSize,
			maxPasses: rpcScanLimits.evmChunkMaxPasses,
			fetchChunk: (start, end) =>
				retryUntilNull(
					async () => {
						const filter = vault.filters[eventName]();
						const logs = await vault.queryFilter(filter, start, end);
						return logs.map((entry) => {
							const args = (entry as ethers.EventLog).args;
							return {
								transactionHash: entry.transactionHash,
								blockNumber: Number(entry.blockNumber),
								type: legType,
								tokenInAddress: args[0] as string,
								tokenOutAddress: args[1] as string,
								amountIn: args[2] as bigint,
								amountOut: args[3] as bigint
							};
						});
					},
					{
						retries: rpcScanLimits.evmChunkRetries,
						retryDelayMs: rpcScanLimits.evmChunkRetryDelayMs,
						network,
						key: `${eventName} chunk ${start}-${end}`
					}
				)
		});
	}

	private fetchReceipts(
		provider: ethers.JsonRpcProvider,
		network: Network,
		txHashes: string[]
	): Promise<{ items: Map<string, EvmReceiptInfo>; failure: ScanFailure | null }> {
		return fetchInBatchesWithRetry<string, EvmReceiptInfo>({
			network,
			label: "receipt(s)",
			keys: txHashes,
			batchSize: nativeSpendScanLimits.receiptBatchSize,
			maxPasses: nativeSpendScanLimits.receiptMaxPasses,
			fetchOne: (txHash) =>
				retryUntilNull(
					async () => {
						const receipt = await provider.getTransactionReceipt(txHash);
						if (!receipt) return null;
						return {
							transactionHash: txHash,
							blockNumber: Number(receipt.blockNumber),
							gasUsed: receipt.gasUsed,
							effectiveGasPrice: receipt.gasPrice,
							from: ethers.getAddress(receipt.from)
						};
					},
					{
						retries: nativeSpendScanLimits.receiptRetries,
						retryDelayMs: nativeSpendScanLimits.receiptRetryDelayMs,
						network,
						key: `receipt ${txHash}`
					}
				)
		});
	}

	private fetchBlocks(
		provider: ethers.JsonRpcProvider,
		network: Network,
		blockNumbers: number[],
		withTxs: boolean
	): Promise<{ items: Map<number, EvmBlockInfo>; failure: ScanFailure | null }> {
		return fetchInBatchesWithRetry<number, EvmBlockInfo>({
			network,
			label: "block(s)",
			keys: blockNumbers,
			batchSize: nativeSpendScanLimits.receiptBatchSize,
			maxPasses: nativeSpendScanLimits.receiptMaxPasses,
			fetchOne: (blockNumber) =>
				retryUntilNull(
					async () => {
						const block = await provider.getBlock(blockNumber, withTxs);
						if (!block) return null;
						return {
							timestamp: Number(block.timestamp),
							txs: withTxs ? block.prefetchedTransactions : null
						};
					},
					{
						retries: nativeSpendScanLimits.receiptRetries,
						retryDelayMs: nativeSpendScanLimits.receiptRetryDelayMs,
						network,
						key: `getBlock(${blockNumber})`
					}
				)
		});
	}
}

function dedupBy<T, K>(items: T[], keyFn: (item: T) => K): K[] {
	const out: K[] = [];
	const seen = new Set<K>();
	for (const item of items) {
		const key = keyFn(item);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

export { EvmArbTxCollector };
