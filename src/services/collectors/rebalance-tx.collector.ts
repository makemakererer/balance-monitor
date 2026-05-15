import { ethers } from "ethers";
import {
	chainTypeByNetwork,
	enabledNetworks,
	evmChainMetadata,
	nativeSpendScanLimits,
	networkRpcUrls,
	rebalanceBridgesByNetwork,
	rpcScanLimits,
	tokensToChain,
	vaultExecutorAddresses
} from "../../config";
import {
	ChainType,
	EvmBlockInfo,
	EvmRebalanceCollectedNetwork,
	EvmRebalanceReceiptInfo,
	Network,
	NativeSpendWindow,
	RebalanceCollected,
	ScanFailure
} from "../../types";
import { errorMessage, log } from "../../utils";
import { BlockRange, EvmBlockRangeResolver } from "./evm-block-range.resolver";
import { fetchInBatchesWithRetry, retryUntilNull, scanBlockRangeInChunks } from "./evm-rpc-batch";

const TRANSFER_TOPIC0: string = ethers.id("Transfer(address,address,uint256)");

// Pure I/O collector for EVM rebalance txs. Scans Transfer(from=vault) on each
// enabled chain → unique tx hashes → receipts (with logs) → blocks (with txs).
// Calculators decode selector → bridge kind, attribute token from logs, build
// SpendRecord / UnattributedSpendRecord. SVM rebalance comes from SvmTxCollector.
class RebalanceTxCollector {
	constructor(private readonly blockRange: EvmBlockRangeResolver) {}

	public async collect(window: NativeSpendWindow): Promise<RebalanceCollected> {
		const networks = Object.keys(rebalanceBridgesByNetwork).filter((name) => {
			const network = name as Network;
			if (!enabledNetworks[network]) return false;
			if (chainTypeByNetwork[network] !== ChainType.EVM) return false;
			const vaults = vaultExecutorAddresses[network];
			return Boolean(vaults && Object.keys(vaults).length > 0);
		}) as Network[];

		if (networks.length === 0) {
			log.info(`[rebalance-collector] no EVM networks with vaults configured`);
			return { evm: [], failures: [] };
		}

		const evm: EvmRebalanceCollectedNetwork[] = [];
		const failures: ScanFailure[] = [];
		for (const network of networks) {
			try {
				const result = await this.collectForNetwork(network, window);
				if (result.entry) evm.push(result.entry);
				failures.push(...result.failures);
				if (result.entry) {
					if (result.failures.length > 0) {
						log.error(
							`[rebalance-collector][${network}] scan INCOMPLETE: ${result.entry.txHashes.length} tx(s), ${result.entry.receipts.size} receipt(s) — chain data partial`
						);
					} else {
						log.success(
							`[rebalance-collector][${network}] txs: ${result.entry.txHashes.length}, receipts: ${result.entry.receipts.size}, blocks: ${result.entry.blocks.size}`
						);
					}
				}
			} catch (error) {
				const message = errorMessage(error);
				log.error(`[rebalance-collector][${network}] scan failed: ${message}`);
				failures.push({ network, detail: `scan threw: ${message}` });
			}
		}
		return { evm, failures };
	}

	private async collectForNetwork(
		network: Network,
		window: NativeSpendWindow
	): Promise<{ entry: EvmRebalanceCollectedNetwork | null; failures: ScanFailure[] }> {
		const vaultMap = vaultExecutorAddresses[network] ?? {};
		const vaultAddresses = Object.values(vaultMap)
			.filter((address): address is string => Boolean(address))
			.map((address) => ethers.getAddress(address));
		if (vaultAddresses.length === 0) return { entry: null, failures: [] };

		const blockRange = await this.blockRange.resolve(network, window);
		if (!blockRange) {
			log.warning(`[rebalance-collector][${network}] window empty`);
			return { entry: null, failures: [] };
		}

		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[rebalance-collector] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[rebalance-collector] missing evmChainMetadata[${network}]`);

		// Address-scoped getLogs: known ERC-20 contracts on this chain. BlockPi caps
		// unfiltered topic-only eth_getLogs at 1024 blocks on Ethereum mainnet but
		// allows wider ranges when `address` is set.
		const tokenAddresses = Object.values(tokensToChain[network] ?? {})
			.filter((address): address is string => typeof address === "string" && address.startsWith("0x"))
			.map((address) => ethers.getAddress(address));

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });
		try {
			log.info(
				`[rebalance-collector][${network}] scanning blocks ${blockRange.fromBlock} → ${blockRange.toBlock} (${(blockRange.toBlock - blockRange.fromBlock).toLocaleString()} blocks) vaults=${vaultAddresses.length}`
			);

			const failures: ScanFailure[] = [];
			const uniqueTxHashes = new Set<string>();

			for (const vaultAddress of vaultAddresses) {
				const scan = await this.scanTransfersFromVault(provider, network, vaultAddress, tokenAddresses, blockRange);
				for (const hash of scan.txHashes) uniqueTxHashes.add(hash);
				if (scan.failure) failures.push(scan.failure);
			}

			if (uniqueTxHashes.size === 0) {
				return {
					entry: {
						network,
						vaultAddresses,
						txHashes: [],
						receipts: new Map(),
						blocks: new Map()
					},
					failures
				};
			}

			const txHashes = [...uniqueTxHashes];
			const receiptResult = await this.fetchReceiptsWithLogs(provider, network, txHashes);
			if (receiptResult.failure) failures.push(receiptResult.failure);

			const uniqueBlocks = [...new Set(Array.from(receiptResult.items.values()).map((r) => r.blockNumber))];
			const blockResult = await this.fetchBlocks(provider, network, uniqueBlocks);
			if (blockResult.failure) failures.push(blockResult.failure);

			return {
				entry: {
					network,
					vaultAddresses,
					txHashes,
					receipts: receiptResult.items,
					blocks: blockResult.items
				},
				failures
			};
		} finally {
			provider.destroy();
		}
	}

	private async scanTransfersFromVault(
		provider: ethers.JsonRpcProvider,
		network: Network,
		vaultAddress: string,
		tokenAddresses: string[],
		blockRange: BlockRange
	): Promise<{ txHashes: string[]; failure: ScanFailure | null }> {
		const paddedVault = ethers.zeroPadValue(vaultAddress, 32);
		const result = await scanBlockRangeInChunks<string>({
			network,
			label: `Transfer(from=${vaultAddress})`,
			blockRange,
			chunkSize: rpcScanLimits.evmChunkSize,
			maxPasses: rpcScanLimits.evmChunkMaxPasses,
			fetchChunk: (start, end) =>
				retryUntilNull(
					async () => {
						const logs = await provider.getLogs({
							fromBlock: start,
							toBlock: end,
							address: tokenAddresses,
							topics: [TRANSFER_TOPIC0, paddedVault]
						});
						return logs.map((entry) => entry.transactionHash);
					},
					{
						retries: rpcScanLimits.evmChunkRetries,
						retryDelayMs: rpcScanLimits.evmChunkRetryDelayMs,
						network,
						key: `Transfer(from=${vaultAddress}) chunk ${start}-${end}`
					}
				)
		});
		return { txHashes: result.events, failure: result.failure };
	}

	private fetchReceiptsWithLogs(
		provider: ethers.JsonRpcProvider,
		network: Network,
		txHashes: string[]
	): Promise<{ items: Map<string, EvmRebalanceReceiptInfo>; failure: ScanFailure | null }> {
		return fetchInBatchesWithRetry<string, EvmRebalanceReceiptInfo>({
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
							from: ethers.getAddress(receipt.from),
							logs: receipt.logs
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
		blockNumbers: number[]
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
						// Rebalance always needs full tx objects: selector for bridge type + tx.value for bribe.
						const block = await provider.getBlock(blockNumber, true);
						if (!block) return null;
						return {
							timestamp: Number(block.timestamp),
							txs: block.prefetchedTransactions
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

export { RebalanceTxCollector };
