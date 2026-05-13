import { profitWindowSeconds, tradingTokens } from "../../config";
import {
	GrandTotalsByToken,
	MatchedArbitrage,
	NetworkBreakdown,
	ParsedTransaction,
	ProfitGrandTotals,
	ProfitSnapshot,
	ProfitWindow,
	RouteStats,
	TokenProfitEntry,
	TokenProfitStatistics,
	TokenSymbol,
	TypeRoute
} from "../../types";
import {
	log,
	profitSnapshotComplete,
	readProfitSnapshot,
	writeProfitSnapshot
} from "../../utils";
import { TelegramService } from "../telegram/telegram.service";
import { ArbitrageMatcherService } from "./arbitrage-matcher.service";
import { StatsCalculatorService } from "./stats-calculator.service";
import { CexArbitrageFetcher } from "./fetchers/cex-arbitrage.fetcher";
import { EvmArbitrageFetcher } from "./fetchers/evm-arbitrage.fetcher";
import { SvmArbitrageFetcher } from "./fetchers/svm-arbitrage.fetcher";

class ProfitCalculatorService {
	private readonly telegram = new TelegramService();
	private readonly evm = new EvmArbitrageFetcher();
	private readonly svm = new SvmArbitrageFetcher();
	private readonly cex = new CexArbitrageFetcher();
	private readonly matcher = new ArbitrageMatcherService();
	private readonly stats = new StatsCalculatorService();

	public async calculate(date: string): Promise<void> {
		if (profitSnapshotComplete(date)) {
			log.info(`profit-calc: snapshot for ${date} already complete, skipping`);
			return;
		}

		const window = this.buildWindow(date);
		const runStart = Date.now();
		log.important(`PROFIT-CALC: window ${window.fromIso} → ${window.toIso}`);

		const enabledTokens = (Object.keys(tradingTokens) as TokenSymbol[]).filter((token) => tradingTokens[token]);
		log.info(`profit-calc: ${enabledTokens.length} trading token(s): ${enabledTokens.join(", ")}`);

		try {
			await this.telegram.sendProfitCalcStart(window, enabledTokens);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram profit-calc start failed: ${message}`);
		}

		const snapshot = this.loadOrInitSnapshot(date, window);

		for (let index = 0; index < enabledTokens.length; index++) {
			const token = enabledTokens[index];
			const progress = `(${index + 1}/${enabledTokens.length})`;

			if (snapshot.perToken[token]) {
				log.info(`profit-calc: ${token} ${progress} already in snapshot, skipping`);
				continue;
			}

			log.important(`profit-calc: ${token} ${progress} starting`);
			try {
				await this.telegram.sendTokenProfitStart(token, index + 1);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`telegram token-profit-start ${token} failed: ${message}`);
			}
			const tokenStart = Date.now();
			const entry = await this.calculateForToken(token, window, tokenStart);
			snapshot.perToken[token] = entry;
			writeProfitSnapshot(snapshot);
			log.success(`profit-calc: ${token} ${progress} done in ${this.elapsed(tokenStart)}s`);

			try {
				await this.telegram.sendTokenProfitReport(entry);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`telegram token-profit ${token} failed: ${message}`);
			}
		}

		const grandTotals = this.computeGrandTotals(snapshot, Date.now() - runStart);
		snapshot.grandTotals = grandTotals;
		writeProfitSnapshot(snapshot);
		log.important(`PROFIT-CALC: done in ${this.elapsed(runStart)}s`);

		try {
			await this.telegram.sendProfitGrandTotals(snapshot);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram profit grand-totals failed: ${message}`);
		}

		try {
			await this.telegram.sendProfitSnapshotFile(date);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram profit snapshot file failed: ${message}`);
		}
	}

	private async calculateForToken(
		token: TokenSymbol,
		window: ProfitWindow,
		tokenStart: number
	): Promise<TokenProfitEntry> {
		const [evmResult, svmResult, cexResult] = await Promise.all([
			this.evm.fetchByToken(token, window),
			this.svm.fetchByToken(token, window),
			this.cex.fetchByToken(token, window)
		]);
		const transactions = [...evmResult.transactions, ...svmResult.transactions, ...cexResult.transactions];
		transactions.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
		const scanFailures = [...evmResult.failures, ...svmResult.failures, ...cexResult.failures];

		const matchResult = this.matcher.match(transactions);
		const stats = this.stats.calculate(token, window, transactions, matchResult);

		return {
			token,
			fetchedAt: new Date().toISOString(),
			durationMs: Date.now() - tokenStart,
			stats,
			matched: matchResult.matched,
			unmatched: matchResult.unmatched,
			scanFailures
		};
	}

	private loadOrInitSnapshot(date: string, window: ProfitWindow): ProfitSnapshot {
		const existing = readProfitSnapshot(date);
		if (existing && existing.grandTotals === null) {
			log.info(`profit-calc: resuming partial snapshot (${Object.keys(existing.perToken).length} token(s) already done)`);
			return existing;
		}
		return {
			date,
			generatedAt: new Date().toISOString(),
			window,
			perToken: {},
			grandTotals: null
		};
	}

	private buildWindow(date: string): ProfitWindow {
		const dayStartMs = Date.parse(`${date}T00:00:00Z`);
		if (Number.isNaN(dayStartMs)) throw new Error(`[profit-calc] invalid date: ${date}`);
		const toTimestampSeconds = Math.floor(dayStartMs / 1000);
		const fromTimestampSeconds = toTimestampSeconds - profitWindowSeconds;
		return {
			fromTimestampSeconds,
			toTimestampSeconds,
			fromIso: new Date(fromTimestampSeconds * 1000).toISOString(),
			toIso: new Date(toTimestampSeconds * 1000).toISOString()
		};
	}

	private computeGrandTotals(snapshot: ProfitSnapshot, durationMs: number): ProfitGrandTotals {
		const entries = Object.values(snapshot.perToken).filter((entry): entry is TokenProfitEntry => entry !== undefined);

		const byToken: GrandTotalsByToken[] = entries.map((entry) => ({
			token: entry.token,
			profitToken: entry.stats.profit.profitToken,
			total: entry.stats.profit.total,
			matchedPairs: entry.stats.totals.matchedPairs
		}));

		const allMatched: MatchedArbitrage[] = [];
		const allTransactions: ParsedTransaction[] = [];
		for (const entry of entries) {
			allMatched.push(...entry.matched);
			allTransactions.push(...entry.matched.flatMap((m) => [m.input, m.output]));
			allTransactions.push(...entry.unmatched);
		}

		const totalMatched = entries.reduce((sum, entry) => sum + entry.stats.totals.matchedPairs, 0);
		const totalUnmatched = entries.reduce((sum, entry) => sum + entry.stats.totals.unmatched, 0);
		const totalTransactions = entries.reduce((sum, entry) => sum + entry.stats.totals.transactions, 0);
		const overallMatchRate = totalTransactions > 0
			? (((totalMatched * 2) / totalTransactions) * 100).toFixed(1) + "%"
			: "0.0%";

		return {
			completedAt: new Date().toISOString(),
			durationMs,
			byToken,
			totalMatched,
			totalUnmatched,
			totalTransactions,
			overallMatchRate,
			byNetwork: this.aggregateByNetwork(allTransactions),
			byRoute: this.aggregateByRoute(allMatched)
		};
	}

	private aggregateByNetwork(transactions: ParsedTransaction[]): NetworkBreakdown[] {
		const counts = new Map<string, { inputCount: number; outputCount: number }>();
		for (const tx of transactions) {
			const entry = counts.get(tx.network) ?? { inputCount: 0, outputCount: 0 };
			if (tx.type === TypeRoute.SELL) entry.inputCount++;
			else entry.outputCount++;
			counts.set(tx.network, entry);
		}
		const breakdown: NetworkBreakdown[] = [];
		for (const [network, c] of counts) {
			breakdown.push({
				network: network as NetworkBreakdown["network"],
				inputCount: c.inputCount,
				outputCount: c.outputCount,
				totalCount: c.inputCount + c.outputCount
			});
		}
		return breakdown.sort((a, b) => b.totalCount - a.totalCount);
	}

	private aggregateByRoute(matched: MatchedArbitrage[]): RouteStats[] {
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

	private round(value: number): number {
		return Math.round(value * 100000) / 100000;
	}

	private elapsed(startMillis: number): string {
		return ((Date.now() - startMillis) / 1000).toFixed(1);
	}
}

export { ProfitCalculatorService };
