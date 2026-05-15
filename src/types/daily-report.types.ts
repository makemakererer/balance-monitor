import { NativeSpendSnapshot, NativeSpendWindow } from "./native-spend.types";
import { ProfitSnapshot, TokenProfitEntry } from "./profit-calculator.types";
import { SpendRecord, TokenArbSpendEntry } from "./native-spend.types";
import { TokenSymbol } from "./config.types";

// Everything daily-report needs to render one token's merged card.
// Pre-computed by the orchestrator so the renderer stays dumb.
interface TokenDayCard {
	token: TokenSymbol;
	window: NativeSpendWindow;
	profit: TokenProfitEntry;
	arbSpend: TokenArbSpendEntry;
	rebalanceRecords: SpendRecord[];
	grossProfitUsd: number;
	arbSuccessUsd: number;
	arbFailedUsd: number;
	arbSuccessTxCount: number;
	arbFailedTxCount: number;
	rebalanceSuccessUsd: number;
	rebalanceFailedUsd: number;
	rebalanceSuccessTxCount: number;
	rebalanceFailedTxCount: number;
	netUsd: number;
	durationMs: number;
}

// Everything daily-report needs to render the bottom-of-day total.
interface DailyTotals {
	date: string;
	window: NativeSpendWindow;
	tokenCards: TokenDayCard[];
	rebalanceStableRecords: SpendRecord[];
	profitSnapshot: ProfitSnapshot;
	nativeSpendSnapshot: NativeSpendSnapshot;
	totalDurationMs: number;
}

export { TokenDayCard, DailyTotals };
