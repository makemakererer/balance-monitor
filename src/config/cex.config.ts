import { CexAccountConfig, CexAccountId, CexExchangeId, Network, TokenSymbol } from "../types";

const exchangeIdToNetwork: Record<CexExchangeId, Network> = {
	[CexExchangeId.MEXC]: Network.MEXC,
	[CexExchangeId.KRAKEN]: Network.KRAKEN,
	[CexExchangeId.GATE]: Network.GATE
};

const cexAccounts: Record<CexAccountId, CexAccountConfig> = {
	[CexAccountId.MEXC_ANON]: {
		id: CexAccountId.MEXC_ANON,
		exchangeId: CexExchangeId.MEXC,
		apiKey: process.env.ANON_MEXC_API_KEY as string,
		secret: process.env.ANON_MEXC_SECRET as string
	},
	[CexAccountId.MEXC_RIVER]: {
		id: CexAccountId.MEXC_RIVER,
		exchangeId: CexExchangeId.MEXC,
		apiKey: process.env.RIVER_MEXC_API_KEY as string,
		secret: process.env.RIVER_MEXC_SECRET as string
	},
	[CexAccountId.KRAKEN]: {
		id: CexAccountId.KRAKEN,
		exchangeId: CexExchangeId.KRAKEN,
		apiKey: process.env.KRAKEN_API_KEY as string,
		secret: process.env.KRAKEN_SECRET as string
	},
	[CexAccountId.GATE]: {
		id: CexAccountId.GATE,
		exchangeId: CexExchangeId.GATE,
		apiKey: process.env.GATE_API_KEY as string,
		secret: process.env.GATE_SECRET as string
	}
};

interface CexMarket {
	accountId: CexAccountId;
	symbol: string;
}

// Per-token CEX accounts + ccxt market symbols the profit-calculator scans.
// Empty/absent = token has no CEX leg.
const cexMarkets: Partial<Record<TokenSymbol, CexMarket[]>> = {
	[TokenSymbol.ANON]: [
		{ accountId: CexAccountId.MEXC_ANON, symbol: "ANON/USDT" },
		{ accountId: CexAccountId.KRAKEN, symbol: "ANON/USD" },
		{ accountId: CexAccountId.GATE, symbol: "ANON/USDT" }
	],
	[TokenSymbol.RIVER]: [
		{ accountId: CexAccountId.MEXC_RIVER, symbol: "RIVER/USDT" }
	]
};

export { cexAccounts, exchangeIdToNetwork, cexMarkets, CexMarket };
