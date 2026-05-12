import { ChainType, Network, TokenSymbol } from "./config.types";

enum SourceType {
	WALLET_ARB = "wallet_arb",
	WALLET_REBALANCER = "wallet_rebalancer",
	VAULT = "vault",
	CEX_ACCOUNT = "cex_account"
}

interface TokenBalance {
	symbol: TokenSymbol;
	address: string;
	amount: bigint | null;
	decimals: number;
	error: string | null;
}

interface SourceBalance {
	type: SourceType;
	label: string;
	native: TokenBalance | null;
	tokens: TokenBalance[];
	error: string | null;
}

interface ChainSnapshot {
	chain: Network;
	chainType: ChainType;
	sources: SourceBalance[];
	chainTotals: {
		tokens: Partial<Record<TokenSymbol, bigint>>;
		native: TokenBalance | null;
	};
}

interface GrandTotals {
	tokens: Partial<Record<TokenSymbol, bigint>>;
	stablesTotal: bigint;
	natives: Partial<Record<Network, TokenBalance>>;
}

interface Snapshot {
	date: string;
	generatedAt: string;
	chains: ChainSnapshot[];
	grandTotals: GrandTotals;
}

export { SourceType, TokenBalance, SourceBalance, ChainSnapshot, GrandTotals, Snapshot };
