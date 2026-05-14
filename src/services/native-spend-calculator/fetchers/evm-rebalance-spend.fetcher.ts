import { ethers } from "ethers";
import {
	chainTypeByNetwork,
	enabledNetworks,
	evmChainMetadata,
	loadMonitoredEvmWallets,
	nativeSpendScanLimits,
	networkRpcUrls,
	rebalanceBridgesByNetwork,
	rpcScanLimits,
	tokenConfig,
	tokensToChain,
	vaultExecutorAddresses
} from "../../../config";
import {
	BridgeKind,
	ChainType,
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
import {
	findEvmBlockAfterTimestamp,
	findEvmBlockAtOrBeforeTimestamp,
	log,
	sleep
} from "../../../utils";
import { FailedTxScanner, UnsupportedFailedTxChainError } from "../failed-tx-scanner";

interface TransferHit {
	transactionHash: string;
	blockNumber: number;
}

interface ReceiptInfo {
	transactionHash: string;
	blockNumber: number;
	gasUsed: bigint;
	effectiveGasPrice: bigint;
	from: string;
	logs: ReadonlyArray<ethers.Log>;
}

interface BlockInfo {
	timestamp: number;
	txs: ethers.TransactionResponse[];
}

const TRANSFER_TOPIC0: string = ethers.id("Transfer(address,address,uint256)");

// Vault function signatures verified against v3Pools-Arb typechain (Vault.ts:1086-1117).
// Selectors derived at runtime so we never hardcode a 4-byte hex.
const VAULT_REBALANCE_FRAGMENTS: ReadonlyArray<string> = [
	"function rebalanceCCTPV2(uint256,address,uint256,(uint32,bytes32,bytes32,uint256,uint32))",
	"function rebalanceLZV2(uint256,address,uint256,(address,(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address))",
	"function rebalanceBungee(uint256,address,uint256,(address,address,bytes))"
];

const FUNCTION_TO_BRIDGE: Record<string, BridgeKind> = {
	rebalanceCCTPV2: BridgeKind.CCTP,
	rebalanceLZV2: BridgeKind.OFT,
	rebalanceBungee: BridgeKind.BUNGEE
};

class EvmRebalanceSpendFetcher {
	// selectorHex (lowercased) → bridge kind. Selector is the first 4 bytes of calldata.
	private readonly bridgeBySelector: Map<string, BridgeKind>;
	private readonly rebalancerWallet: string = loadMonitoredEvmWallets().rebalancer;

	constructor(private readonly failedTx: FailedTxScanner) {
		const iface = new ethers.Interface(VAULT_REBALANCE_FRAGMENTS);
		const map = new Map<string, BridgeKind>();
		for (const [name, bridge] of Object.entries(FUNCTION_TO_BRIDGE)) {
			const fragment = iface.getFunction(name);
			if (!fragment) throw new Error(`[evm-rebalance] vault fragment "${name}" not resolvable`);
			map.set(fragment.selector.toLowerCase(), bridge);
		}
		this.bridgeBySelector = map;
	}

	public async fetch(window: NativeSpendWindow): Promise<FetcherSpendResult> {
		const networks = Object.keys(rebalanceBridgesByNetwork).filter((name) => {
			const network = name as Network;
			if (!enabledNetworks[network]) return false;
			if (chainTypeByNetwork[network] !== ChainType.EVM) return false;
			const vaults = vaultExecutorAddresses[network];
			return Boolean(vaults && Object.keys(vaults).length > 0);
		}) as Network[];

		if (networks.length === 0) {
			log.info(`[native-spend:rebalance] no EVM networks with vaults configured`);
			return { records: [], unattributedRecords: [], failures: [] };
		}

		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];
		const failures: NativeSpendScanFailure[] = [];

		for (const network of networks) {
			try {
				const networkResult = await this.fetchForNetwork(network, window);
				records.push(...networkResult.records);
				unattributedRecords.push(...networkResult.unattributedRecords);
				failures.push(...networkResult.failures);
				if (networkResult.failures.length > 0) {
					log.error(
						`[native-spend:rebalance][${network}] EVM scan INCOMPLETE: ${networkResult.records.length} record(s) collected, but chain data is partial`
					);
				} else {
					log.success(`[native-spend:rebalance][${network}] records: ${networkResult.records.length}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`[native-spend:rebalance][${network}] scan failed: ${message}`);
				failures.push({ network, intent: SpendIntent.REBALANCE, detail: `scan threw: ${message}` });
			}
		}

		return { records, unattributedRecords, failures };
	}

	private async fetchForNetwork(network: Network, window: NativeSpendWindow): Promise<FetcherSpendResult> {
		const vaultMap = vaultExecutorAddresses[network] ?? {};
		const vaultAddresses = Object.values(vaultMap)
			.filter((address): address is string => Boolean(address))
			.map((address) => ethers.getAddress(address));
		if (vaultAddresses.length === 0) return { records: [], unattributedRecords: [], failures: [] };

		// Known ERC-20 contracts on this chain. Used as the `address` filter on getLogs so the
		// query is address-scoped — BlockPi caps unfiltered topic-only eth_getLogs at 1024
		// blocks on Ethereum mainnet but allows wider ranges when `address` is set.
		const tokenAddresses = Object.values(tokensToChain[network] ?? {})
			.filter((address): address is string => typeof address === "string" && address.startsWith("0x"))
			.map((address) => ethers.getAddress(address));

		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[evm-rebalance] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[evm-rebalance] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });

		try {
			const fromBlock = await findEvmBlockAfterTimestamp(provider, window.fromTimestampSeconds, network);
			const toBlock = await findEvmBlockAtOrBeforeTimestamp(provider, window.toTimestampSeconds, network);
			if (toBlock < fromBlock) {
				log.warning(`[native-spend:rebalance][${network}] window empty (fromBlock=${fromBlock} > toBlock=${toBlock})`);
				return { records: [], unattributedRecords: [], failures: [] };
			}
			log.info(
				`[native-spend:rebalance][${network}] scanning blocks ${fromBlock} → ${toBlock} (${(toBlock - fromBlock).toLocaleString()} blocks) vaults=${vaultAddresses.length}`
			);

			const vaultSet = new Set(vaultAddresses);
			const failedScan = await this.fetchRevertedRecords(network, vaultSet, fromBlock, toBlock);
			const failures: NativeSpendScanFailure[] = [...failedScan.failures];
			const unattributedRecords = failedScan.unattributedRecords;
			const uniqueTxHashes = new Set<string>();

			for (const vaultAddress of vaultAddresses) {
				const scan = await this.scanTransfersFromVault(
					provider,
					network,
					vaultAddress,
					tokenAddresses,
					fromBlock,
					toBlock
				);
				for (const hit of scan.events) uniqueTxHashes.add(hit.transactionHash);
				if (scan.failure) failures.push(scan.failure);
			}

			if (uniqueTxHashes.size === 0) {
				return { records: failedScan.records, unattributedRecords, failures };
			}

			const txHashes = [...uniqueTxHashes];
			const { receipts, droppedReceiptCount } = await this.fetchReceipts(provider, network, txHashes);
			if (droppedReceiptCount > 0) {
				failures.push({
					network,
					intent: SpendIntent.REBALANCE,
					detail: `lost ${droppedReceiptCount} receipt(s) after ${nativeSpendScanLimits.receiptMaxPasses} pass(es)`
				});
			}

			const uniqueBlocks: number[] = [];
			const seenBlock = new Set<number>();
			for (const receipt of receipts.values()) {
				if (seenBlock.has(receipt.blockNumber)) continue;
				seenBlock.add(receipt.blockNumber);
				uniqueBlocks.push(receipt.blockNumber);
			}

			const { blocks, droppedBlockCount } = await this.fetchBlocks(provider, network, uniqueBlocks);
			if (droppedBlockCount > 0) {
				failures.push({
					network,
					intent: SpendIntent.REBALANCE,
					detail: `lost ${droppedBlockCount} block(s) after ${nativeSpendScanLimits.receiptMaxPasses} pass(es)`
				});
			}

			const successRecords = this.buildRecords({ network, receipts, blocks, vaultSet, window });
			return {
				records: [...successRecords, ...failedScan.records],
				unattributedRecords,
				failures
			};
		} finally {
			provider.destroy();
		}
	}

	private async fetchRevertedRecords(
		network: Network,
		vaultSet: Set<string>,
		fromBlock: number,
		toBlock: number
	): Promise<{
		records: SpendRecord[];
		unattributedRecords: UnattributedSpendRecord[];
		failures: NativeSpendScanFailure[];
	}> {
		const source = evmChainMetadata[network]?.failedTxSource;
		if (source) {
			log.info(`[native-spend:rebalance][${network}] failed-tx scan via ${source} starting (wallet=${this.rebalancerWallet})`);
		}
		let txs;
		try {
			txs = await this.failedTx.getWalletTxs(network, this.rebalancerWallet, fromBlock, toBlock);
		} catch (error) {
			if (error instanceof UnsupportedFailedTxChainError) {
				return {
					records: [],
					unattributedRecords: [],
					failures: [
						{
							network,
							intent: SpendIntent.REBALANCE,
							detail: `failed-tx scanning unsupported on ${network}`
						}
					]
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			return {
				records: [],
				unattributedRecords: [],
				failures: [
					{ network, intent: SpendIntent.REBALANCE, detail: `failed-tx scan threw: ${message}` }
				]
			};
		}

		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];
		const vaultToToken = this.buildVaultToTokenMap(network);
		for (const tx of txs) {
			if (!tx.isError) continue;
			const toAddress = tx.to ? ethers.getAddress(tx.to) : null;
			const selector = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null;
			const bridge = selector ? this.bridgeBySelector.get(selector) : undefined;
			const token = toAddress ? vaultToToken.get(toAddress) : undefined;
			const gas = tx.gasUsed * tx.gasPrice;
			if (toAddress && bridge && token && vaultSet.has(toAddress)) {
				records.push({
					network,
					intent: SpendIntent.REBALANCE,
					status: SpendStatus.REVERTED,
					token,
					txHash: tx.hash,
					blockNumber: tx.blockNumber,
					timestampSeconds: tx.timeStamp,
					timestampIso: new Date(tx.timeStamp * 1000).toISOString(),
					payer: ethers.getAddress(tx.from),
					nativeAmount: gas.toString(),
					usdAmount: null,
					breakdown: { gas: gas.toString() },
					bridge,
					detail: `${bridge} rebalance reverted — ${token}`
				});
			} else {
				unattributedRecords.push({
					network,
					txHash: tx.hash,
					blockNumber: tx.blockNumber,
					timestampSeconds: tx.timeStamp,
					timestampIso: new Date(tx.timeStamp * 1000).toISOString(),
					payer: ethers.getAddress(tx.from),
					nativeAmount: gas.toString(),
					usdAmount: null,
					detail: `reverted tx to ${tx.to || "<contract creation>"}`
				});
			}
		}
		return { records, unattributedRecords, failures: [] };
	}

	private buildVaultToTokenMap(network: Network): Map<string, TokenSymbol> {
		const map = new Map<string, TokenSymbol>();
		const vaults = vaultExecutorAddresses[network] ?? {};
		for (const [tokenKey, address] of Object.entries(vaults)) {
			if (!address) continue;
			map.set(ethers.getAddress(address), tokenKey as TokenSymbol);
		}
		return map;
	}

	private buildRecords(args: {
		network: Network;
		receipts: Map<string, ReceiptInfo>;
		blocks: Map<number, BlockInfo>;
		vaultSet: Set<string>;
		window: NativeSpendWindow;
	}): SpendRecord[] {
		const { network, receipts, blocks, vaultSet, window } = args;
		const records: SpendRecord[] = [];

		for (const receipt of receipts.values()) {
			const block = blocks.get(receipt.blockNumber);
			if (!block) continue;
			if (block.timestamp < window.fromTimestampSeconds || block.timestamp > window.toTimestampSeconds) continue;

			const tx = block.txs.find((entry) => entry.hash === receipt.transactionHash);
			if (!tx || !tx.data || tx.data.length < 10) continue;

			const selector = tx.data.slice(0, 10).toLowerCase();
			const bridge = this.bridgeBySelector.get(selector);
			if (!bridge) continue;

			const tokenSymbol = this.attributeToken(receipt.logs, vaultSet);
			if (!tokenSymbol) {
				log.warning(
					`[${network}] rebalance tx ${receipt.transactionHash}: no Transfer-from-vault log matched tokenConfig; dropping record`
				);
				continue;
			}

			const gas = receipt.gasUsed * receipt.effectiveGasPrice;
			const bribe = tx.value > 0n ? tx.value : 0n;
			records.push({
				network,
				intent: SpendIntent.REBALANCE,
				status: SpendStatus.SUCCESS,
				token: tokenSymbol,
				txHash: receipt.transactionHash,
				blockNumber: receipt.blockNumber,
				timestampSeconds: block.timestamp,
				timestampIso: new Date(block.timestamp * 1000).toISOString(),
				payer: receipt.from,
				nativeAmount: (gas + bribe).toString(),
				usdAmount: null,
				breakdown: {
					gas: gas.toString(),
					...(bribe > 0n ? { bribe: bribe.toString() } : {})
				},
				bridge,
				detail: `${bridge} rebalance — ${tokenSymbol}`
			});
		}

		return records;
	}

	private attributeToken(logs: ReadonlyArray<ethers.Log>, vaultSet: Set<string>): TokenSymbol | null {
		for (const entry of logs) {
			if (entry.topics.length < 3) continue;
			if (entry.topics[0].toLowerCase() !== TRANSFER_TOPIC0) continue;
			const fromTopic = entry.topics[1];
			const fromAddress = ethers.getAddress("0x" + fromTopic.slice(26));
			if (!vaultSet.has(fromAddress)) continue;
			const tokenAddress = ethers.getAddress(entry.address);
			const meta = tokenConfig[tokenAddress];
			if (meta) return meta.symbol;
		}
		return null;
	}

	private async scanTransfersFromVault(
		provider: ethers.JsonRpcProvider,
		network: Network,
		vaultAddress: string,
		tokenAddresses: string[],
		fromBlock: number,
		toBlock: number
	): Promise<{ events: TransferHit[]; failure: NativeSpendScanFailure | null }> {
		const events: TransferHit[] = [];

		const allChunks: Array<{ start: number; end: number }> = [];
		for (let start = fromBlock; start <= toBlock; start += rpcScanLimits.evmChunkSize) {
			allChunks.push({ start, end: Math.min(start + rpcScanLimits.evmChunkSize - 1, toBlock) });
		}
		const totalChunks = allChunks.length;
		const paddedVault = ethers.zeroPadValue(vaultAddress, 32);

		let pending = allChunks;
		for (let pass = 1; pass <= rpcScanLimits.evmChunkMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[${network}] Transfer(from=${vaultAddress}) retry pass ${pass}/${rpcScanLimits.evmChunkMaxPasses}: re-fetching ${pending.length} chunk(s)`
				);
			}
			const stillFailing: Array<{ start: number; end: number }> = [];
			for (const { start, end } of pending) {
				const chunkEvents = await this.tryFetchTransferChunk(
					provider,
					network,
					tokenAddresses,
					paddedVault,
					start,
					end
				);
				if (chunkEvents === null) stillFailing.push({ start, end });
				else events.push(...chunkEvents);
			}
			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[${network}] Transfer(from=${vaultAddress}) retry pass ${pass}: recovered ${recovered}/${pending.length}`);
			}
			pending = stillFailing;
		}

		if (pending.length === 0) return { events, failure: null };

		const droppedBlocks = pending.reduce((sum, { start, end }) => sum + (end - start + 1), 0);
		const detail = `Transfer(from=${vaultAddress}) lost ${pending.length}/${totalChunks} chunk(s) = ${droppedBlocks.toLocaleString()} block(s) after ${rpcScanLimits.evmChunkMaxPasses} pass(es)`;
		log.error(`[${network}] ${detail}; rebalance txs inside that range will be missing from this run`);
		return { events, failure: { network, intent: SpendIntent.REBALANCE, detail } };
	}

	private async tryFetchTransferChunk(
		provider: ethers.JsonRpcProvider,
		network: Network,
		tokenAddresses: string[],
		paddedVault: string,
		start: number,
		end: number
	): Promise<TransferHit[] | null> {
		let retries = rpcScanLimits.evmChunkRetries;
		while (retries > 0) {
			try {
				const logs = await provider.getLogs({
					fromBlock: start,
					toBlock: end,
					address: tokenAddresses,
					topics: [TRANSFER_TOPIC0, paddedVault]
				});
				return logs.map((entry) => ({
					transactionHash: entry.transactionHash,
					blockNumber: Number(entry.blockNumber)
				}));
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(
					`[${network}] Transfer(from=vault) chunk ${start}-${end} failed (${retries} retries left): ${message}`
				);
				if (retries === 0) {
					log.error(`[${network}] gave up on Transfer chunk ${start}-${end}`);
					return null;
				}
				await sleep(rpcScanLimits.evmChunkRetryDelayMs);
			}
		}
		return null;
	}

	private async fetchReceipts(
		provider: ethers.JsonRpcProvider,
		network: Network,
		txHashes: string[]
	): Promise<{ receipts: Map<string, ReceiptInfo>; droppedReceiptCount: number }> {
		const receipts = new Map<string, ReceiptInfo>();
		const totalCount = txHashes.length;

		let pending = txHashes;
		for (let pass = 1; pass <= nativeSpendScanLimits.receiptMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[${network}] receipt retry pass ${pass}/${nativeSpendScanLimits.receiptMaxPasses}: re-fetching ${pending.length} receipt(s)`
				);
			}
			const stillFailing: string[] = [];
			for (let offset = 0; offset < pending.length; offset += nativeSpendScanLimits.receiptBatchSize) {
				const batch = pending.slice(offset, offset + nativeSpendScanLimits.receiptBatchSize);
				const batchResults = await Promise.all(batch.map((hash) => this.tryFetchReceipt(provider, network, hash)));
				for (let i = 0; i < batch.length; i++) {
					const result = batchResults[i];
					if (result === null) stillFailing.push(batch[i]);
					else receipts.set(batch[i], result);
				}
			}
			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[${network}] receipt retry pass ${pass}: recovered ${recovered}/${pending.length}`);
			}
			pending = stillFailing;
		}

		const droppedReceiptCount = pending.length;
		if (droppedReceiptCount > 0) {
			log.error(
				`[${network}] permanently lost ${droppedReceiptCount}/${totalCount} receipt(s) after ${nativeSpendScanLimits.receiptMaxPasses} pass(es)`
			);
		}
		return { receipts, droppedReceiptCount };
	}

	private async tryFetchReceipt(
		provider: ethers.JsonRpcProvider,
		network: Network,
		txHash: string
	): Promise<ReceiptInfo | null> {
		let retries = nativeSpendScanLimits.receiptRetries;
		while (retries > 0) {
			try {
				const receipt = await provider.getTransactionReceipt(txHash);
				if (!receipt) {
					retries--;
					if (retries === 0) {
						log.error(`[${network}] receipt ${txHash} returned null after all retries`);
						return null;
					}
					await sleep(nativeSpendScanLimits.receiptRetryDelayMs);
					continue;
				}
				return {
					transactionHash: txHash,
					blockNumber: Number(receipt.blockNumber),
					gasUsed: receipt.gasUsed,
					effectiveGasPrice: receipt.gasPrice,
					from: ethers.getAddress(receipt.from),
					logs: receipt.logs
				};
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[${network}] receipt ${txHash} failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[${network}] gave up on receipt ${txHash}`);
					return null;
				}
				await sleep(nativeSpendScanLimits.receiptRetryDelayMs);
			}
		}
		return null;
	}

	private async fetchBlocks(
		provider: ethers.JsonRpcProvider,
		network: Network,
		blockNumbers: number[]
	): Promise<{ blocks: Map<number, BlockInfo>; droppedBlockCount: number }> {
		const blocks = new Map<number, BlockInfo>();
		const totalCount = blockNumbers.length;

		let pending = blockNumbers;
		for (let pass = 1; pass <= nativeSpendScanLimits.receiptMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[${network}] block retry pass ${pass}/${nativeSpendScanLimits.receiptMaxPasses}: re-fetching ${pending.length} block(s)`
				);
			}
			const stillFailing: number[] = [];
			for (let offset = 0; offset < pending.length; offset += nativeSpendScanLimits.receiptBatchSize) {
				const batch = pending.slice(offset, offset + nativeSpendScanLimits.receiptBatchSize);
				const batchResults = await Promise.all(batch.map((blockNumber) => this.tryFetchBlock(provider, network, blockNumber)));
				for (let i = 0; i < batch.length; i++) {
					const result = batchResults[i];
					if (result === null) stillFailing.push(batch[i]);
					else blocks.set(batch[i], result);
				}
			}
			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[${network}] block retry pass ${pass}: recovered ${recovered}/${pending.length}`);
			}
			pending = stillFailing;
		}

		const droppedBlockCount = pending.length;
		if (droppedBlockCount > 0) {
			log.error(
				`[${network}] permanently lost ${droppedBlockCount}/${totalCount} block(s) after ${nativeSpendScanLimits.receiptMaxPasses} pass(es)`
			);
		}
		return { blocks, droppedBlockCount };
	}

	private async tryFetchBlock(
		provider: ethers.JsonRpcProvider,
		network: Network,
		blockNumber: number
	): Promise<BlockInfo | null> {
		let retries = nativeSpendScanLimits.receiptRetries;
		while (retries > 0) {
			try {
				const block = await provider.getBlock(blockNumber, true);
				if (!block) {
					retries--;
					if (retries === 0) {
						log.error(`[${network}] getBlock(${blockNumber}) returned null after all retries`);
						return null;
					}
					await sleep(nativeSpendScanLimits.receiptRetryDelayMs);
					continue;
				}
				return {
					timestamp: Number(block.timestamp),
					txs: block.prefetchedTransactions
				};
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[${network}] getBlock(${blockNumber}) failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[${network}] gave up on block ${blockNumber}`);
					return null;
				}
				await sleep(nativeSpendScanLimits.receiptRetryDelayMs);
			}
		}
		return null;
	}
}

export { EvmRebalanceSpendFetcher };
