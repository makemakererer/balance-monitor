import { Network } from "../types";
import { BridgeKind, PoolRef } from "../types/native-spend.types";

const nativeSpendWindowSeconds: number = 24 * 60 * 60;

// Per-network native↔stable V3 pool source, read on the source chain at the
// same block where the spend occurred. SOLANA pricing uses a separate EVM
// fallback below (no archive Solana RPC available).
//
// Pool addresses + token0/token1 orientation copied verbatim from
// v3Pools-Arb/src/config/pools.config.ts. baseIsNative=true means token0 is
// the wrapped native side of the pair.
const nativeUsdPoolByNetwork: Partial<Record<Network, PoolRef>> = {
	[Network.ETH]: {
		// USDC/WETH 0.05% on Uniswap V3. token0=USDC (smaller address), token1=WETH.
		address: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
		baseIsNative: false,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.BASE]: {
		address: "0x6c561B446416E1A00E8E93E221854d6eA4171372",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.ARB]: {
		address: "0xC6962004f452bE9203591991D15f6b388e09E8D0",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.AVAX]: {
		// Algebra-based DEX — globalState() instead of slot0().
		address: "0x41100C6D2c6920B10d12Cd8D59c8A9AA2eF56fC7",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "globalState"
	},
	[Network.BSC]: {
		// USDT/BNB on PancakeSwap V3 — token0=USDT (18-dec BSC variant), token1=BNB.
		address: "0x172fcD41E0913e95784454622d1c3724f546f849",
		baseIsNative: false,
		nativeDecimals: 18,
		stableDecimals: 18,
		priceMethod: "slot0"
	},
	[Network.SONIC]: {
		address: "0x324963c267c354c7660ce8ca3f5f167e05649970",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.OP]: {
		address: "0xc858A329Bf053BE78D6239C4A4343B8FbD21472b",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.SONEIUM]: {
		address: "0x5441c4c5cc00D33bd9409F742D511Ee01db1667B",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.ABSTRACT]: {
		address: "0x7C72570fDa921Aac316bCEF81C0E683904a72D30",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.INK]: {
		address: "0x67ce303f24b3841698891Cece349072856B80A9C",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.CRONOS_ZKEVM]: {
		// USDC/zkCRO on H2Finance. token0=USDC (smaller address), token1=zkCRO. USDC is 18-decimal here.
		address: "0xD1645c5c5434Fec106BD8AEC9fC027EFF5e7Cd1E",
		baseIsNative: false,
		nativeDecimals: 18,
		stableDecimals: 18,
		priceMethod: "slot0"
	},
	[Network.FLARE]: {
		address: "0x724bD6413925Dd4D513B35b1cf9c6f1C378e3691",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.ZORA]: {
		address: "0xbC59f8F3b275AA56A90D13bAE7cCe5e6e11A3b17",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.KAVA]: {
		// token0=USDC, token1=KAVA.
		address: "0x26216b7b7dE80399b601b8217DA272b82d4f34cb",
		baseIsNative: false,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "slot0"
	},
	[Network.METIS]: {
		// Algebra Legacy — globalState() instead of slot0().
		address: "0xA4E4949e0cccd8282f30e7E113D8A551A1eD1aeb",
		baseIsNative: true,
		nativeDecimals: 18,
		stableDecimals: 6,
		priceMethod: "globalState"
	}
};

// SOL pricing — Base wSOL/USDC V3 pool, read at the Base block whose timestamp
// matches the source Solana tx. token0=wSOL (9 dec), token1=USDC (6 dec).
const solanaFallbackNetwork: Network = Network.BASE;
const solanaFallbackPool: PoolRef = {
	address: "0x1131DB5977242a03eBeaD1aCD18F80A9A29e5922",
	baseIsNative: true,
	nativeDecimals: 9,
	stableDecimals: 6,
	priceMethod: "slot0"
};

// Which bridges are reachable on which network (v3Pools-Arb).
// BSC: no CCTP support (Circle does not run CCTP on BSC).
const rebalanceBridgesByNetwork: Partial<Record<Network, BridgeKind[]>> = {
	[Network.ETH]: [BridgeKind.CCTP, BridgeKind.OFT, BridgeKind.BUNGEE],
	[Network.BASE]: [BridgeKind.CCTP, BridgeKind.OFT, BridgeKind.BUNGEE],
	[Network.ARB]: [BridgeKind.CCTP, BridgeKind.OFT],
	[Network.AVAX]: [BridgeKind.CCTP, BridgeKind.OFT],
	[Network.SONIC]: [BridgeKind.CCTP, BridgeKind.OFT],
	[Network.BSC]: [BridgeKind.OFT, BridgeKind.BUNGEE],
	[Network.SOLANA]: [BridgeKind.CCTP, BridgeKind.OFT]
};

// SVM OFT program (v3Pools-Arb /src/solana-instructions/main-programs-ids.ts).
const svmOftProgramId: string = "A1oayh35gLkRG8fHcXtfdGJmbsubAeJA7URVVET3h8MZ";

// Native-spend specific scan knobs. Two-pass retry mirrors rpc-scan.config.ts.
const nativeSpendScanLimits = {
	multicallRetries: 5,
	multicallRetryDelayMs: 1000,
	multicallMaxPasses: 2,
	receiptBatchSize: 20,
	receiptRetries: 5,
	receiptRetryDelayMs: 1000,
	receiptMaxPasses: 2
} as const;

const etherscanLimits = {
	baseUrl: "https://api.etherscan.io/v2/api",
	minRequestSpacingMs: 250,
	pageSize: 10000,
	maxPages: 5,
	retries: 3,
	retryDelayMs: 1500,
	maxPasses: 2
} as const;

// Public Blockscout instances throttle anonymous traffic at ~10 req/s per IP;
// 200ms spacing keeps us under that with margin. No API key required.
const blockscoutLimits = {
	minRequestSpacingMs: 200,
	pageSize: 10000,
	maxPages: 5,
	retries: 3,
	retryDelayMs: 1500,
	maxPasses: 2
} as const;

// Routescan exposes one Etherscan-compatible host for many EVM chains; chainId
// goes in the path, not a query param. No API key on the free tier.
const routescanLimits = {
	baseUrl: "https://api.routescan.io/v2/network/mainnet/evm",
	minRequestSpacingMs: 250,
	pageSize: 10000,
	maxPages: 5,
	retries: 3,
	retryDelayMs: 1500,
	maxPasses: 2
} as const;

// Moralis Web3 Data API. Free tier 40k CU/day @ 40 RPS — we stay deliberately
// slow at ~5 RPS. Pagination is cursor-based; pageSize is the per-call limit.
const moralisLimits = {
	baseUrl: "https://deep-index.moralis.io/api/v2.2",
	minRequestSpacingMs: 200,
	pageSize: 100,
	maxPages: 20,
	retries: 3,
	retryDelayMs: 1500,
	maxPasses: 2
} as const;

function loadEtherscanApiKey(): string {
	const key = process.env.ETHERSCAN_API_KEY;
	if (!key) throw new Error("[native-spend.config] Missing env var: ETHERSCAN_API_KEY");
	return key;
}

function loadMoralisApiKey(): string {
	const key = process.env.MORALIS_API_KEY;
	if (!key) throw new Error("[native-spend.config] Missing env var: MORALIS_API_KEY");
	return key;
}

export {
	nativeSpendWindowSeconds,
	nativeUsdPoolByNetwork,
	solanaFallbackNetwork,
	solanaFallbackPool,
	rebalanceBridgesByNetwork,
	svmOftProgramId,
	nativeSpendScanLimits,
	etherscanLimits,
	blockscoutLimits,
	routescanLimits,
	moralisLimits,
	loadEtherscanApiKey,
	loadMoralisApiKey
};
