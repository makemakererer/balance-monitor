import { evmChainMetadata, svmChainMetadata } from "../../config";
import { Network, TokenSymbol } from "../../types";
import {
	FailedBreakdownEntry,
	FailedNetworkEntry,
	FailedTotals,
	IntentNetworkSpend,
	IntentNetworkTokenSpend,
	IntentTotals,
	NativeSpendGrandTotals,
	NativeTokenTotals,
	RebalanceSpendEntry,
	SpendIntent,
	SpendRecord,
	SpendStatus,
	TokenArbSpendEntry,
	TokenIntentSpend,
	TokenTotals,
	UnattributedSpendEntry,
	UnattributedSpendRecord
} from "../../types/native-spend.types";

interface NetworkAccumulator {
	native: bigint;
	usd: number;
	hasPriced: boolean;
	txCount: number;
	tokens: Map<TokenSymbol, { native: bigint; usd: number; hasPriced: boolean; txCount: number }>;
}

class StatsCalculatorService {
	public calculate(args: {
		perTokenEntries: TokenArbSpendEntry[];
		rebalanceEntry: RebalanceSpendEntry | null;
		unattributedEntry: UnattributedSpendEntry | null;
		startedAtMs: number;
	}): NativeSpendGrandTotals {
		const { perTokenEntries, rebalanceEntry, unattributedEntry, startedAtMs } = args;

		const arbAll: SpendRecord[] = [];
		for (const entry of perTokenEntries) arbAll.push(...entry.records);
		const rebalAll: SpendRecord[] = rebalanceEntry ? rebalanceEntry.records : [];
		const unattributed: UnattributedSpendRecord[] = unattributedEntry ? unattributedEntry.records : [];

		const arbSuccess = arbAll.filter((r) => r.status === SpendStatus.SUCCESS);
		const arbReverted = arbAll.filter((r) => r.status === SpendStatus.REVERTED);
		const rebalSuccess = rebalAll.filter((r) => r.status === SpendStatus.SUCCESS);
		const rebalReverted = rebalAll.filter((r) => r.status === SpendStatus.REVERTED);

		const arbitrage = this.aggregateIntent(SpendIntent.ARBITRAGE, arbSuccess, arbReverted);
		const rebalance = this.aggregateIntent(SpendIntent.REBALANCE, rebalSuccess, rebalReverted);
		const failed = this.aggregateFailed(arbReverted, rebalReverted, unattributed);

		const totalUsd = this.round(arbitrage.usdTotal + rebalance.usdTotal + failed.usdTotal);
		const totalTxCount = arbitrage.txCount + rebalance.txCount + failed.txCount;

		return {
			completedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAtMs,
			totalUsd,
			totalTxCount,
			byToken: this.aggregateByToken(arbSuccess, rebalSuccess, arbReverted, rebalReverted),
			byNativeToken: this.aggregateByNativeToken(arbAll, rebalAll, unattributed),
			arbitrage,
			rebalance,
			failed
		};
	}

	private aggregateIntent(
		intent: SpendIntent,
		successRecords: SpendRecord[],
		revertedRecords: SpendRecord[]
	): IntentTotals {
		const buckets = new Map<Network, NetworkAccumulator>();
		let usdTotal = 0;
		for (const record of successRecords) {
			const bucket = buckets.get(record.network) ?? this.emptyNetworkBucket();
			bucket.native += BigInt(record.nativeAmount);
			if (record.usdAmount !== null) {
				bucket.usd += record.usdAmount;
				bucket.hasPriced = true;
				usdTotal += record.usdAmount;
			}
			bucket.txCount++;
			const tokenBucket = bucket.tokens.get(record.token) ?? {
				native: 0n,
				usd: 0,
				hasPriced: false,
				txCount: 0
			};
			tokenBucket.native += BigInt(record.nativeAmount);
			if (record.usdAmount !== null) {
				tokenBucket.usd += record.usdAmount;
				tokenBucket.hasPriced = true;
			}
			tokenBucket.txCount++;
			bucket.tokens.set(record.token, tokenBucket);
			buckets.set(record.network, bucket);
		}

		const revertedPerNetwork = new Map<Network, { usd: number; txCount: number }>();
		for (const record of revertedRecords) {
			const entry = revertedPerNetwork.get(record.network) ?? { usd: 0, txCount: 0 };
			entry.usd += record.usdAmount ?? 0;
			entry.txCount++;
			revertedPerNetwork.set(record.network, entry);
		}
		// Surface chains that had ONLY reverts for this intent (no successes) so the
		// renderer still sees them as a row with revertedUsd > 0.
		for (const network of revertedPerNetwork.keys()) {
			if (!buckets.has(network)) buckets.set(network, this.emptyNetworkBucket());
		}

		const networks: IntentNetworkSpend[] = [];
		for (const [network, bucket] of buckets) {
			const nativeMeta = this.resolveNativeMeta(network);
			const byToken: IntentNetworkTokenSpend[] = [];
			for (const [token, tokenBucket] of bucket.tokens) {
				byToken.push({
					token,
					nativeAmount: tokenBucket.native.toString(),
					usdAmount: tokenBucket.hasPriced ? this.round(tokenBucket.usd) : null,
					txCount: tokenBucket.txCount
				});
			}
			byToken.sort((a, b) => this.compareUsd(a.usdAmount, b.usdAmount, a.token, b.token));
			const reverted = revertedPerNetwork.get(network) ?? { usd: 0, txCount: 0 };
			networks.push({
				network,
				nativeAmount: bucket.native.toString(),
				nativeSymbol: nativeMeta.symbol,
				nativeDecimals: nativeMeta.decimals,
				usdAmount: bucket.hasPriced ? this.round(bucket.usd) : null,
				txCount: bucket.txCount,
				byToken,
				revertedUsd: this.round(reverted.usd),
				revertedTxCount: reverted.txCount
			});
		}
		networks.sort((a, b) => this.compareUsd(a.usdAmount, b.usdAmount, a.network, b.network));

		return {
			intent,
			usdTotal: this.round(usdTotal),
			txCount: successRecords.length,
			byNetwork: networks
		};
	}

	private aggregateFailed(
		arbReverted: SpendRecord[],
		rebalReverted: SpendRecord[],
		unattributed: UnattributedSpendRecord[]
	): FailedTotals {
		const sumUsd = (items: { usdAmount: number | null }[]): number =>
			items.reduce((acc, item) => acc + (item.usdAmount ?? 0), 0);

		const byType = {
			arbitrage: { usdAmount: this.round(sumUsd(arbReverted)), txCount: arbReverted.length } as FailedBreakdownEntry,
			rebalance: { usdAmount: this.round(sumUsd(rebalReverted)), txCount: rebalReverted.length } as FailedBreakdownEntry,
			unattributed: { usdAmount: this.round(sumUsd(unattributed)), txCount: unattributed.length } as FailedBreakdownEntry
		};

		const networkBuckets = new Map<Network, { usd: number; txCount: number }>();
		const ingest = (items: { network: Network; usdAmount: number | null }[]): void => {
			for (const item of items) {
				const bucket = networkBuckets.get(item.network) ?? { usd: 0, txCount: 0 };
				bucket.usd += item.usdAmount ?? 0;
				bucket.txCount++;
				networkBuckets.set(item.network, bucket);
			}
		};
		ingest(arbReverted);
		ingest(rebalReverted);
		ingest(unattributed);

		const byNetwork: FailedNetworkEntry[] = [];
		for (const [network, bucket] of networkBuckets) {
			byNetwork.push({ network, usdAmount: this.round(bucket.usd), txCount: bucket.txCount });
		}
		byNetwork.sort((a, b) => b.usdAmount - a.usdAmount || a.network.localeCompare(b.network));

		const txCount = arbReverted.length + rebalReverted.length + unattributed.length;
		const usdTotal = this.round(byType.arbitrage.usdAmount + byType.rebalance.usdAmount + byType.unattributed.usdAmount);
		return { usdTotal, txCount, byType, byNetwork };
	}

	private aggregateByToken(
		arbSuccess: SpendRecord[],
		rebalSuccess: SpendRecord[],
		arbReverted: SpendRecord[],
		rebalReverted: SpendRecord[]
	): TokenTotals[] {
		const buckets = new Map<
			TokenSymbol,
			{
				successByIntent: Map<SpendIntent, { usdAmount: number; txCount: number }>;
				failedUsd: number;
				failedTxCount: number;
			}
		>();
		const ensure = (token: TokenSymbol) => {
			let bucket = buckets.get(token);
			if (!bucket) {
				bucket = { successByIntent: new Map(), failedUsd: 0, failedTxCount: 0 };
				buckets.set(token, bucket);
			}
			return bucket;
		};
		const ingestSuccess = (records: SpendRecord[], intent: SpendIntent): void => {
			for (const record of records) {
				const bucket = ensure(record.token);
				const entry = bucket.successByIntent.get(intent) ?? { usdAmount: 0, txCount: 0 };
				entry.usdAmount += record.usdAmount ?? 0;
				entry.txCount++;
				bucket.successByIntent.set(intent, entry);
			}
		};
		const ingestFailed = (records: SpendRecord[]): void => {
			for (const record of records) {
				const bucket = ensure(record.token);
				bucket.failedUsd += record.usdAmount ?? 0;
				bucket.failedTxCount++;
			}
		};
		ingestSuccess(arbSuccess, SpendIntent.ARBITRAGE);
		ingestSuccess(rebalSuccess, SpendIntent.REBALANCE);
		ingestFailed(arbReverted);
		ingestFailed(rebalReverted);

		const totals: TokenTotals[] = [];
		for (const [token, bucket] of buckets) {
			const byIntent: TokenIntentSpend[] = [];
			let successUsd = 0;
			let successTxCount = 0;
			for (const intent of [SpendIntent.ARBITRAGE, SpendIntent.REBALANCE]) {
				const entry = bucket.successByIntent.get(intent);
				if (!entry || entry.txCount === 0) continue;
				byIntent.push({ intent, usdAmount: this.round(entry.usdAmount), txCount: entry.txCount });
				successUsd += entry.usdAmount;
				successTxCount += entry.txCount;
			}
			totals.push({
				token,
				usdTotal: this.round(successUsd + bucket.failedUsd),
				txCount: successTxCount + bucket.failedTxCount,
				byIntent,
				failedUsd: this.round(bucket.failedUsd),
				failedTxCount: bucket.failedTxCount
			});
		}
		totals.sort((a, b) => b.usdTotal - a.usdTotal || a.token.localeCompare(b.token));
		return totals;
	}

	private aggregateByNativeToken(
		arbAll: SpendRecord[],
		rebalAll: SpendRecord[],
		unattributed: UnattributedSpendRecord[]
	): NativeTokenTotals[] {
		const buckets = new Map<
			TokenSymbol,
			{ decimals: number; native: bigint; usd: number; hasPriced: boolean; txCount: number }
		>();
		const ingest = (items: { network: Network; nativeAmount: string; usdAmount: number | null }[]): void => {
			for (const item of items) {
				const meta = this.resolveNativeMeta(item.network);
				const bucket = buckets.get(meta.symbol) ?? {
					decimals: meta.decimals,
					native: 0n,
					usd: 0,
					hasPriced: false,
					txCount: 0
				};
				bucket.native += BigInt(item.nativeAmount);
				if (item.usdAmount !== null) {
					bucket.usd += item.usdAmount;
					bucket.hasPriced = true;
				}
				bucket.txCount++;
				buckets.set(meta.symbol, bucket);
			}
		};
		ingest(arbAll);
		ingest(rebalAll);
		ingest(unattributed);

		const totals: NativeTokenTotals[] = [];
		for (const [nativeSymbol, bucket] of buckets) {
			totals.push({
				nativeSymbol,
				nativeDecimals: bucket.decimals,
				nativeAmount: bucket.native.toString(),
				usdAmount: bucket.hasPriced ? this.round(bucket.usd) : null,
				txCount: bucket.txCount
			});
		}
		totals.sort((a, b) => {
			const aUsd = a.usdAmount ?? -1;
			const bUsd = b.usdAmount ?? -1;
			return bUsd - aUsd || a.nativeSymbol.localeCompare(b.nativeSymbol);
		});
		return totals;
	}

	private emptyNetworkBucket(): NetworkAccumulator {
		return { native: 0n, usd: 0, hasPriced: false, txCount: 0, tokens: new Map() };
	}

	private compareUsd(a: number | null, b: number | null, aKey: string, bKey: string): number {
		if (a === null && b === null) return aKey.localeCompare(bKey);
		if (a === null) return 1;
		if (b === null) return -1;
		return b - a;
	}

	private resolveNativeMeta(network: Network): { symbol: TokenSymbol; decimals: number } {
		const evm = evmChainMetadata[network];
		if (evm) return { symbol: evm.nativeSymbol, decimals: evm.nativeDecimals };
		const svm = svmChainMetadata[network];
		if (svm) return { symbol: svm.nativeSymbol, decimals: svm.nativeDecimals };
		throw new Error(`[native-spend stats] no chain metadata for network ${network}`);
	}

	private round(value: number): number {
		return Math.round(value * 100) / 100;
	}
}

export { StatsCalculatorService };
