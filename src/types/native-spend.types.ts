import { Network, TokenSymbol } from "./config.types";

enum SpendIntent {
	ARBITRAGE = "ARBITRAGE",
	REBALANCE = "REBALANCE"
}

enum BridgeKind {
	CCTP = "CCTP",
	OFT = "OFT",
	BUNGEE = "BUNGEE"
}

enum SpendStatus {
	SUCCESS = "SUCCESS",
	REVERTED = "REVERTED"
}

interface NativeSpendWindow {
	fromTimestampSeconds: number;
	toTimestampSeconds: number;
	fromIso: string;
	toIso: string;
}

// baseIsNative: token0 holds the wrapped native, token1 holds the stable; flip when false.
// priceMethod: V3 forks use slot0(), Algebra-based pools use globalState().
interface PoolRef {
	address: string;
	baseIsNative: boolean;
	nativeDecimals: number;
	stableDecimals: number;
	priceMethod: "slot0" | "globalState";
}

interface SpendBreakdown {
	gas: string;
	bribe?: string;
	tips?: string;
}

interface SpendRecord {
	network: Network;
	intent: SpendIntent;
	status: SpendStatus;
	token: TokenSymbol;
	txHash: string;
	blockNumber: number;
	timestampSeconds: number;
	timestampIso: string;
	payer: string;
	nativeAmount: string;
	usdAmount: number | null;
	breakdown: SpendBreakdown;
	bridge?: BridgeKind;
	detail?: string;
}

// Failed tx that we couldn't attribute to a vault/token (approval, manual,
// unknown). Always REVERTED — successful unattributed activity isn't tracked.
interface UnattributedSpendRecord {
	network: Network;
	txHash: string;
	blockNumber: number;
	timestampSeconds: number;
	timestampIso: string;
	payer: string;
	nativeAmount: string;
	usdAmount: number | null;
	detail?: string;
}

interface NativeSpendScanFailure {
	network: Network;
	intent: SpendIntent | "PRICING" | "UNATTRIBUTED";
	detail: string;
}

interface TokenArbSpendEntry {
	token: TokenSymbol;
	fetchedAt: string;
	durationMs: number;
	records: SpendRecord[];
	scanFailures: NativeSpendScanFailure[];
}

interface RebalanceSpendEntry {
	fetchedAt: string;
	durationMs: number;
	records: SpendRecord[];
	scanFailures: NativeSpendScanFailure[];
}

interface UnattributedSpendEntry {
	fetchedAt: string;
	durationMs: number;
	records: UnattributedSpendRecord[];
	scanFailures: NativeSpendScanFailure[];
}

interface IntentNetworkTokenSpend {
	token: TokenSymbol;
	nativeAmount: string;
	usdAmount: number | null;
	txCount: number;
}

// usdAmount/nativeAmount/txCount cover SUCCESS only — Failed in this
// (intent, network) shown via revertedUsd/revertedTxCount so the renderer
// can render the nested Arbitrage/Failed split per chain.
interface IntentNetworkSpend {
	network: Network;
	nativeAmount: string;
	nativeSymbol: TokenSymbol;
	nativeDecimals: number;
	usdAmount: number | null;
	txCount: number;
	byToken: IntentNetworkTokenSpend[];
	revertedUsd: number;
	revertedTxCount: number;
}

interface IntentTotals {
	intent: SpendIntent;
	usdTotal: number;
	txCount: number;
	byNetwork: IntentNetworkSpend[];
}

interface TokenIntentSpend {
	intent: SpendIntent;
	usdAmount: number;
	txCount: number;
}

interface TokenTotals {
	token: TokenSymbol;
	usdTotal: number;
	txCount: number;
	byIntent: TokenIntentSpend[];
	failedUsd: number;
	failedTxCount: number;
}

interface NativeTokenTotals {
	nativeSymbol: TokenSymbol;
	nativeDecimals: number;
	nativeAmount: string;
	usdAmount: number | null;
	txCount: number;
}

interface FailedBreakdownEntry {
	usdAmount: number;
	txCount: number;
}

interface FailedNetworkEntry {
	network: Network;
	usdAmount: number;
	txCount: number;
}

interface FailedTotals {
	usdTotal: number;
	txCount: number;
	byType: {
		arbitrage: FailedBreakdownEntry;
		rebalance: FailedBreakdownEntry;
		unattributed: FailedBreakdownEntry;
	};
	byNetwork: FailedNetworkEntry[];
}

interface NativeSpendGrandTotals {
	completedAt: string;
	durationMs: number;
	totalUsd: number;
	totalTxCount: number;
	byToken: TokenTotals[];
	byNativeToken: NativeTokenTotals[];
	arbitrage: IntentTotals;
	rebalance: IntentTotals;
	failed: FailedTotals;
}

interface NativeSpendSnapshot {
	date: string;
	generatedAt: string;
	window: NativeSpendWindow;
	arbSpend: {
		perToken: Partial<Record<TokenSymbol, TokenArbSpendEntry>>;
	};
	rebalanceSpend: RebalanceSpendEntry | null;
	unattributedSpend: UnattributedSpendEntry | null;
	grandTotals: NativeSpendGrandTotals | null;
}

export {
	SpendIntent,
	BridgeKind,
	SpendStatus,
	NativeSpendWindow,
	PoolRef,
	SpendBreakdown,
	SpendRecord,
	UnattributedSpendRecord,
	NativeSpendScanFailure,
	TokenArbSpendEntry,
	RebalanceSpendEntry,
	UnattributedSpendEntry,
	IntentNetworkSpend,
	IntentNetworkTokenSpend,
	IntentTotals,
	TokenIntentSpend,
	TokenTotals,
	NativeTokenTotals,
	FailedBreakdownEntry,
	FailedNetworkEntry,
	FailedTotals,
	NativeSpendGrandTotals,
	NativeSpendSnapshot
};
