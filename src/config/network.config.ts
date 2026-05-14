import { ChainType, EvmChainMeta, Network, SvmChainMeta, TokenSymbol } from "../types";

const evmChainMetadata: Partial<Record<Network, EvmChainMeta>> = {
	[Network.ETH]: { chainId: 1, name: "eth", nativeSymbol: TokenSymbol.ETH, nativeDecimals: 18, failedTxSource: "etherscan" },
	[Network.SONIC]: { chainId: 146, name: "sonic", nativeSymbol: TokenSymbol.SONIC, nativeDecimals: 18, failedTxSource: "etherscan" },
	[Network.BASE]: {
		chainId: 8453,
		name: "base",
		nativeSymbol: TokenSymbol.ETH,
		nativeDecimals: 18,
		failedTxSource: "blockscout",
		blockscoutBaseUrl: "https://base.blockscout.com/api"
	},
	[Network.AVAX]: { chainId: 43114, name: "avax", nativeSymbol: TokenSymbol.AVAX, nativeDecimals: 18, failedTxSource: "routescan" },
	[Network.BSC]: { chainId: 56, name: "bsc", nativeSymbol: TokenSymbol.BNB, nativeDecimals: 18, failedTxSource: "moralis" },
	[Network.ARB]: {
		chainId: 42161,
		name: "arbitrum",
		nativeSymbol: TokenSymbol.ETH,
		nativeDecimals: 18,
		failedTxSource: "blockscout",
		blockscoutBaseUrl: "https://arbitrum.blockscout.com/api"
	},
	[Network.OP]: {
		chainId: 10,
		name: "optimism",
		nativeSymbol: TokenSymbol.ETH,
		nativeDecimals: 18,
		failedTxSource: "blockscout",
		blockscoutBaseUrl: "https://optimism.blockscout.com/api"
	},
	[Network.ABSTRACT]: { chainId: 2741, name: "abstract", nativeSymbol: TokenSymbol.ETH, nativeDecimals: 18, failedTxSource: null },
	[Network.INK]: { chainId: 57073, name: "ink", nativeSymbol: TokenSymbol.ETH, nativeDecimals: 18, failedTxSource: null },
	[Network.SONEIUM]: {
		chainId: 1868,
		name: "soneium",
		nativeSymbol: TokenSymbol.ETH,
		nativeDecimals: 18,
		failedTxSource: "blockscout",
		blockscoutBaseUrl: "https://soneium.blockscout.com/api"
	},
	[Network.CRONOS_ZKEVM]: {
		chainId: 388,
		name: "cronos-zkevm",
		nativeSymbol: TokenSymbol.ZK_CRO,
		nativeDecimals: 18,
		failedTxSource: null
	},
	[Network.FLARE]: { chainId: 14, name: "flare", nativeSymbol: TokenSymbol.FLR, nativeDecimals: 18, failedTxSource: null },
	[Network.ZORA]: { chainId: 7777777, name: "zora", nativeSymbol: TokenSymbol.ETH, nativeDecimals: 18, failedTxSource: null },
	[Network.KAVA]: { chainId: 2222, name: "kava", nativeSymbol: TokenSymbol.KAVA, nativeDecimals: 18, failedTxSource: null },
	[Network.METIS]: { chainId: 1088, name: "metis", nativeSymbol: TokenSymbol.METIS, nativeDecimals: 18, failedTxSource: null }
};

const svmChainMetadata: Partial<Record<Network, SvmChainMeta>> = {
	[Network.SOLANA]: { name: "solana", nativeSymbol: TokenSymbol.SOL, nativeDecimals: 9 }
};

const chainTypeByNetwork: Record<Network, ChainType> = {
	[Network.ETH]: ChainType.EVM,
	[Network.SONIC]: ChainType.EVM,
	[Network.BASE]: ChainType.EVM,
	[Network.AVAX]: ChainType.EVM,
	[Network.BSC]: ChainType.EVM,
	[Network.ARB]: ChainType.EVM,
	[Network.OP]: ChainType.EVM,
	[Network.ABSTRACT]: ChainType.EVM,
	[Network.INK]: ChainType.EVM,
	[Network.SONEIUM]: ChainType.EVM,
	[Network.CRONOS_ZKEVM]: ChainType.EVM,
	[Network.FLARE]: ChainType.EVM,
	[Network.ZORA]: ChainType.EVM,
	[Network.KAVA]: ChainType.EVM,
	[Network.METIS]: ChainType.EVM,
	[Network.SOLANA]: ChainType.SVM,
	[Network.MEXC]: ChainType.CEX,
	[Network.KRAKEN]: ChainType.CEX,
	[Network.GATE]: ChainType.CEX
};

const networkRpcUrls: Partial<Record<Network, string>> = {
	[Network.ETH]: "https://ethereum.blockpi.network/v1/rpc/ea98d3c11ebeebf5756f2c4d13d19b0aa93d6e09",
	[Network.SONIC]: "https://sonic.blockpi.network/v1/rpc/5823df1c740e9b02262f54fafdf4710ce451aef7",
	[Network.BASE]: "https://base.blockpi.network/v1/rpc/c8c232b67472d3a64bbb05b8b2a006ecc5e62bb6",
	[Network.AVAX]: "https://avalanche.blockpi.network/v1/rpc/fc8a7be6d860f7175e1984e7ec1358b5225fb1f8",
	[Network.BSC]: "https://bsc.blockpi.network/v1/rpc/ce14319339b1941b7ecf9e8785f4211a4b44dacf",
	[Network.ARB]: "https://arbitrum.blockpi.network/v1/rpc/eaad82d8c15188dbca75339ceefd380fef9e0d11",
	[Network.SONEIUM]: "https://rpc.soneium.org",
	[Network.OP]: "https://optimism.blockpi.network/v1/rpc/f0b57675ca9f46f40853d3d7b2f640890157cbd3",
	[Network.ABSTRACT]: "https://abstract.blockpi.network/v1/rpc/7d495788f4b9b2f3e53b1e52d11b56b014f1cceb",
	[Network.INK]: "https://ink.blockpi.network/v1/rpc/334b8105311d86f5826eee9cc9feed59bc96a100",
	[Network.CRONOS_ZKEVM]: "https://lb.drpc.live/cronos-zkevm/AiV9frF1k0rflEegrOCa2sJkybedtFYR8L0x_hXb38UN",
	[Network.ZORA]: "https://zora.drpc.org",
	[Network.KAVA]: "https://lb.drpc.live/kava/AiV9frF1k0rflEegrOCa2sJkybedtFYR8L0x_hXb38UN",
	[Network.METIS]: "https://metis.blockpi.network/v1/rpc/0410b81f707b1aae0030fe8f8e1e6d5fdc26d8a2"
};

const svmRpcUrl: string = "https://solana.blockpi.network/v1/rpc/58094c4e1ec4294519a420924c37f6478d30df17";

export { evmChainMetadata, svmChainMetadata, chainTypeByNetwork, networkRpcUrls, svmRpcUrl };
