import { Network, TokenSymbol } from "../types";

// Single source of truth for what's currently active in the project.
// Flip a flag to disable a network or trading token without touching any
// other config — every fetcher reads these maps at the top of its entry
// point and skips disabled entries.

// Networks the daily snapshot collects from. Spans EVM + SVM + CEX.
const enabledNetworks: Record<Network, boolean> = {
	// EVM
	[Network.ETH]: true,
	[Network.BSC]: true,
	[Network.BASE]: true,
	[Network.ARB]: true,
	[Network.AVAX]: true,
	[Network.SONIC]: true,
	[Network.SONEIUM]: true,
	[Network.OP]: false,
	[Network.ABSTRACT]: false,
	[Network.INK]: false,
	[Network.CRONOS_ZKEVM]: false,
	[Network.FLARE]: false,
	[Network.ZORA]: false,
	[Network.KAVA]: false,
	[Network.METIS]: false,
	// SVM
	[Network.SOLANA]: true,
	// CEX
	[Network.MEXC]: true,
	[Network.KRAKEN]: true,
	[Network.GATE]: true
};

// Tokens the profit-calculator iterates over (one telegram report per
// enabled token, then grand totals across all of them). Disabled tokens
// are skipped entirely: no vault event scan, no CEX scan, no SVM scan.
const tradingTokens: Partial<Record<TokenSymbol, boolean>> = {
	[TokenSymbol.ANON]: true,
	[TokenSymbol.RIVER]: true,
	[TokenSymbol.ETH]: false,
	[TokenSymbol.ZRO]: false,
	[TokenSymbol.WAGMI]: false,
	[TokenSymbol.ZK_CRO]: false
};

export { enabledNetworks, tradingTokens };
