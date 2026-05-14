import { ethers } from "ethers";
import { VAULT_ABI } from "../../../abis";
import {
	chainTypeByNetwork,
	enabledNetworks,
	evmChainMetadata,
	loadMonitoredEvmWallets,
	nativeSpendScanLimits,
	networkRpcUrls,
	rpcScanLimits,
	vaultExecutorAddresses
} from "../../../config";
import {
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

interface ArbEventHit {
	transactionHash: string;
	blockNumber: number;
}

interface ReceiptInfo {
	transactionHash: string;
	blockNumber: number;
	gasUsed: bigint;
	effectiveGasPrice: bigint;
	from: string;
}

interface BlockInfo {
	timestamp: number;
	txs: ethers.TransactionResponse[] | null;
}

class EvmArbSpendFetcher {
	private readonly arbWallet: string = loadMonitoredEvmWallets().arb;
	// First per-token call on a chain emits unattributed records for the arb
	// wallet; subsequent token calls on the same chain skip to avoid dupes.
	private readonly unattributedClaimed = new Set<Network>();

	constructor(private readonly failedTx: FailedTxScanner) {}

	public async fetchByToken(token: TokenSymbol, window: NativeSpendWindow): Promise<FetcherSpendResult> {
		const networks = Object.keys(vaultExecutorAddresses).filter((name) => {
			const network = name as Network;
			if (!enabledNetworks[network]) return false;
			if (chainTypeByNetwork[network] !== ChainType.EVM) return false;
			return Boolean(vaultExecutorAddresses[network]?.[token]);
		}) as Network[];

		if (networks.length === 0) {
			log.info(`[native-spend:${token}] no EVM networks configured for this token`);
			return { records: [], unattributedRecords: [], failures: [] };
		}

		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];
		const failures: NativeSpendScanFailure[] = [];

		for (const network of networks) {
			try {
				const networkResult = await this.fetchForNetwork(token, network, window);
				records.push(...networkResult.records);
				unattributedRecords.push(...networkResult.unattributedRecords);
				failures.push(...networkResult.failures);
				if (networkResult.failures.length > 0) {
					log.error(
						`[native-spend:${token}][${network}] EVM scan INCOMPLETE: ${networkResult.records.length} record(s) collected, but chain data is partial`
					);
				} else {
					log.success(`[native-spend:${token}][${network}] records: ${networkResult.records.length}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`[native-spend:${token}][${network}] scan failed: ${message}`);
				failures.push({ network, intent: SpendIntent.ARBITRAGE, detail: `scan threw: ${message}` });
			}
		}

		return { records, unattributedRecords, failures };
	}

	private async fetchForNetwork(
		token: TokenSymbol,
		network: Network,
		window: NativeSpendWindow
	): Promise<FetcherSpendResult> {
		const vaultAddress = vaultExecutorAddresses[network]?.[token];
		if (!vaultAddress) return { records: [], unattributedRecords: [], failures: [] };

		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[native-spend] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[native-spend] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });

		try {
			const fromBlock = await findEvmBlockAfterTimestamp(provider, window.fromTimestampSeconds, network);
			const toBlock = await findEvmBlockAtOrBeforeTimestamp(provider, window.toTimestampSeconds, network);
			if (toBlock < fromBlock) {
				log.warning(`[native-spend:${token}][${network}] window empty (fromBlock=${fromBlock} > toBlock=${toBlock})`);
				return { records: [], unattributedRecords: [], failures: [] };
			}
			log.info(
				`[native-spend:${token}][${network}] scanning blocks ${fromBlock} → ${toBlock} (${(toBlock - fromBlock).toLocaleString()} blocks) vault=${vaultAddress}`
			);

			const failedScan = await this.fetchRevertedRecords(token, network, vaultAddress, fromBlock, toBlock);

			const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
			const [inputScan, outputScan] = await Promise.all([
				this.scanEvmInChunks(network, vault, "InputArbitrageExecuted", fromBlock, toBlock),
				this.scanEvmInChunks(network, vault, "OutputArbitrageExecuted", fromBlock, toBlock)
			]);
			const hits: ArbEventHit[] = [...inputScan.events, ...outputScan.events];
			const failures: NativeSpendScanFailure[] = [...failedScan.failures];
			if (inputScan.failure) failures.push(inputScan.failure);
			if (outputScan.failure) failures.push(outputScan.failure);
			if (hits.length === 0) {
				return {
					records: failedScan.records,
					unattributedRecords: failedScan.unattributedRecords,
					failures
				};
			}

			const uniqueTxHashes: string[] = [];
			const seenTx = new Set<string>();
			for (const hit of hits) {
				if (seenTx.has(hit.transactionHash)) continue;
				seenTx.add(hit.transactionHash);
				uniqueTxHashes.push(hit.transactionHash);
			}

			const { receipts, droppedReceiptCount } = await this.fetchReceipts(provider, network, uniqueTxHashes);
			if (droppedReceiptCount > 0) {
				failures.push({
					network,
					intent: SpendIntent.ARBITRAGE,
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

			const needFullBlocks = network === Network.ETH || network === Network.BSC;
			const { blocks, droppedBlockCount } = await this.fetchBlocks(provider, network, uniqueBlocks, needFullBlocks);
			if (droppedBlockCount > 0) {
				failures.push({
					network,
					intent: SpendIntent.ARBITRAGE,
					detail: `lost ${droppedBlockCount} block(s) after ${nativeSpendScanLimits.receiptMaxPasses} pass(es)`
				});
			}

			const successRecords = this.buildRecords({ token, network, receipts, blocks, window });
			return {
				records: [...successRecords, ...failedScan.records],
				unattributedRecords: failedScan.unattributedRecords,
				failures
			};
		} finally {
			provider.destroy();
		}
	}

	private async fetchRevertedRecords(
		token: TokenSymbol,
		network: Network,
		vaultAddress: string,
		fromBlock: number,
		toBlock: number
	): Promise<{
		records: SpendRecord[];
		unattributedRecords: UnattributedSpendRecord[];
		failures: NativeSpendScanFailure[];
	}> {
		const source = evmChainMetadata[network]?.failedTxSource;
		if (source) {
			log.info(`[native-spend:${token}][${network}] failed-tx scan via ${source} starting (wallet=${this.arbWallet})`);
		}
		let txs;
		try {
			txs = await this.failedTx.getWalletTxs(network, this.arbWallet, fromBlock, toBlock);
		} catch (error) {
			if (error instanceof UnsupportedFailedTxChainError) {
				return {
					records: [],
					unattributedRecords: [],
					failures: [
						{
							network,
							intent: SpendIntent.ARBITRAGE,
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
					{ network, intent: SpendIntent.ARBITRAGE, detail: `failed-tx scan threw: ${message}` }
				]
			};
		}

		const vaultLower = vaultAddress.toLowerCase();
		const allVaultsLower = this.buildAllVaultsLower(network);
		const claimUnattributed = !this.unattributedClaimed.has(network);
		if (claimUnattributed) this.unattributedClaimed.add(network);

		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];
		for (const tx of txs) {
			if (!tx.isError) continue;
			const toLower = tx.to ? tx.to.toLowerCase() : null;
			if (toLower === vaultLower) {
				const gas = tx.gasUsed * tx.gasPrice;
				records.push({
					network,
					intent: SpendIntent.ARBITRAGE,
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
					detail: "arb tx reverted"
				});
			} else if (claimUnattributed && (toLower === null || !allVaultsLower.has(toLower))) {
				const gas = tx.gasUsed * tx.gasPrice;
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

	private buildAllVaultsLower(network: Network): Set<string> {
		const vaults = vaultExecutorAddresses[network] ?? {};
		const set = new Set<string>();
		for (const address of Object.values(vaults)) {
			if (address) set.add(address.toLowerCase());
		}
		return set;
	}

	private buildRecords(args: {
		token: TokenSymbol;
		network: Network;
		receipts: Map<string, ReceiptInfo>;
		blocks: Map<number, BlockInfo>;
		window: NativeSpendWindow;
	}): SpendRecord[] {
		const { token, network, receipts, blocks, window } = args;
		const records: SpendRecord[] = [];

		for (const receipt of receipts.values()) {
			const block = blocks.get(receipt.blockNumber);
			if (!block) continue;
			if (block.timestamp < window.fromTimestampSeconds || block.timestamp > window.toTimestampSeconds) continue;

			const arbTx = block.txs?.find((tx) => tx.hash === receipt.transactionHash);
			const gas = receipt.gasUsed * receipt.effectiveGasPrice;
			// ETH and BSC pay the builder bribe via tx.value on the arb tx itself
			// (vault forwards it to the bundler internally). Other EVM chains pay gas only.
			const bribe = arbTx && arbTx.value > 0n ? arbTx.value : 0n;
			const total = gas + bribe;
			records.push({
				network,
				intent: SpendIntent.ARBITRAGE,
				status: SpendStatus.SUCCESS,
				token,
				txHash: receipt.transactionHash,
				blockNumber: receipt.blockNumber,
				timestampSeconds: block.timestamp,
				timestampIso: new Date(block.timestamp * 1000).toISOString(),
				payer: receipt.from,
				nativeAmount: total.toString(),
				usdAmount: null,
				breakdown: {
					gas: gas.toString(),
					...(bribe > 0n ? { bribe: bribe.toString() } : {})
				},
				detail: bribe > 0n ? "arb tx (gas + builder bribe)" : "arb tx gas"
			});
		}

		return records;
	}

	private async scanEvmInChunks(
		network: Network,
		vault: ethers.Contract,
		eventName: "InputArbitrageExecuted" | "OutputArbitrageExecuted",
		fromBlock: number,
		toBlock: number
	): Promise<{ events: ArbEventHit[]; failure: NativeSpendScanFailure | null }> {
		const events: ArbEventHit[] = [];

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
					`[${network}] ${eventName} retry pass ${pass}/${rpcScanLimits.evmChunkMaxPasses}: re-fetching ${pending.length} chunk(s) that failed earlier`
				);
			}
			const stillFailing: Array<{ start: number; end: number }> = [];
			for (const { start, end } of pending) {
				const chunkEvents = await this.tryFetchChunkEvents(network, vault, eventName, start, end);
				if (chunkEvents === null) stillFailing.push({ start, end });
				else events.push(...chunkEvents);
			}
			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[${network}] ${eventName} retry pass ${pass}: recovered ${recovered}/${pending.length} chunk(s)`);
			}
			pending = stillFailing;
		}

		if (pending.length === 0) return { events, failure: null };

		const droppedBlocks = pending.reduce((sum, { start, end }) => sum + (end - start + 1), 0);
		const detail = `${eventName} lost ${pending.length}/${totalChunks} chunk(s) = ${droppedBlocks.toLocaleString()} block(s) after ${rpcScanLimits.evmChunkMaxPasses} pass(es)`;
		log.error(`[${network}] ${detail}; arb txs inside that range will be missing from this run`);
		return { events, failure: { network, intent: SpendIntent.ARBITRAGE, detail } };
	}

	private async tryFetchChunkEvents(
		network: Network,
		vault: ethers.Contract,
		eventName: "InputArbitrageExecuted" | "OutputArbitrageExecuted",
		start: number,
		end: number
	): Promise<ArbEventHit[] | null> {
		let retries = rpcScanLimits.evmChunkRetries;
		while (retries > 0) {
			try {
				const filter = vault.filters[eventName]();
				const logs = await vault.queryFilter(filter, start, end);
				return logs.map((entry) => ({
					transactionHash: entry.transactionHash,
					blockNumber: Number(entry.blockNumber)
				}));
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[${network}] ${eventName} chunk ${start}-${end} failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[${network}] gave up on ${eventName} chunk ${start}-${end}`);
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
					from: ethers.getAddress(receipt.from)
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
		blockNumbers: number[],
		withTxs: boolean
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
				const batchResults = await Promise.all(
					batch.map((blockNumber) => this.tryFetchBlock(provider, network, blockNumber, withTxs))
				);
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
		blockNumber: number,
		withTxs: boolean
	): Promise<BlockInfo | null> {
		let retries = nativeSpendScanLimits.receiptRetries;
		while (retries > 0) {
			try {
				const block = await provider.getBlock(blockNumber, withTxs);
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
					txs: withTxs ? block.prefetchedTransactions : null
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

export { EvmArbSpendFetcher };
