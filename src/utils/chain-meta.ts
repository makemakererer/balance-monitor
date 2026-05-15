import { evmChainMetadata, svmChainMetadata, tokenConfig, tokensToChain } from "../config";
import { Network, TokenSymbol } from "../types";
import { log } from "./logger";

interface NativeMeta {
	symbol: TokenSymbol;
	decimals: number;
}

function resolveNativeMeta(network: Network): NativeMeta {
	const evm = evmChainMetadata[network];
	if (evm) return { symbol: evm.nativeSymbol, decimals: evm.nativeDecimals };
	const svm = svmChainMetadata[network];
	if (svm) return { symbol: svm.nativeSymbol, decimals: svm.nativeDecimals };
	throw new Error(`[chain-meta] no chain metadata for network ${network}`);
}

// Sort comparator: USD descending, nulls last, alphabetical tiebreak by tieKey.
function compareUsdDescending(
	leftUsd: number | null,
	rightUsd: number | null,
	leftTieKey: string,
	rightTieKey: string
): number {
	if (leftUsd === null && rightUsd === null) return leftTieKey.localeCompare(rightTieKey);
	if (leftUsd === null) return 1;
	if (rightUsd === null) return -1;
	return rightUsd - leftUsd;
}

interface SvmMintInfo {
	symbol: TokenSymbol;
	decimals: number;
}

function buildSvmMintLookup(): Map<string, SvmMintInfo> {
	const map = new Map<string, SvmMintInfo>();
	const solanaTokens = tokensToChain[Network.SOLANA] ?? {};
	for (const mint of Object.values(solanaTokens)) {
		const meta = tokenConfig[mint];
		if (!meta) {
			log.warning(`[SOLANA] mint ${mint} in tokensToChain but absent from tokenConfig — skipping`);
			continue;
		}
		map.set(mint, { symbol: meta.symbol, decimals: meta.decimals });
	}
	return map;
}

export { NativeMeta, resolveNativeMeta, compareUsdDescending, SvmMintInfo, buildSvmMintLookup };
