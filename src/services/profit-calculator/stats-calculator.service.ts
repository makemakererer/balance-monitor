import { Network, TokenSymbol } from "../../types";
import {
	ArbitrageExtreme,
	MatchResult,
	MatchedArbitrage,
	NetworkBreakdown,
	ParsedTransaction,
	ProfitWindow,
	RouteStats,
	StatsProfit,
	StatsTotals,
	TokenProfitStatistics,
	TypeRoute,
	UnmatchedBreakdown,
	UnmatchedStats
} from "../../types/profit-calculator.types";

const BALANCED_POSITION_THRESHOLD = 0.00001;

class StatsCalculatorService {
	public calculate(
		token: TokenSymbol,
		window: ProfitWindow,
		transactions: ParsedTransaction[],
		matchResult: MatchResult
	): TokenProfitStatistics {
		const { matched, unmatched } = matchResult;
		const profits = matched.map((m) => m.profitAmount);
		const profitToken = this.resolveAggregateProfitToken(matched);

		return {
			period: { fromIso: window.fromIso, toIso: window.toIso },
			token,
			totals: this.calculateTotals(transactions.length, matched.length, unmatched.length),
			profit: this.calculateProfit(profits, profitToken),
			bestArbitrage: this.findBestArbitrage(matched),
			worstArbitrage: this.findWorstArbitrage(matched),
			byRoute: this.calculateByRoute(matched),
			byNetwork: this.calculateByNetwork(transactions),
			unmatched: this.calculateUnmatched(unmatched),
			unmatchedStats: this.calculateUnmatchedStats(unmatched)
		};
	}

	private resolveAggregateProfitToken(matched: MatchedArbitrage[]): TokenSymbol {
		if (matched.length === 0) return TokenSymbol.USDC;
		const tokens = new Set(matched.map((m) => m.profitToken));
		return tokens.size === 1 ? matched[0].profitToken : TokenSymbol.USD;
	}

	private calculateTotals(totalTx: number, matchedCount: number, unmatchedCount: number): StatsTotals {
		const matchRate = totalTx > 0 ? ((matchedCount * 2) / totalTx) * 100 : 0;
		return {
			transactions: totalTx,
			matchedPairs: matchedCount,
			unmatched: unmatchedCount,
			matchRate: matchRate.toFixed(1) + "%"
		};
	}

	private calculateProfit(profits: number[], profitToken: TokenSymbol): StatsProfit {
		if (profits.length === 0) {
			return { profitToken, total: 0, avg: 0, median: 0, min: 0, max: 0 };
		}

		const sorted = [...profits].sort((a, b) => a - b);
		const total = profits.reduce((sum, p) => sum + p, 0);
		const avg = total / profits.length;
		const mid = Math.floor(sorted.length / 2);
		const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

		return {
			profitToken,
			total: this.round(total),
			avg: this.round(avg),
			median: this.round(median),
			min: this.round(sorted[0]),
			max: this.round(sorted[sorted.length - 1])
		};
	}

	private findBestArbitrage(matched: MatchedArbitrage[]): ArbitrageExtreme | null {
		if (matched.length === 0) return null;
		const target = matched.reduce((best, current) => (current.profitAmount > best.profitAmount ? current : best));
		return this.toArbitrageExtreme(target);
	}

	private findWorstArbitrage(matched: MatchedArbitrage[]): ArbitrageExtreme | null {
		if (matched.length === 0) return null;
		const target = matched.reduce((worst, current) => (current.profitAmount < worst.profitAmount ? current : worst));
		return this.toArbitrageExtreme(target);
	}

	private toArbitrageExtreme(arb: MatchedArbitrage): ArbitrageExtreme {
		return {
			profit: this.round(arb.profitAmount),
			route: arb.route,
			inputHash: arb.input.hash,
			outputHash: arb.output.hash,
			timestamp: arb.input.timestamp
		};
	}

	private calculateByRoute(matched: MatchedArbitrage[]): RouteStats[] {
		const routeMap = new Map<string, number[]>();
		for (const m of matched) {
			const profits = routeMap.get(m.route) ?? [];
			profits.push(m.profitAmount);
			routeMap.set(m.route, profits);
		}

		const stats: RouteStats[] = [];
		for (const [route, profits] of routeMap) {
			const sorted = [...profits].sort((a, b) => a - b);
			const total = profits.reduce((sum, p) => sum + p, 0);
			stats.push({
				route,
				count: profits.length,
				totalProfit: this.round(total),
				avgProfit: this.round(total / profits.length),
				minProfit: this.round(sorted[0]),
				maxProfit: this.round(sorted[sorted.length - 1])
			});
		}

		return stats.sort((a, b) => b.totalProfit - a.totalProfit);
	}

	private calculateByNetwork(transactions: ParsedTransaction[]): NetworkBreakdown[] {
		const counts = new Map<Network, { inputCount: number; outputCount: number }>();
		for (const tx of transactions) {
			const entry = counts.get(tx.network) ?? { inputCount: 0, outputCount: 0 };
			if (tx.type === TypeRoute.SELL) entry.inputCount++;
			else entry.outputCount++;
			counts.set(tx.network, entry);
		}

		const breakdown: NetworkBreakdown[] = [];
		for (const [network, c] of counts) {
			breakdown.push({
				network,
				inputCount: c.inputCount,
				outputCount: c.outputCount,
				totalCount: c.inputCount + c.outputCount
			});
		}

		return breakdown.sort((a, b) => b.totalCount - a.totalCount);
	}

	private calculateUnmatched(unmatched: ParsedTransaction[]): UnmatchedBreakdown {
		const byType: Record<TypeRoute, number> = { [TypeRoute.SELL]: 0, [TypeRoute.BUY]: 0 };
		const byNetwork: Partial<Record<Network, number>> = {};

		for (const tx of unmatched) {
			byType[tx.type]++;
			byNetwork[tx.network] = (byNetwork[tx.network] ?? 0) + 1;
		}

		return { total: unmatched.length, byType, byNetwork };
	}

	private calculateUnmatchedStats(unmatched: ParsedTransaction[]): UnmatchedStats {
		let targetBought = 0;
		let targetSold = 0;
		let counterSpent = 0;
		let counterReceived = 0;
		let targetToken: TokenSymbol | null = null;
		let counterToken: TokenSymbol | null = null;

		for (const tx of unmatched) {
			if (tx.type === TypeRoute.BUY) {
				targetToken ??= tx.tokenOut;
				counterToken ??= tx.tokenIn;
				targetBought += parseFloat(tx.amountOut);
				counterSpent += parseFloat(tx.amountIn);
			} else {
				targetToken ??= tx.tokenIn;
				counterToken ??= tx.tokenOut;
				targetSold += parseFloat(tx.amountIn);
				counterReceived += parseFloat(tx.amountOut);
			}
		}

		const netTarget = targetBought - targetSold;
		const netCounter = counterReceived - counterSpent;
		const isPositionBalanced = Math.abs(netTarget) < BALANCED_POSITION_THRESHOLD;

		let action: "SELL" | "BUY" | "NONE" = "NONE";
		let quantity = 0;
		let breakEvenPrice = 0;

		if (!isPositionBalanced) {
			action = netTarget > 0 ? "SELL" : "BUY";
			quantity = Math.abs(netTarget);
			breakEvenPrice = Math.abs(netCounter / netTarget);
		}

		return {
			targetToken,
			counterToken,
			totalUnmatched: unmatched.length,
			targetBought: this.round(targetBought),
			targetSold: this.round(targetSold),
			netTarget: this.round(netTarget),
			counterSpent: this.round(counterSpent),
			counterReceived: this.round(counterReceived),
			netCounter: this.round(netCounter),
			closing: {
				action,
				quantity: this.round(quantity),
				breakEvenPrice: this.round(breakEvenPrice)
			}
		};
	}

	private round(value: number): number {
		return Math.round(value * 100000) / 100000;
	}
}

export { StatsCalculatorService };
