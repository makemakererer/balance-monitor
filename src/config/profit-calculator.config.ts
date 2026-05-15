const profitWindowSeconds: number = 24 * 60 * 60;

// Public on-chain ID of the Solana arbitrage executor program (v3Pools `idls/executor.ts`).
// SVM fetcher only considers txs that invoke this program.
const svmExecutorProgramId: string = "9uBAGYGAK9ZxEtgoGMJKaNGLrbfc2tveUJLroju72v3x";

const profitCexLimits = {
	tradesPageLimit: 1000,
	interPageDelayMs: 500
} as const;

const profitMatcher = {
	// Max gap between buy↔sell legs of the same arbitrage (1h).
	maxTimeDeltaMs: 3_600_000,
	// Strict equality breaks on CEX fills (rounding/slippage) — tolerance only when a leg is CEX.
	cexAmountToleranceRelative: 0.005
} as const;

const profitStats = {
	// Net target-token position considered balanced (no closing trade implied) when |netTarget| is below this threshold.
	balancedPositionThreshold: 0.00001
} as const;

export { profitWindowSeconds, svmExecutorProgramId, profitCexLimits, profitMatcher, profitStats };
