import { Network, TokenSymbol, TokensToChain, TokenConfig } from "../types";

const tokensToChain: TokensToChain = {
	[Network.ETH]: {
		[TokenSymbol.RIVER]: "0xdA7AD9dea9397cffdDAE2F8a052B82f1484252B3",
		[TokenSymbol.ANON]: "0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C",
		[TokenSymbol.USDT]: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
		[TokenSymbol.USDC]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		[TokenSymbol.ETH]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
	},
	[Network.SONIC]: {
		[TokenSymbol.ANON]: "0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C",
		[TokenSymbol.USDC]: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
		[TokenSymbol.SONIC]: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38",
		[TokenSymbol.WAGMI]: "0x0e0Ce4D450c705F8a0B6Dd9d5123e3df2787D16B"
	},
	[Network.BASE]: {
		[TokenSymbol.ANON]: "0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C",
		[TokenSymbol.RIVER]: "0xdA7AD9dea9397cffdDAE2F8a052B82f1484252B3",
		[TokenSymbol.ZRO]: "0x6985884C4392D348587B19cb9eAAf157F13271cd",
		[TokenSymbol.USDC]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		[TokenSymbol.ETH]: "0x4200000000000000000000000000000000000006"
	},
	[Network.AVAX]: {
		[TokenSymbol.ANON]: "0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C",
		[TokenSymbol.USDC]: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
		[TokenSymbol.AVAX]: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7"
	},
	[Network.BSC]: {
		[TokenSymbol.ETH]: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
		[TokenSymbol.ANON]: "0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C",
		[TokenSymbol.RIVER]: "0xdA7AD9dea9397cffdDAE2F8a052B82f1484252B3",
		[TokenSymbol.ZRO]: "0x6985884C4392D348587B19cb9eAAf157F13271cd",
		[TokenSymbol.USDT]: "0x55d398326f99059fF775485246999027B3197955",
		[TokenSymbol.USDC]: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
		[TokenSymbol.BNB]: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
	},
	[Network.ARB]: {
		[TokenSymbol.ANON]: "0x79bbF4508B1391af3A0F4B30bb5FC4aa9ab0E07C",
		[TokenSymbol.ZRO]: "0x6985884C4392D348587B19cb9eAAf157F13271cd",
		[TokenSymbol.USDT0]: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
		[TokenSymbol.USDC]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
		[TokenSymbol.ETH]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
	},
	[Network.OP]: {
		[TokenSymbol.ZRO]: "0x6985884C4392D348587B19cb9eAAf157F13271cd",
		[TokenSymbol.USDC]: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
		[TokenSymbol.ETH]: "0x4200000000000000000000000000000000000006"
	},
	[Network.ABSTRACT]: {
		[TokenSymbol.USDC]: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1",
		[TokenSymbol.ETH]: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809"
	},
	[Network.INK]: {
		[TokenSymbol.USDC]: "0xF1815bd50389c46847f0Bda824eC8da914045D14",
		[TokenSymbol.USDT0]: "0x0200C29006150606B650577BBE7B6248F58470c1",
		[TokenSymbol.ETH]: "0x4200000000000000000000000000000000000006"
	},
	[Network.SONEIUM]: {
		[TokenSymbol.USDC]: "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369",
		[TokenSymbol.ETH]: "0x4200000000000000000000000000000000000006"
	},
	[Network.CRONOS_ZKEVM]: {
		[TokenSymbol.USDC]: "0x5b91e29ae5a71d9052620acb813d5ac25ec7a4a2",
		[TokenSymbol.ETH]: "0x271602a97027ee1dd03b1e6e5db153eb659a80b1",
		[TokenSymbol.ZK_CRO]: "0xc1bf55ee54e16229d9b369a5502bfe5fc9f20b6d"
	},
	[Network.FLARE]: {
		[TokenSymbol.USDC]: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
		[TokenSymbol.ETH]: "0x1502FA4be69d526124D453619276FacCab275d3D",
		[TokenSymbol.FLR]: "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d"
	},
	[Network.ZORA]: {
		[TokenSymbol.USDC]: "0xCccCCccc7021b32EBb4e8C08314bD62F7c653EC4",
		[TokenSymbol.ETH]: "0x4200000000000000000000000000000000000006"
	},
	[Network.SOLANA]: {
		[TokenSymbol.ANON]: "9McvH6w97oewLmPxqQEoHUAv3u5iYMyQ9AeZZhguYf1T",
		[TokenSymbol.USDC]: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		[TokenSymbol.WSOL]: "So11111111111111111111111111111111111111112",
		[TokenSymbol.ETH]: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
	},
	[Network.KAVA]: {
		[TokenSymbol.WAGMI]: "0xaf20f5f19698f1D19351028cd7103B63D30DE7d7",
		[TokenSymbol.KAVA]: "0xc86c7C0eFbd6A49B35E8714C5f59D99De09A225b",
		[TokenSymbol.USDC]: "0x919C1c267BC06a7039e03fcc2eF738525769109c"
	},
	[Network.METIS]: {
		[TokenSymbol.WAGMI]: "0xaf20f5f19698f1D19351028cd7103B63D30DE7d7",
		[TokenSymbol.METIS]: "0x75cb093E4D61d2A2e65D8e0BBb01DE8d89b53481",
		[TokenSymbol.USDC]: "0xEA32A96608495e54156Ae48931A7c20f0dcc1a21"
	},
	// CEX: token "addresses" are just symbol strings used as balance keys
	[Network.MEXC]: {
		[TokenSymbol.ANON]: "ANON",
		[TokenSymbol.RIVER]: "RIVER",
		[TokenSymbol.USDT]: "USDT"
	},
	[Network.KRAKEN]: {
		[TokenSymbol.ANON]: "ANON",
		[TokenSymbol.USD]: "USD"
	},
	[Network.GATE]: {
		[TokenSymbol.ANON]: "ANON",
		[TokenSymbol.USDT]: "USDT"
	}
};

const tokenConfig: TokenConfig = {
	// ANON token for all networks the same
	[tokensToChain[Network.SONIC].ANON]: { symbol: TokenSymbol.ANON, decimals: 18 },

	// ANON token (SOLANA)
	[tokensToChain[Network.SOLANA].ANON]: { symbol: TokenSymbol.ANON, decimals: 9 },

	// RIVER token for all networks the same
	[tokensToChain[Network.ETH].RIVER]: { symbol: TokenSymbol.RIVER, decimals: 18 },

	// ZRO token for all networks the same
	[tokensToChain[Network.BASE].ZRO]: { symbol: TokenSymbol.ZRO, decimals: 18 },

	// WAGMI token (SONIC)
	[tokensToChain[Network.SONIC].WAGMI]: { symbol: TokenSymbol.WAGMI, decimals: 18 },

	// WAGMI token (KAVA)
	[tokensToChain[Network.KAVA].WAGMI]: { symbol: TokenSymbol.WAGMI, decimals: 18 },

	// WAGMI token (METIS)
	[tokensToChain[Network.METIS].WAGMI]: { symbol: TokenSymbol.WAGMI, decimals: 18 },

	// natives apart from eth

	// SONIC token (Sonic)
	[tokensToChain[Network.SONIC].SONIC]: { symbol: TokenSymbol.SONIC, decimals: 18 },

	// AVAX token (AVAX)
	[tokensToChain[Network.AVAX].AVAX]: { symbol: TokenSymbol.AVAX, decimals: 18 },

	// BNB token (BSC)
	[tokensToChain[Network.BSC].BNB]: { symbol: TokenSymbol.BNB, decimals: 18 },

	// ZKCRO token (CRONOS_ZKEVM)
	[tokensToChain[Network.CRONOS_ZKEVM].ZK_CRO]: { symbol: TokenSymbol.ZK_CRO, decimals: 18 },

	// WSOL token (SOLANA)
	[tokensToChain[Network.SOLANA].WSOL]: { symbol: TokenSymbol.WSOL, decimals: 9 },

	// Wormhole wETH token (SOLANA)
	[tokensToChain[Network.SOLANA].ETH]: { symbol: TokenSymbol.ETH, decimals: 8 },

	// KAVA token (KAVA)
	[tokensToChain[Network.KAVA].KAVA]: { symbol: TokenSymbol.KAVA, decimals: 18 },

	// METIS token (METIS)
	[tokensToChain[Network.METIS].METIS]: { symbol: TokenSymbol.METIS, decimals: 18 },

	// FLR token (FLARE)
	[tokensToChain[Network.FLARE].FLR]: { symbol: TokenSymbol.FLR, decimals: 18 },

	//! ethereum
	// ETH token (ETH)
	[tokensToChain[Network.ETH].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (Base)
	[tokensToChain[Network.BASE].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (ARB)
	[tokensToChain[Network.ARB].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (BSC)
	[tokensToChain[Network.BSC].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (Abstract)
	[tokensToChain[Network.ABSTRACT].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (INK)
	[tokensToChain[Network.INK].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (SONEIUM)
	[tokensToChain[Network.SONEIUM].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (CRONOS_ZKEVM)
	[tokensToChain[Network.CRONOS_ZKEVM].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (FLARE)
	[tokensToChain[Network.FLARE].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	// ETH token (ZORA)
	[tokensToChain[Network.ZORA].ETH]: { symbol: TokenSymbol.ETH, decimals: 18 },

	//! stables
	// USDC token (ETH)
	[tokensToChain[Network.ETH].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDT token (ETH)
	[tokensToChain[Network.ETH].USDT]: { symbol: TokenSymbol.USDT, decimals: 6 },

	//! USDT0 token (ARB)
	[tokensToChain[Network.ARB].USDT0]: { symbol: TokenSymbol.USDT0, decimals: 6 },

	//! USDT0 token (INK)
	[tokensToChain[Network.INK].USDT0]: { symbol: TokenSymbol.USDT0, decimals: 6 },

	// USDC (Base) token
	[tokensToChain[Network.BASE].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (ARB)
	[tokensToChain[Network.ARB].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (Sonic)
	[tokensToChain[Network.SONIC].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (AVAX)
	[tokensToChain[Network.AVAX].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDT token (BSC)
	[tokensToChain[Network.BSC].USDT]: { symbol: TokenSymbol.USDT, decimals: 18 },

	// USDC token (BSC)
	[tokensToChain[Network.BSC].USDC]: { symbol: TokenSymbol.USDC, decimals: 18 },

	// USDC token (Abstract)
	[tokensToChain[Network.ABSTRACT].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (INK)
	[tokensToChain[Network.INK].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (SONEIUM)
	[tokensToChain[Network.SONEIUM].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	//! vUSD token (CRONOS_ZKEVM)
	[tokensToChain[Network.CRONOS_ZKEVM].USDC]: { symbol: TokenSymbol.USDC, decimals: 18 },

	//! USDT0 token (FLARE)
	[tokensToChain[Network.FLARE].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	//! USDzC token (ZORA)
	[tokensToChain[Network.ZORA].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (OP)
	[tokensToChain[Network.OP].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	//! USDt token (KAVA)
	[tokensToChain[Network.KAVA].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	//! m.USDC token (METIS)
	[tokensToChain[Network.METIS].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 },

	// USDC token (SOLANA)
	[tokensToChain[Network.SOLANA].USDC]: { symbol: TokenSymbol.USDC, decimals: 6 }
};

// Override mapping: which stablecoin each vault token pairs with on a specific network.
// Only specify overrides where the stable is NOT USDC (default fallback is USDC).
const vaultStablecoinOverrides: Partial<Record<TokenSymbol, Partial<Record<Network, TokenSymbol>>>> = {
	[TokenSymbol.RIVER]: {
		[Network.ETH]: TokenSymbol.USDT,
		[Network.BSC]: TokenSymbol.USDT,
		[Network.MEXC]: TokenSymbol.USDT
	},
	[TokenSymbol.ETH]: {
		[Network.BSC]: TokenSymbol.USDT
	},
	[TokenSymbol.ANON]: {
		[Network.MEXC]: TokenSymbol.USDT,
		[Network.KRAKEN]: TokenSymbol.USD,
		[Network.GATE]: TokenSymbol.USDT
	}
};

function getStableForToken(arbToken: TokenSymbol, network: Network): TokenSymbol {
	return vaultStablecoinOverrides[arbToken]?.[network] ?? TokenSymbol.USDC;
}

const STABLE_SYMBOLS: readonly TokenSymbol[] = [TokenSymbol.USDC, TokenSymbol.USDT, TokenSymbol.USDT0, TokenSymbol.USD];

function isStableSymbol(symbol: TokenSymbol): boolean {
	return STABLE_SYMBOLS.includes(symbol);
}

// Symbols that represent the same underlying asset.
// Key is the canonical symbol; the array lists aliases that should collapse into it
// when computing Grand Totals (e.g. wrapped Solana on the SPL side).
const tokenAliases: Partial<Record<TokenSymbol, TokenSymbol[]>> = {
	[TokenSymbol.SOL]: [TokenSymbol.WSOL]
};

export {
	tokensToChain,
	tokenConfig,
	vaultStablecoinOverrides,
	getStableForToken,
	STABLE_SYMBOLS,
	isStableSymbol,
	tokenAliases
};
