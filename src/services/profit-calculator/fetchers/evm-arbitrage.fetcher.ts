import { ethers } from "ethers";
import { VAULT_ABI } from "../../../abis";
import {
	chainTypeByNetwork,
	enabledNetworks,
	evmChainMetadata,
	networkRpcUrls,
	rpcScanLimits,
	tokenConfig,
	vaultExecutorAddresses
} from "../../../config";
import { ChainType, Network, TokenSymbol } from "../../../types";
import {
	FetcherResult,
	ParsedTransaction,
	ProfitWindow,
	RawArbitrageEvent,
	ScanFailure,
	TypeRoute
} from "../../../types/profit-calculator.types";
import { findEvmBlockAfterTimestamp, findEvmBlockAtOrBeforeTimestamp, log, retry, sleep } from "../../../utils";

class EvmArbitrageFetcher {
	public async fetchByToken(token: TokenSymbol, window: ProfitWindow): Promise<FetcherResult> {
		const networks = Object.keys(vaultExecutorAddresses).filter((network) => {
			const net = network as Network;
			if (!enabledNetworks[net]) return false;
			if (chainTypeByNetwork[net] !== ChainType.EVM) return false;
			return Boolean(vaultExecutorAddresses[net]?.[token]);
		}) as Network[];

		if (networks.length === 0) {
			log.info(`[profit:${token}] no EVM networks configured for this token`);
			return { transactions: [], failures: [] };
		}

		const transactions: ParsedTransaction[] = [];
		const failures: ScanFailure[] = [];
		for (const network of networks) {
			try {
				const networkResult = await this.fetchForNetwork(token, network, window);
				transactions.push(...networkResult.transactions);
				failures.push(...networkResult.failures);
				if (networkResult.failures.length > 0) {
					log.error(
						`[profit:${token}][${network}] EVM scan INCOMPLETE: ${networkResult.transactions.length} event(s) collected, but chain data is partial`
					);
				} else {
					log.success(`[profit:${token}][${network}] EVM events: ${networkResult.transactions.length}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`[profit:${token}][${network}] EVM scan failed: ${message}`);
				failures.push({ network, detail: `scan threw: ${message}` });
			}
		}
		return { transactions, failures };
	}

	private async fetchForNetwork(token: TokenSymbol, network: Network, window: ProfitWindow): Promise<FetcherResult> {
		const vaultAddress = vaultExecutorAddresses[network]?.[token];
		if (!vaultAddress) return { transactions: [], failures: [] };

		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[evm-arb] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[evm-arb] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });

		try {
			const fromBlock = await findEvmBlockAfterTimestamp(provider, window.fromTimestampSeconds, network);
			const toBlock = await findEvmBlockAtOrBeforeTimestamp(provider, window.toTimestampSeconds, network);
			if (toBlock < fromBlock) {
				log.warning(`[profit:${token}][${network}] window empty (fromBlock=${fromBlock} > toBlock=${toBlock})`);
				return { transactions: [], failures: [] };
			}
			log.info(
				`[profit:${token}][${network}] scanning blocks ${fromBlock} → ${toBlock} (${(toBlock - fromBlock).toLocaleString()} blocks) vault=${vaultAddress}`
			);

			const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

			const [inputScan, outputScan] = await Promise.all([
				this.scanEvmInChunks(network, vault, "InputArbitrageExecuted", TypeRoute.SELL, fromBlock, toBlock),
				this.scanEvmInChunks(network, vault, "OutputArbitrageExecuted", TypeRoute.BUY, fromBlock, toBlock)
			]);
			const rawEvents = [...inputScan.events, ...outputScan.events];
			const failures: ScanFailure[] = [];
			if (inputScan.failure) failures.push(inputScan.failure);
			if (outputScan.failure) failures.push(outputScan.failure);

			if (rawEvents.length === 0) return { transactions: [], failures };

			const timestampByBlock = await this.fetchBlockTimestamps(provider, network, rawEvents);

			const transactions: ParsedTransaction[] = [];
			for (const raw of rawEvents) {
				const blockTimestamp = timestampByBlock.get(raw.blockNumber);
				if (blockTimestamp === undefined) continue;
				if (blockTimestamp < window.fromTimestampSeconds || blockTimestamp > window.toTimestampSeconds) continue;

				const parsed = this.toParsedTransaction(raw, blockTimestamp, network);
				if (parsed) transactions.push(parsed);
			}
			return { transactions, failures };
		} finally {
			provider.destroy();
		}
	}

	private async scanEvmInChunks(
		network: Network,
		vault: ethers.Contract,
		eventName: "InputArbitrageExecuted" | "OutputArbitrageExecuted",
		legType: TypeRoute,
		fromBlock: number,
		toBlock: number
	): Promise<{ events: RawArbitrageEvent[]; failure: ScanFailure | null }> {
		const events: RawArbitrageEvent[] = [];

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
				const chunkEvents = await this.tryFetchChunkEvents(network, vault, eventName, legType, start, end);
				if (chunkEvents === null) {
					stillFailing.push({ start, end });
				} else {
					events.push(...chunkEvents);
				}
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
		log.error(
			`[${network}] ${detail}; arbitrages inside that range will be missing from this run`
		);
		return { events, failure: { network, detail } };
	}

	private async tryFetchChunkEvents(
		network: Network,
		vault: ethers.Contract,
		eventName: "InputArbitrageExecuted" | "OutputArbitrageExecuted",
		legType: TypeRoute,
		start: number,
		end: number
	): Promise<RawArbitrageEvent[] | null> {
		let retries = rpcScanLimits.evmChunkRetries;
		while (retries > 0) {
			try {
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

	private async fetchBlockTimestamps(
		provider: ethers.JsonRpcProvider,
		network: Network,
		events: RawArbitrageEvent[]
	): Promise<Map<number, number>> {
		const uniqueBlocks = Array.from(new Set(events.map((e) => e.blockNumber)));
		const timestampByBlock = new Map<number, number>();

		for (const blockNumber of uniqueBlocks) {
			try {
				const block = await retry(() => provider.getBlock(blockNumber), `${network} getBlock(${blockNumber})`);
				if (!block) continue;
				timestampByBlock.set(blockNumber, Number(block.timestamp));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.warning(`[${network}] getBlock(${blockNumber}) gave up: ${message}; events in that block dropped`);
			}
		}
		return timestampByBlock;
	}

	private toParsedTransaction(raw: RawArbitrageEvent, blockTimestamp: number, network: Network): ParsedTransaction | null {
		const tokenInMeta = tokenConfig[raw.tokenInAddress];
		const tokenOutMeta = tokenConfig[raw.tokenOutAddress];
		if (!tokenInMeta) {
			log.warning(`[${network}] unknown tokenIn ${raw.tokenInAddress} in tx ${raw.transactionHash} — dropping event`);
			return null;
		}
		if (!tokenOutMeta) {
			log.warning(`[${network}] unknown tokenOut ${raw.tokenOutAddress} in tx ${raw.transactionHash} — dropping event`);
			return null;
		}

		return {
			hash: raw.transactionHash,
			timestamp: new Date(blockTimestamp * 1000).toISOString(),
			network,
			type: raw.type,
			tokenIn: tokenInMeta.symbol,
			tokenOut: tokenOutMeta.symbol,
			amountIn: parseFloat(ethers.formatUnits(raw.amountIn, tokenInMeta.decimals)).toFixed(5),
			amountOut: parseFloat(ethers.formatUnits(raw.amountOut, tokenOutMeta.decimals)).toFixed(5),
			blockNumber: raw.blockNumber
		};
	}
}

export { EvmArbitrageFetcher };
