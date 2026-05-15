import { ethers } from "ethers";
import {
	evmChainMetadata,
	nativeSpendScanLimits,
	nativeUsdPoolByNetwork,
	networkRpcUrls,
	solanaFallbackNetwork,
	solanaFallbackPool,
	svmChainMetadata
} from "../../config";
import {
	NativeSpendScanFailure,
	NativeSpendWindow,
	Network,
	PoolRef
} from "../../types";
import { errorMessage, findEvmBlockAtOrBeforeTimestamp, log, sleep } from "../../utils";

const Q192 = 2n ** 192n;
// Internal price scale: stable-per-native rendered as an 18-decimal bigint
// before we convert to JS Number for the *small* nativeHuman multiplication.
const PRICE_SCALE_DECIMALS = 18n;
const PRICE_SCALE = 10n ** PRICE_SCALE_DECIMALS;

interface PriceableRecord {
	network: Network;
	blockNumber: number;
	timestampSeconds: number;
	nativeAmount: string;
	usdAmount: number | null;
}

class PriceResolverService {
	// Per-run cache keyed by `${rpcNetwork}:${blockOnRpcNetwork}`.
	private readonly priceCache: Map<string, number> = new Map();
	// Fallback-chain anchor for Solana time-mapping. Two binary searches at window edges;
	// every SOL tx inside the window resolves via linear interpolation between them.
	private fallbackAnchor: { startBlock: number; startTimestamp: number; endBlock: number; endTimestamp: number } | null =
		null;

	public async priceAll(window: NativeSpendWindow, records: PriceableRecord[]): Promise<NativeSpendScanFailure[]> {
		const byNetwork = new Map<Network, PriceableRecord[]>();
		for (const record of records) {
			const list = byNetwork.get(record.network) ?? [];
			list.push(record);
			byNetwork.set(record.network, list);
		}

		const failures: NativeSpendScanFailure[] = [];
		for (const [network, networkRecords] of byNetwork) {
			if (network === Network.SOLANA) {
				const solanaFailures = await this.priceSolanaRecords(networkRecords, window);
				failures.push(...solanaFailures);
			} else {
				const evmFailures = await this.priceEvmRecords(network, networkRecords);
				failures.push(...evmFailures);
			}
		}
		return failures;
	}

	private async priceEvmRecords(network: Network, records: PriceableRecord[]): Promise<NativeSpendScanFailure[]> {
		const pool = nativeUsdPoolByNetwork[network];
		if (!pool) {
			return [
				{
					network,
					intent: "PRICING",
					detail: `no native↔stable pool configured in nativeUsdPoolByNetwork[${network}]`
				}
			];
		}
		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) {
			return [{ network, intent: "PRICING", detail: `missing networkRpcUrls[${network}]` }];
		}
		if (!meta) {
			return [{ network, intent: "PRICING", detail: `missing evmChainMetadata[${network}]` }];
		}

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });
		try {
			return await this.priceRecordsAgainstPool({
				records,
				pool,
				rpcNetwork: network,
				blockOf: (record) => record.blockNumber,
				provider,
				logContext: network,
				nativeDecimals: meta.nativeDecimals
			});
		} finally {
			provider.destroy();
		}
	}

	private async priceSolanaRecords(records: PriceableRecord[], window: NativeSpendWindow): Promise<NativeSpendScanFailure[]> {
		const pool = solanaFallbackPool;
		const fallbackNetwork = solanaFallbackNetwork;
		const logContext = `SOLANA→${fallbackNetwork}`;
		if (!ethers.isAddress(pool.address)) {
			return [
				{
					network: Network.SOLANA,
					intent: "PRICING",
					detail: `Solana pricing not yet configured: solanaFallbackPool.address is placeholder "${pool.address}"`
				}
			];
		}
		const fallbackRpc = networkRpcUrls[fallbackNetwork];
		const fallbackMeta = evmChainMetadata[fallbackNetwork];
		const solanaMeta = svmChainMetadata[Network.SOLANA];
		if (!fallbackRpc) {
			return [
				{
					network: Network.SOLANA,
					intent: "PRICING",
					detail: `missing networkRpcUrls[${fallbackNetwork}] for SOL fallback`
				}
			];
		}
		if (!fallbackMeta) {
			return [
				{
					network: Network.SOLANA,
					intent: "PRICING",
					detail: `missing evmChainMetadata[${fallbackNetwork}] for SOL fallback`
				}
			];
		}
		if (!solanaMeta) {
			return [{ network: Network.SOLANA, intent: "PRICING", detail: "missing svmChainMetadata[SOLANA]" }];
		}

		const staticNetwork = ethers.Network.from(fallbackMeta.chainId);
		const provider = new ethers.JsonRpcProvider(fallbackRpc, staticNetwork, { staticNetwork });
		try {
			await this.initFallbackAnchor(provider, window, logContext);

			const timestampToFallbackBlock = new Map<number, number>();
			for (const record of records) {
				if (!timestampToFallbackBlock.has(record.timestampSeconds)) {
					timestampToFallbackBlock.set(record.timestampSeconds, this.resolveFallbackBlock(record.timestampSeconds, logContext));
				}
			}

			return await this.priceRecordsAgainstPool({
				records,
				pool,
				rpcNetwork: fallbackNetwork,
				blockOf: (record) => timestampToFallbackBlock.get(record.timestampSeconds) ?? -1,
				provider,
				logContext,
				nativeDecimals: solanaMeta.nativeDecimals
			});
		} finally {
			provider.destroy();
		}
	}

	// Shared pricing loop: dedup blocks → 2-pass slot0 fetch → apply price * nativeAmount.
	private async priceRecordsAgainstPool(args: {
		records: PriceableRecord[];
		pool: PoolRef;
		rpcNetwork: Network;
		blockOf: (record: PriceableRecord) => number;
		provider: ethers.JsonRpcProvider;
		logContext: string;
		nativeDecimals: number;
	}): Promise<NativeSpendScanFailure[]> {
		const { records, pool, rpcNetwork, blockOf, provider, logContext, nativeDecimals } = args;

		const uniqueBlocks: number[] = [];
		const seen = new Set<number>();
		for (const record of records) {
			const block = blockOf(record);
			if (block < 0 || seen.has(block)) continue;
			seen.add(block);
			if (this.priceCache.has(`${rpcNetwork}:${block}`)) continue;
			uniqueBlocks.push(block);
		}

		let pending = uniqueBlocks;
		for (let pass = 1; pass <= nativeSpendScanLimits.multicallMaxPasses; pass++) {
			if (pending.length === 0) break;
			if (pass > 1) {
				log.warning(
					`[price:${logContext}] retry pass ${pass}/${nativeSpendScanLimits.multicallMaxPasses}: re-fetching ${pending.length} block(s) that failed earlier`
				);
			}
			const stillFailing: number[] = [];
			for (const blockNumber of pending) {
				const price = await this.tryFetchPrice(provider, pool, blockNumber, logContext);
				if (price === null) stillFailing.push(blockNumber);
				else this.priceCache.set(`${rpcNetwork}:${blockNumber}`, price);
			}
			if (pass > 1) {
				const recovered = pending.length - stillFailing.length;
				log.info(`[price:${logContext}] retry pass ${pass}: recovered ${recovered}/${pending.length} block(s)`);
			}
			pending = stillFailing;
		}

		const tenPowNative = Math.pow(10, nativeDecimals);
		let unpricedCount = 0;
		for (const record of records) {
			const block = blockOf(record);
			if (block < 0) {
				unpricedCount++;
				continue;
			}
			const price = this.priceCache.get(`${rpcNetwork}:${block}`);
			if (price === undefined) {
				unpricedCount++;
				continue;
			}
			const nativeHuman = Number(record.nativeAmount) / tenPowNative;
			record.usdAmount = nativeHuman * price;
		}

		if (pending.length === 0) return [];

		const droppedBlocks = pending.length;
		return [
			{
				network: rpcNetwork,
				intent: "PRICING",
				detail: `${logContext} lost ${droppedBlocks} block(s) after ${nativeSpendScanLimits.multicallMaxPasses} pass(es); ${unpricedCount} record(s) left unpriced`
			}
		];
	}

	private async tryFetchPrice(
		provider: ethers.JsonRpcProvider,
		pool: PoolRef,
		blockNumber: number,
		logContext: string
	): Promise<number | null> {
		const selector = ethers.id(pool.priceMethod === "slot0" ? "slot0()" : "globalState()").slice(0, 10);
		const blockTag = "0x" + blockNumber.toString(16);

		let retries = nativeSpendScanLimits.multicallRetries;
		while (retries > 0) {
			try {
				const result = await provider.send("eth_call", [{ to: pool.address, data: selector }, blockTag]);
				if (typeof result !== "string" || result.length < 66) {
					throw new Error(`unexpected eth_call result shape: ${String(result).slice(0, 80)}`);
				}
				// First 32 bytes hold uint160 sqrtPriceX96 (left-padded).
				const sqrtPriceX96 = BigInt(result.slice(0, 66));
				return this.sqrtPriceToUsd(sqrtPriceX96, pool);
			} catch (error) {
				retries--;
				const message = errorMessage(error);
				log.warning(`[price:${logContext}] block ${blockNumber} failed (${retries} retries left): ${message}`);
				if (retries === 0) {
					log.error(`[price:${logContext}] gave up on block ${blockNumber}`);
					return null;
				}
				await sleep(nativeSpendScanLimits.multicallRetryDelayMs);
			}
		}
		return null;
	}

	private sqrtPriceToUsd(sqrtPriceX96: bigint, pool: PoolRef): number {
		// Uniswap-V3: rawPrice_atomic = (sqrtPriceX96 / 2^96)^2 = token1_atomic per token0_atomic.
		// We want stable_human per native_human. Two cases differ only in which slot the native sits in.
		// Compute the answer in 18-dec bigint precision, then convert ONCE at the end so we don't
		// lose digits the way Number(sqrtPriceX96) does (sqrtPriceX96 is ~25 digits, double only carries ~15).
		const numerator = sqrtPriceX96 * sqrtPriceX96; // token1_atomic / token0_atomic * 2^192
		const nativeFactor = 10n ** BigInt(pool.nativeDecimals);
		const stableFactor = 10n ** BigInt(pool.stableDecimals);
		let scaledPrice: bigint;
		if (pool.baseIsNative) {
			// token0=native, token1=stable. price = rawPrice_atomic * 10^(native - stable).
			scaledPrice = (numerator * nativeFactor * PRICE_SCALE) / (Q192 * stableFactor);
		} else {
			// token0=stable, token1=native. price = (1 / rawPrice_atomic) * 10^(native - stable).
			scaledPrice = (Q192 * nativeFactor * PRICE_SCALE) / (numerator * stableFactor);
		}
		return Number(scaledPrice) / Number(PRICE_SCALE);
	}

	private async initFallbackAnchor(
		provider: ethers.JsonRpcProvider,
		window: NativeSpendWindow,
		logContext: string
	): Promise<void> {
		if (this.fallbackAnchor) return;
		const startBlockNumber = await findEvmBlockAtOrBeforeTimestamp(
			provider,
			window.fromTimestampSeconds,
			`${logContext} anchor-start`
		);
		const startBlock = await provider.getBlock(startBlockNumber);
		if (!startBlock) throw new Error(`[price:${logContext}] getBlock(${startBlockNumber}) returned null`);
		const endBlockNumber = await findEvmBlockAtOrBeforeTimestamp(
			provider,
			window.toTimestampSeconds,
			`${logContext} anchor-end`
		);
		const endBlock = await provider.getBlock(endBlockNumber);
		if (!endBlock) throw new Error(`[price:${logContext}] getBlock(${endBlockNumber}) returned null`);
		this.fallbackAnchor = {
			startBlock: startBlockNumber,
			startTimestamp: Number(startBlock.timestamp),
			endBlock: endBlockNumber,
			endTimestamp: Number(endBlock.timestamp)
		};
	}

	private resolveFallbackBlock(targetTimestamp: number, logContext: string): number {
		if (!this.fallbackAnchor) throw new Error(`[price:${logContext}] fallback anchor not initialised`);
		const anchor = this.fallbackAnchor;
		if (anchor.endTimestamp <= anchor.startTimestamp) return anchor.startBlock;
		const ratio = (targetTimestamp - anchor.startTimestamp) / (anchor.endTimestamp - anchor.startTimestamp);
		const clamped = Math.max(0, Math.min(1, ratio));
		return Math.round(anchor.startBlock + clamped * (anchor.endBlock - anchor.startBlock));
	}
}

export { PriceResolverService };
