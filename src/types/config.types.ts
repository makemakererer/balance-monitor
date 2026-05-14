enum Network {
	ETH = "ETH",
	BSC = "BSC",
	BASE = "BASE",
	ARB = "ARB",
	AVAX = "AVAX",
	SONIC = "SONIC",
	SOLANA = "SOLANA",
	MEXC = "MEXC",
	KRAKEN = "KRAKEN",
	GATE = "GATE",
	OP = "OP",
	ABSTRACT = "ABSTRACT",
	INK = "INK",
	SONEIUM = "SONEIUM",
	CRONOS_ZKEVM = "CRONOS_ZKEVM",
	FLARE = "FLARE",
	ZORA = "ZORA",
	KAVA = "KAVA",
	METIS = "METIS"
}

enum TokenSymbol {
	ANON = "ANON",
	RIVER = "RIVER",
	ZRO = "ZRO",
	WAGMI = "WAGMI",
	ETH = "ETH",
	BNB = "BNB",
	SONIC = "SONIC",
	AVAX = "AVAX",
	ZK_CRO = "ZK_CRO",
	FLR = "FLR",
	KAVA = "KAVA",
	METIS = "METIS",
	SOL = "SOL",
	WSOL = "WSOL",
	USDC = "USDC",
	USDT = "USDT",
	USDT0 = "USDT0",
	USD = "USD"
}

enum ChainType {
	EVM = "EVM",
	SVM = "SVM",
	CEX = "CEX"
}

enum CexExchangeId {
	MEXC = "mexc",
	KRAKEN = "kraken",
	GATE = "gate"
}

enum CexAccountId {
	MEXC_ANON = "MEXC_ANON",
	MEXC_RIVER = "MEXC_RIVER",
	KRAKEN = "KRAKEN",
	GATE = "GATE"
}

type FailedTxSource = "etherscan" | "blockscout" | "routescan" | "moralis" | null;

interface EvmChainMeta {
	chainId: number;
	name: string;
	nativeSymbol: TokenSymbol;
	nativeDecimals: number;
	failedTxSource: FailedTxSource;
	blockscoutBaseUrl?: string;
}

interface SvmChainMeta {
	name: string;
	nativeSymbol: TokenSymbol;
	nativeDecimals: number;
}

interface CexAccountConfig {
	id: CexAccountId;
	exchangeId: CexExchangeId;
	apiKey: string;
	secret: string;
}

interface TokenInfo {
	symbol: TokenSymbol;
	decimals: number;
}

interface TokensToChainNetwork {
	[token: string]: string;
}

interface TokensToChain {
	[network: string]: TokensToChainNetwork;
}

interface TokenConfig {
	[address: string]: TokenInfo;
}

export {
	Network,
	TokenSymbol,
	ChainType,
	CexExchangeId,
	CexAccountId,
	EvmChainMeta,
	FailedTxSource,
	SvmChainMeta,
	CexAccountConfig,
	TokenInfo,
	TokensToChainNetwork,
	TokensToChain,
	TokenConfig
};
