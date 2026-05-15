import {
	IntentNetworkSpend,
	IntentNetworkTokenSpend,
	IntentTotals,
	Network,
	SpendRecord,
	SpendStatus,
	TokenSymbol
} from "../../types";
import { compareUsdDescending, escapeHtml, formatCostUsd, resolveNativeMeta, roundUsd2 } from "../../utils";
import { formatAmount } from "../../utils/decimals";

const BLOCKQUOTE_OPEN = "<blockquote expandable>";
const BLOCKQUOTE_CLOSE = "</blockquote>";

interface NetworkAggregate {
	usdTotal: number;
	hasPricedRecord: boolean;
	totalTxCount: number;
	successUsd: number;
	successTxCount: number;
	failedUsd: number;
	failedTxCount: number;
	byNetwork: IntentNetworkSpend[];
}

// Roll-up shaped like stats-calculator's IntentTotals; reused for per-token + rebalance
// blocks that render BEFORE grand totals. byNetwork[*].usdAmount/txCount/byToken cover
// SUCCESS records; revertedUsd/revertedTxCount cover REVERTED in that (intent, chain).
function aggregateRecordsByNetwork(records: SpendRecord[]): NetworkAggregate {
	const buckets = new Map<
		Network,
		{
			native: bigint;
			successUsd: number;
			successHasPriced: boolean;
			successTxCount: number;
			tokens: Map<TokenSymbol, { native: bigint; usd: number; hasPriced: boolean; txCount: number }>;
			revertedUsd: number;
			revertedTxCount: number;
		}
	>();
	let successUsd = 0;
	let failedUsd = 0;
	let successTxCount = 0;
	let failedTxCount = 0;
	let anyPriced = false;
	for (const record of records) {
		const bucket = buckets.get(record.network) ?? {
			native: 0n,
			successUsd: 0,
			successHasPriced: false,
			successTxCount: 0,
			tokens: new Map(),
			revertedUsd: 0,
			revertedTxCount: 0
		};
		bucket.native += BigInt(record.nativeAmount);
		if (record.usdAmount !== null) anyPriced = true;
		if (record.status === SpendStatus.SUCCESS) {
			if (record.usdAmount !== null) {
				bucket.successUsd += record.usdAmount;
				bucket.successHasPriced = true;
				successUsd += record.usdAmount;
			}
			bucket.successTxCount++;
			successTxCount++;
			const tokenBucket = bucket.tokens.get(record.token) ?? { native: 0n, usd: 0, hasPriced: false, txCount: 0 };
			tokenBucket.native += BigInt(record.nativeAmount);
			if (record.usdAmount !== null) {
				tokenBucket.usd += record.usdAmount;
				tokenBucket.hasPriced = true;
			}
			tokenBucket.txCount++;
			bucket.tokens.set(record.token, tokenBucket);
		} else {
			bucket.revertedUsd += record.usdAmount ?? 0;
			bucket.revertedTxCount++;
			failedUsd += record.usdAmount ?? 0;
			failedTxCount++;
		}
		buckets.set(record.network, bucket);
	}
	const byNetwork: IntentNetworkSpend[] = [];
	for (const [network, bucket] of buckets) {
		const meta = resolveNativeMeta(network);
		const tokens = [...bucket.tokens.entries()].map(([token, t]) => ({
			token,
			nativeAmount: t.native.toString(),
			usdAmount: t.hasPriced ? roundUsd2(t.usd) : null,
			txCount: t.txCount
		}));
		tokens.sort((leftToken, rightToken) =>
			compareUsdDescending(leftToken.usdAmount, rightToken.usdAmount, leftToken.token, rightToken.token)
		);
		byNetwork.push({
			network,
			nativeAmount: bucket.native.toString(),
			nativeSymbol: meta.symbol,
			nativeDecimals: meta.decimals,
			usdAmount: bucket.successHasPriced ? roundUsd2(bucket.successUsd) : null,
			txCount: bucket.successTxCount,
			byToken: tokens,
			revertedUsd: roundUsd2(bucket.revertedUsd),
			revertedTxCount: bucket.revertedTxCount
		});
	}
	byNetwork.sort((leftEntry, rightEntry) => {
		const leftTotal = (leftEntry.usdAmount ?? 0) + leftEntry.revertedUsd;
		const rightTotal = (rightEntry.usdAmount ?? 0) + rightEntry.revertedUsd;
		return rightTotal - leftTotal || leftEntry.network.localeCompare(rightEntry.network);
	});
	return {
		usdTotal: roundUsd2(successUsd + failedUsd),
		hasPricedRecord: anyPriced,
		totalTxCount: successTxCount + failedTxCount,
		successUsd: roundUsd2(successUsd),
		successTxCount,
		failedUsd: roundUsd2(failedUsd),
		failedTxCount,
		byNetwork
	};
}

// Native amount first (with ticker) so the line is readable even when USD is missing.
// Chain row shows total (success + reverted). Nested success/Failed split only when
// reverted > 0. Token sub-lines apply to success only.
function formatIntentNetworkLines(
	networks: IntentNetworkSpend[],
	showSubTokens: boolean,
	successLabel: string
): string[] {
	const lines: string[] = [];
	for (let index = 0; index < networks.length; index++) {
		const entry = networks[index];
		const native = `${formatAmount(BigInt(entry.nativeAmount), entry.nativeDecimals)} ${entry.nativeSymbol}`;
		const totalUsd = (entry.usdAmount ?? 0) + entry.revertedUsd;
		const hasPriced = entry.usdAmount !== null || entry.revertedUsd > 0;
		const totalTxCount = entry.txCount + entry.revertedTxCount;
		const usdPart = hasPriced ? ` (${formatCostUsd(totalUsd)})` : "";
		lines.push(`  ${entry.network}: ${native}${usdPart}  ·  ${totalTxCount} tx`);
		if (entry.revertedTxCount > 0) {
			const successUsd = entry.usdAmount ?? 0;
			lines.push(`    ${successLabel}: ${formatCostUsd(successUsd)}  ·  ${entry.txCount} tx`);
			lines.push(`    Failed: ${formatCostUsd(entry.revertedUsd)}  ·  ${entry.revertedTxCount} tx`);
		}
		if (showSubTokens) {
			for (const tokenEntry of entry.byToken) {
				const tokenNative = `${formatAmount(BigInt(tokenEntry.nativeAmount), entry.nativeDecimals)} ${entry.nativeSymbol}`;
				const tokenUsd = tokenEntry.usdAmount === null ? "" : ` (${formatCostUsd(tokenEntry.usdAmount)})`;
				lines.push(`    ${tokenEntry.token}: ${tokenNative}${tokenUsd}  ·  ${tokenEntry.txCount} tx`);
			}
		}
		if (index < networks.length - 1) lines.push("");
	}
	return lines;
}

function buildIntentNetworkBlock(
	title: string,
	intent: IntentTotals,
	showSubTokens: boolean,
	successLabel: string
): string | null {
	if (intent.byNetwork.length === 0) return null;
	const lines = formatIntentNetworkLines(intent.byNetwork, showSubTokens, successLabel);
	return `${BLOCKQUOTE_OPEN}${title}\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

// Group rebalance records bridge → network → token. Three-level nesting keeps the
// readout legible when a single network has multiple tokens under one bridge.
function formatBridgeLines(records: SpendRecord[]): string[] {
	interface TokenCombo {
		token: TokenSymbol;
		native: bigint;
		usd: number;
		hasPriced: boolean;
		count: number;
	}
	interface NetworkGroup {
		network: Network;
		usd: number;
		count: number;
		hasPriced: boolean;
		tokens: Map<TokenSymbol, TokenCombo>;
	}
	interface BridgeBucket {
		usd: number;
		count: number;
		hasPriced: boolean;
		networks: Map<Network, NetworkGroup>;
	}

	const bridgeBuckets = new Map<string, BridgeBucket>();
	for (const record of records) {
		if (!record.bridge) continue;
		let bucket = bridgeBuckets.get(record.bridge);
		if (!bucket) {
			bucket = { usd: 0, count: 0, hasPriced: false, networks: new Map() };
			bridgeBuckets.set(record.bridge, bucket);
		}
		if (record.usdAmount !== null) {
			bucket.usd += record.usdAmount;
			bucket.hasPriced = true;
		}
		bucket.count++;

		let networkGroup = bucket.networks.get(record.network);
		if (!networkGroup) {
			networkGroup = { network: record.network, usd: 0, count: 0, hasPriced: false, tokens: new Map() };
			bucket.networks.set(record.network, networkGroup);
		}
		if (record.usdAmount !== null) {
			networkGroup.usd += record.usdAmount;
			networkGroup.hasPriced = true;
		}
		networkGroup.count++;

		let combo = networkGroup.tokens.get(record.token);
		if (!combo) {
			combo = { token: record.token, native: 0n, usd: 0, hasPriced: false, count: 0 };
			networkGroup.tokens.set(record.token, combo);
		}
		combo.native += BigInt(record.nativeAmount);
		if (record.usdAmount !== null) {
			combo.usd += record.usdAmount;
			combo.hasPriced = true;
		}
		combo.count++;
	}

	const sortedBridges = [...bridgeBuckets.entries()].sort((a, b) => b[1].usd - a[1].usd);
	const lines: string[] = [];
	for (let bridgeIndex = 0; bridgeIndex < sortedBridges.length; bridgeIndex++) {
		const [bridge, bucket] = sortedBridges[bridgeIndex];
		const usd = bucket.hasPriced ? formatCostUsd(bucket.usd) : "—";
		lines.push(`  ${bridge}: ${usd}  ·  ${bucket.count} tx`);
		const sortedNetworks = [...bucket.networks.values()].sort(
			(a, b) => (b.hasPriced ? b.usd : -1) - (a.hasPriced ? a.usd : -1)
		);
		for (const networkGroup of sortedNetworks) {
			lines.push(`    ${networkGroup.network}`);
			const meta = resolveNativeMeta(networkGroup.network);
			const sortedCombos = [...networkGroup.tokens.values()].sort(
				(a, b) => (b.hasPriced ? b.usd : -1) - (a.hasPriced ? a.usd : -1)
			);
			for (const combo of sortedCombos) {
				const native = `${formatAmount(combo.native, meta.decimals)} ${meta.symbol}`;
				const usdPart = combo.hasPriced ? ` (${formatCostUsd(combo.usd)})` : "";
				lines.push(`      ${combo.token}: ${native}${usdPart}  ·  ${combo.count} tx`);
			}
		}
		if (bridgeIndex < sortedBridges.length - 1) lines.push("");
	}
	return lines;
}

function buildFailuresBlock(failureLines: string[], title: string): string {
	return `${BLOCKQUOTE_OPEN}${title}\n${failureLines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function formatScanFailureLine(prefix: string, network: Network, detail: string): string {
	return `  ${prefix} · ${network}: ${escapeHtml(detail)}`;
}

export {
	BLOCKQUOTE_OPEN,
	BLOCKQUOTE_CLOSE,
	aggregateRecordsByNetwork,
	formatIntentNetworkLines,
	buildIntentNetworkBlock,
	formatBridgeLines,
	buildFailuresBlock,
	formatScanFailureLine
};
