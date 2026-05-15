import { isStableSymbol } from "../../config";
import {
	DailyTotals,
	FailedTotals,
	NativeSpendSnapshot,
	ProfitSnapshot,
	RouteStats,
	SpendRecord,
	SpendStatus,
	TokenDayCard,
	TokenProfitEntry,
	TokenProfitStatistics,
	TokenSymbol,
	UnmatchedStats
} from "../../types";
import {
	escapeHtml,
	formatCostUsd,
	formatDuration,
	formatTokenAmount,
	formatUsd,
	formatUsdSigned,
	formatWindowEdge,
	roundUsd2
} from "../../utils";
import { formatAmount } from "../../utils/decimals";
import {
	BLOCKQUOTE_CLOSE,
	BLOCKQUOTE_OPEN,
	aggregateRecordsByNetwork,
	buildFailuresBlock,
	buildIntentNetworkBlock,
	formatBridgeLines,
	formatIntentNetworkLines,
	formatScanFailureLine
} from "./spend-aggregators";

function renderTokenCard(card: TokenDayCard): string {
	const windowLine = `${formatWindowEdge(card.window.fromIso)} → ${formatWindowEdge(card.window.toIso)} UTC`;
	const sections: string[] = [];

	sections.push(`💰 <b>${card.token}</b>\n<i>Window: ${windowLine}</i>`);
	sections.push(buildTokenCardHeader(card));

	const imbalanceLines = buildPositionImbalanceLines(card.profit.stats.unmatchedStats);
	if (imbalanceLines) sections.push(imbalanceLines);

	const profitBlock = buildProfitDetailsBlock(card.profit.stats);
	if (profitBlock) sections.push(profitBlock);

	if (card.profit.stats.byRoute.length > 0) {
		sections.push(buildRoutesBlock(card.profit.stats.byRoute, "🔀 <b>Routes</b>"));
	}

	// Visual break: profit-side (above) vs native-cost-side (below).
	const arbBlock = buildArbNetworkBlock(card.arbSpend.records);
	const hasRebalance = card.rebalanceRecords.length > 0;
	if (arbBlock || hasRebalance) {
		sections.push(NATIVE_SECTION_DIVIDER);
	}
	if (arbBlock) sections.push(arbBlock);

	if (hasRebalance) {
		const successRecords = card.rebalanceRecords.filter((record) => record.status === SpendStatus.SUCCESS);
		const failedRecords = card.rebalanceRecords.filter((record) => record.status === SpendStatus.REVERTED);

		const bridgeLines = formatBridgeLines(successRecords);
		if (bridgeLines.length > 0) {
			sections.push(`${BLOCKQUOTE_OPEN}🔄 <b>Rebalance by bridge</b>\n\n${bridgeLines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const failedBridgeLines = formatBridgeLines(failedRecords);
		if (failedBridgeLines.length > 0) {
			sections.push(
				`${BLOCKQUOTE_OPEN}🚨 <b>Rebalance failed by bridge</b>\n\n${failedBridgeLines.join("\n")}${BLOCKQUOTE_CLOSE}`
			);
		}
	}

	const failureLines: string[] = [];
	for (const failure of card.profit.scanFailures) {
		failureLines.push(formatScanFailureLine("profit", failure.network, failure.detail));
	}
	for (const failure of card.arbSpend.scanFailures) {
		failureLines.push(formatScanFailureLine(`arb · ${failure.intent}`, failure.network, failure.detail));
	}
	if (failureLines.length > 0) {
		sections.push(buildFailuresBlock(failureLines, "🚨 <b>Scan failures — data is INCOMPLETE</b>"));
	}

	sections.push(`<i>Duration: ${formatDuration(card.durationMs)}</i>`);
	return sections.join("\n\n");
}

const NATIVE_SECTION_DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━";

function buildTokenCardHeader(card: TokenDayCard): string {
	const arbTotalUsd = card.arbSuccessUsd + card.arbFailedUsd;
	const arbTotalTx = card.arbSuccessTxCount + card.arbFailedTxCount;
	const rebalanceTotalUsd = card.rebalanceSuccessUsd + card.rebalanceFailedUsd;
	const rebalanceTotalTx = card.rebalanceSuccessTxCount + card.rebalanceFailedTxCount;

	const arbTxPart = card.arbFailedTxCount > 0
		? `(${arbTotalTx} tx, ${card.arbFailedTxCount} failed)`
		: `(${arbTotalTx} tx)`;
	const rebalanceTxPart = card.rebalanceFailedTxCount > 0
		? `(${rebalanceTotalTx} tx, ${card.rebalanceFailedTxCount} failed)`
		: `(${rebalanceTotalTx} tx)`;

	return [
		`💰 Gross profit:   <b>${formatUsdSigned(card.grossProfitUsd)}</b>`,
		`💸 Arb native:      ${formatCostUsd(arbTotalUsd)}   ${arbTxPart}`,
		`🔄 Rebalance:       ${formatCostUsd(rebalanceTotalUsd)}   ${rebalanceTxPart}`,
		`─────────────────────────`,
		`🏆 Net:            <b>${formatUsdSigned(card.netUsd)}</b>`
	].join("\n");
}

function buildPositionImbalanceLines(unmatched: UnmatchedStats): string | null {
	if (unmatched.closing.action === "NONE" || !unmatched.targetToken) return null;
	const netSign = unmatched.netTarget > 0 ? "+" : "";
	return [
		`⚖️ <b>Position imbalance</b>: ${netSign}${formatTokenAmount(unmatched.netTarget)} ${unmatched.targetToken}  (avg ${formatUsd(unmatched.closing.breakEvenPrice)})`,
		`   Bought ${formatTokenAmount(unmatched.targetBought)} · Sold ${formatTokenAmount(unmatched.targetSold)}`
	].join("\n");
}

function buildProfitDetailsBlock(stats: TokenProfitStatistics): string {
	const lines: string[] = [];
	lines.push(
		`  Trades: ${stats.totals.transactions} · Matched: ${stats.totals.matchedPairs} · Unmatched: ${stats.totals.unmatched} · Rate: ${stats.totals.matchRate}`
	);
	lines.push(
		`  Avg ${formatUsd(stats.profit.avg)} · Median ${formatUsd(stats.profit.median)} · Min ${formatUsd(stats.profit.min)} · Max ${formatUsd(stats.profit.max)}`
	);
	if (stats.bestArbitrage) {
		lines.push(`  Best: ${formatUsd(stats.bestArbitrage.profit)} · ${escapeHtml(stats.bestArbitrage.route)}`);
	}
	if (stats.worstArbitrage) {
		lines.push(`  Worst: ${formatUsd(stats.worstArbitrage.profit)} · ${escapeHtml(stats.worstArbitrage.route)}`);
	}
	return `${BLOCKQUOTE_OPEN}📈 <b>Profit details</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function buildRoutesBlock(routes: RouteStats[], title: string): string {
	const lines = routes.map(
		(route) => `  ${escapeHtml(route.route)}: ${route.count}× · ${formatUsd(route.totalProfit)}`
	);
	return `${BLOCKQUOTE_OPEN}${title}\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function buildArbNetworkBlock(records: SpendRecord[]): string | null {
	if (records.length === 0) return null;
	const aggregate = aggregateRecordsByNetwork(records);
	const lines = formatIntentNetworkLines(aggregate.byNetwork, false, "Arbitrage");
	if (lines.length === 0) return null;
	return `${BLOCKQUOTE_OPEN}💸 <b>Arb native by network</b>\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function renderDailyTotal(totals: DailyTotals): string {
	const windowLine = `${formatWindowEdge(totals.window.fromIso)} → ${formatWindowEdge(totals.window.toIso)} UTC`;
	const sections: string[] = [];

	sections.push(`🏁 <b>Daily P&amp;L</b> — ${totals.date}\n<i>Window: ${windowLine}</i>`);
	sections.push(buildDailyTotalHeader(totals));

	const profitStatsBlock = buildProfitStatsBlock(totals.profitSnapshot);
	if (profitStatsBlock) sections.push(profitStatsBlock);

	const topRoutesBlock = buildTopRoutesBlock(totals.profitSnapshot);
	if (topRoutesBlock) sections.push(topRoutesBlock);

	const nativeByTokenBlock = buildNativeByTokenBlock(totals.nativeSpendSnapshot);
	if (nativeByTokenBlock) sections.push(nativeByTokenBlock);

	const arbByNetworkBlock = totals.nativeSpendSnapshot.grandTotals
		? buildIntentNetworkBlock("💸 <b>Arbitrage — by network</b>", totals.nativeSpendSnapshot.grandTotals.arbitrage, false, "Arbitrage")
		: null;
	if (arbByNetworkBlock) sections.push(arbByNetworkBlock);

	const rebalanceByNetworkBlock = totals.nativeSpendSnapshot.grandTotals
		? buildIntentNetworkBlock("🔄 <b>Rebalance — by network</b>", totals.nativeSpendSnapshot.grandTotals.rebalance, true, "Rebalance")
		: null;
	if (rebalanceByNetworkBlock) sections.push(rebalanceByNetworkBlock);

	const activityBlock = buildActivityByNetworkBlock(totals.profitSnapshot);
	if (activityBlock) sections.push(activityBlock);

	const failedBlock = totals.nativeSpendSnapshot.grandTotals
		? buildFailedBreakdownBlock(totals.nativeSpendSnapshot.grandTotals.failed)
		: null;
	if (failedBlock) sections.push(failedBlock);

	const scanFailures = collectAllScanFailures(totals.profitSnapshot, totals.nativeSpendSnapshot);
	if (scanFailures.length > 0) {
		sections.push(buildFailuresBlock(scanFailures, "🚨 <b>Scan failures — totals are PARTIAL</b>"));
	}

	sections.push(`<i>Duration: ${formatDuration(totals.totalDurationMs)}</i>`);
	return sections.join("\n\n");
}

function buildDailyTotalHeader(totals: DailyTotals): string {
	const lines: string[] = [];

	let tradingNet = 0;
	if (totals.tokenCards.length > 0) {
		lines.push(`<b>By token (net):</b>`);
		for (const card of totals.tokenCards) {
			const arbAndRebalance = card.arbSuccessUsd + card.arbFailedUsd + card.rebalanceSuccessUsd + card.rebalanceFailedUsd;
			const failedUsd = card.arbFailedUsd + card.rebalanceFailedUsd;
			const gross = `gross ${formatUsdSigned(card.grossProfitUsd)}`;
			const native = `native ${formatCostUsd(arbAndRebalance)}`;
			const failedPart = failedUsd > 0 ? ` · failed ${formatCostUsd(failedUsd)}` : "";
			lines.push(`  ${card.token}: ${formatUsdSigned(card.netUsd)}  (${gross}, ${native}${failedPart})`);
			tradingNet += card.netUsd;
		}
		lines.push(`  ─────────────────`);
		lines.push(`  Trading net:    <b>${formatUsdSigned(tradingNet)}</b>`);
	}

	const stableByToken = aggregateStableRebalance(totals.rebalanceStableRecords);
	let stablesNet = 0;
	if (stableByToken.length > 0) {
		lines.push("");
		lines.push(`<b>Stable rebalances (unattributable):</b>`);
		for (const stable of stableByToken) {
			const totalUsd = stable.successUsd + stable.failedUsd;
			const txCount = stable.successTxCount + stable.failedTxCount;
			lines.push(`  ${stable.token}: ${formatCostUsd(totalUsd)}  (${txCount} tx)`);
			stablesNet -= totalUsd;
		}
		lines.push(`  ─────────────────`);
		lines.push(`  Stables net:    <b>${formatUsdSigned(stablesNet)}</b>`);
	}

	const failed = totals.nativeSpendSnapshot.grandTotals?.failed;
	const unattributedUsd = failed?.byType.unattributed.usdAmount ?? 0;
	const unattributedTxCount = failed?.byType.unattributed.txCount ?? 0;
	let unattributedNet = 0;
	if (unattributedTxCount > 0) {
		lines.push("");
		lines.push(`<b>Unattributed failed:</b>  ${formatCostUsd(unattributedUsd)}  (${unattributedTxCount} tx)`);
		unattributedNet -= unattributedUsd;
	}

	const grandNet = tradingNet + stablesNet + unattributedNet;
	lines.push("");
	lines.push(`═════════════════════════`);
	lines.push(`🏆 <b>Grand net:  ${formatUsdSigned(grandNet)}</b>`);
	return lines.join("\n");
}

interface StableTokenAggregate {
	token: TokenSymbol;
	successUsd: number;
	successTxCount: number;
	failedUsd: number;
	failedTxCount: number;
}

function aggregateStableRebalance(records: SpendRecord[]): StableTokenAggregate[] {
	const buckets = new Map<TokenSymbol, StableTokenAggregate>();
	for (const record of records) {
		if (!isStableSymbol(record.token)) continue;
		const bucket = buckets.get(record.token) ?? {
			token: record.token,
			successUsd: 0,
			successTxCount: 0,
			failedUsd: 0,
			failedTxCount: 0
		};
		if (record.status === SpendStatus.SUCCESS) {
			bucket.successUsd += record.usdAmount ?? 0;
			bucket.successTxCount++;
		} else {
			bucket.failedUsd += record.usdAmount ?? 0;
			bucket.failedTxCount++;
		}
		buckets.set(record.token, bucket);
	}
	return [...buckets.values()].sort(
		(a, b) => (b.successUsd + b.failedUsd) - (a.successUsd + a.failedUsd) || a.token.localeCompare(b.token)
	);
}

function buildProfitStatsBlock(snapshot: ProfitSnapshot): string | null {
	const totals = snapshot.grandTotals;
	if (!totals) return null;
	const lines = [
		`  Transactions: ${totals.totalTransactions}`,
		`  Matched: ${totals.totalMatched}`,
		`  Unmatched: ${totals.totalUnmatched}`,
		`  Match rate: ${totals.overallMatchRate}`
	];
	return `${BLOCKQUOTE_OPEN}🧾 <b>Stats</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function buildTopRoutesBlock(snapshot: ProfitSnapshot): string | null {
	const totals = snapshot.grandTotals;
	if (!totals || totals.byRoute.length === 0) return null;
	const top = totals.byRoute.slice(0, 8);
	return buildRoutesBlock(top, "🔀 <b>Top routes</b>");
}

function buildActivityByNetworkBlock(snapshot: ProfitSnapshot): string | null {
	const totals = snapshot.grandTotals;
	if (!totals || totals.byNetwork.length === 0) return null;
	const lines = totals.byNetwork.map(
		(network) => `  ${network.network}: ${network.totalCount}× (in ${network.inputCount} / out ${network.outputCount})`
	);
	return `${BLOCKQUOTE_OPEN}🌐 <b>Activity by network</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function buildNativeByTokenBlock(snapshot: NativeSpendSnapshot): string | null {
	const totals = snapshot.grandTotals;
	if (!totals || totals.byNativeToken.length === 0) return null;
	const lines: string[] = [];
	for (const entry of totals.byNativeToken) {
		const native = `${formatAmount(BigInt(entry.nativeAmount), entry.nativeDecimals)} ${entry.nativeSymbol}`;
		const usdPart = entry.usdAmount === null ? "" : ` (${formatCostUsd(entry.usdAmount)})`;
		lines.push(`  ${entry.nativeSymbol}: ${native}${usdPart}`);
	}
	return `${BLOCKQUOTE_OPEN}🪙 <b>Native by token</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function buildFailedBreakdownBlock(failed: FailedTotals): string | null {
	if (failed.txCount === 0) return null;
	const lines: string[] = [];
	lines.push(`  By type:`);
	lines.push(`    Arbitrage: ${formatCostUsd(failed.byType.arbitrage.usdAmount)}  ·  ${failed.byType.arbitrage.txCount} tx`);
	lines.push(`    Rebalance: ${formatCostUsd(failed.byType.rebalance.usdAmount)}  ·  ${failed.byType.rebalance.txCount} tx`);
	lines.push(`    Unattributed: ${formatCostUsd(failed.byType.unattributed.usdAmount)}  ·  ${failed.byType.unattributed.txCount} tx`);
	if (failed.byNetwork.length > 0) {
		lines.push("");
		lines.push(`  By chain:`);
		for (const entry of failed.byNetwork) {
			lines.push(`    ${entry.network}: ${formatCostUsd(entry.usdAmount)}  ·  ${entry.txCount} tx`);
		}
	}
	return `${BLOCKQUOTE_OPEN}🚨 <b>Failed breakdown</b>\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
}

function collectAllScanFailures(profit: ProfitSnapshot, nativeSpend: NativeSpendSnapshot): string[] {
	const lines: string[] = [];
	for (const entry of Object.values(profit.perToken)) {
		if (!entry) continue;
		for (const failure of entry.scanFailures) {
			lines.push(formatScanFailureLine(`profit · ${entry.token}`, failure.network, failure.detail));
		}
	}
	for (const entry of Object.values(nativeSpend.arbSpend.perToken)) {
		if (!entry) continue;
		for (const failure of entry.scanFailures) {
			lines.push(formatScanFailureLine(`arb · ${entry.token} · ${failure.intent}`, failure.network, failure.detail));
		}
	}
	if (nativeSpend.rebalanceSpend) {
		for (const failure of nativeSpend.rebalanceSpend.scanFailures) {
			lines.push(formatScanFailureLine(`rebalance · ${failure.intent}`, failure.network, failure.detail));
		}
	}
	if (nativeSpend.unattributedSpend) {
		for (const failure of nativeSpend.unattributedSpend.scanFailures) {
			lines.push(formatScanFailureLine(`unattributed · ${failure.intent}`, failure.network, failure.detail));
		}
	}
	return lines;
}

// Map a per-token TokenProfitEntry + per-token TokenArbSpendEntry + the
// token's slice of the global rebalance into the merged TokenDayCard the
// renderer consumes. Costs (arb + rebalance) are subtracted from gross to
// produce the always-visible Net line on the card.
function buildTokenDayCard(args: {
	token: TokenSymbol;
	window: TokenDayCard["window"];
	profit: TokenProfitEntry;
	arbSpend: TokenDayCard["arbSpend"];
	rebalanceRecords: SpendRecord[];
	durationMs: number;
}): TokenDayCard {
	const arbSuccessUsd = sumUsd(args.arbSpend.records, SpendStatus.SUCCESS);
	const arbFailedUsd = sumUsd(args.arbSpend.records, SpendStatus.REVERTED);
	const arbSuccessTxCount = countByStatus(args.arbSpend.records, SpendStatus.SUCCESS);
	const arbFailedTxCount = countByStatus(args.arbSpend.records, SpendStatus.REVERTED);

	const rebalanceSuccessUsd = sumUsd(args.rebalanceRecords, SpendStatus.SUCCESS);
	const rebalanceFailedUsd = sumUsd(args.rebalanceRecords, SpendStatus.REVERTED);
	const rebalanceSuccessTxCount = countByStatus(args.rebalanceRecords, SpendStatus.SUCCESS);
	const rebalanceFailedTxCount = countByStatus(args.rebalanceRecords, SpendStatus.REVERTED);

	const grossProfitUsd = args.profit.stats.profit.total;
	const totalCost = arbSuccessUsd + arbFailedUsd + rebalanceSuccessUsd + rebalanceFailedUsd;
	const netUsd = grossProfitUsd - totalCost;

	return {
		token: args.token,
		window: args.window,
		profit: args.profit,
		arbSpend: args.arbSpend,
		rebalanceRecords: args.rebalanceRecords,
		grossProfitUsd: roundUsd2(grossProfitUsd),
		arbSuccessUsd: roundUsd2(arbSuccessUsd),
		arbFailedUsd: roundUsd2(arbFailedUsd),
		arbSuccessTxCount,
		arbFailedTxCount,
		rebalanceSuccessUsd: roundUsd2(rebalanceSuccessUsd),
		rebalanceFailedUsd: roundUsd2(rebalanceFailedUsd),
		rebalanceSuccessTxCount,
		rebalanceFailedTxCount,
		netUsd: roundUsd2(netUsd),
		durationMs: args.durationMs
	};
}

function sumUsd(records: SpendRecord[], status: SpendStatus): number {
	return records.filter((record) => record.status === status).reduce((sum, record) => sum + (record.usdAmount ?? 0), 0);
}

function countByStatus(records: SpendRecord[], status: SpendStatus): number {
	return records.filter((record) => record.status === status).length;
}

export { renderTokenCard, renderDailyTotal, buildTokenDayCard };
