import { Network, TokenSymbol } from "./config.types";

enum TypeRoute {
	BUY = "BUY",
	SELL = "SELL"
}

interface ProfitWindow {
	fromTimestampSeconds: number;
	toTimestampSeconds: number;
	fromIso: string;
	toIso: string;
}

interface ParsedTransaction {
	hash: string;
	timestamp: string;
	network: Network;
	type: TypeRoute;
	tokenIn: TokenSymbol;
	tokenOut: TokenSymbol;
	amountIn: string;
	amountOut: string;
	blockNumber: number;
}

interface MatchedArbitrage {
	input: ParsedTransaction;
	output: ParsedTransaction;
	timeDeltaMs: number;
	route: string;
	profitToken: TokenSymbol;
	profitAmount: number;
}

interface MatchResult {
	matched: MatchedArbitrage[];
	unmatched: ParsedTransaction[];
}

interface RouteStats {
	route: string;
	count: number;
	totalProfit: number;
	avgProfit: number;
	minProfit: number;
	maxProfit: number;
}

interface NetworkBreakdown {
	network: Network;
	inputCount: number;
	outputCount: number;
	totalCount: number;
}

interface UnmatchedBreakdown {
	total: number;
	byType: Record<TypeRoute, number>;
	byNetwork: Partial<Record<Network, number>>;
}

interface ArbitrageExtreme {
	profit: number;
	route: string;
	inputHash: string;
	outputHash: string;
	timestamp: string;
}

interface StatsTotals {
	transactions: number;
	matchedPairs: number;
	unmatched: number;
	matchRate: string;
}

interface StatsProfit {
	profitToken: TokenSymbol;
	total: number;
	avg: number;
	median: number;
	min: number;
	max: number;
}

interface UnmatchedStats {
	targetToken: TokenSymbol | null;
	counterToken: TokenSymbol | null;
	totalUnmatched: number;
	targetBought: number;
	targetSold: number;
	netTarget: number;
	counterSpent: number;
	counterReceived: number;
	netCounter: number;
	closing: {
		action: "SELL" | "BUY" | "NONE";
		quantity: number;
		breakEvenPrice: number;
	};
}

interface TokenProfitStatistics {
	period: { fromIso: string; toIso: string };
	token: TokenSymbol;
	totals: StatsTotals;
	profit: StatsProfit;
	bestArbitrage: ArbitrageExtreme | null;
	worstArbitrage: ArbitrageExtreme | null;
	byRoute: RouteStats[];
	byNetwork: NetworkBreakdown[];
	unmatched: UnmatchedBreakdown;
	unmatchedStats: UnmatchedStats;
}

interface ScanFailure {
	network: Network;
	detail: string;
}

interface FetcherResult {
	transactions: ParsedTransaction[];
	failures: ScanFailure[];
}

interface TokenProfitEntry {
	token: TokenSymbol;
	fetchedAt: string;
	durationMs: number;
	stats: TokenProfitStatistics;
	matched: MatchedArbitrage[];
	unmatched: ParsedTransaction[];
	scanFailures: ScanFailure[];
}

interface GrandTotalsByToken {
	token: TokenSymbol;
	profitToken: TokenSymbol;
	total: number;
	matchedPairs: number;
}

interface ProfitGrandTotals {
	completedAt: string;
	durationMs: number;
	byToken: GrandTotalsByToken[];
	totalMatched: number;
	totalUnmatched: number;
	totalTransactions: number;
	overallMatchRate: string;
	byNetwork: NetworkBreakdown[];
	byRoute: RouteStats[];
}

interface ProfitSnapshot {
	date: string;
	generatedAt: string;
	window: ProfitWindow;
	perToken: Partial<Record<TokenSymbol, TokenProfitEntry>>;
	grandTotals: ProfitGrandTotals | null;
}

interface RawArbitrageEvent {
	transactionHash: string;
	blockNumber: number;
	type: TypeRoute;
	tokenInAddress: string;
	tokenOutAddress: string;
	amountIn: bigint;
	amountOut: bigint;
}

export {
	TypeRoute,
	ProfitWindow,
	ParsedTransaction,
	MatchedArbitrage,
	MatchResult,
	RouteStats,
	NetworkBreakdown,
	UnmatchedBreakdown,
	UnmatchedStats,
	ArbitrageExtreme,
	StatsTotals,
	StatsProfit,
	TokenProfitStatistics,
	TokenProfitEntry,
	GrandTotalsByToken,
	ProfitGrandTotals,
	ProfitSnapshot,
	RawArbitrageEvent,
	ScanFailure,
	FetcherResult
};
