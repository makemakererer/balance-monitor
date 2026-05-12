import { evmChainMetadata, svmChainMetadata, vaultExecutorAddresses } from "../config";
import { ChainSnapshot, ChainType, Network, Snapshot, SourceBalance, SourceType, TokenBalance, TokenSymbol } from "../types";
import { convertDecimals, formatAmount } from "./decimals";

function collectNativeSymbols(): Set<TokenSymbol> {
	const set = new Set<TokenSymbol>();
	for (const meta of Object.values(evmChainMetadata)) {
		if (meta) set.add(meta.nativeSymbol);
	}
	for (const meta of Object.values(svmChainMetadata)) {
		if (meta) set.add(meta.nativeSymbol);
	}
	return set;
}

function hasAnyVault(symbol: TokenSymbol): boolean {
	for (const network of Object.values(Network)) {
		if (vaultExecutorAddresses[network]?.[symbol]) return true;
	}
	return false;
}

function orderedChains(snapshot: Snapshot): ChainSnapshot[] {
	const byNetwork = new Map<Network, ChainSnapshot>(snapshot.chains.map((chain) => [chain.chain, chain]));
	const ordered: ChainSnapshot[] = [];
	for (const network of Object.values(Network)) {
		const chain = byNetwork.get(network);
		if (chain) ordered.push(chain);
	}
	return ordered;
}

function findTokenSource(chain: ChainSnapshot, symbol: TokenSymbol): SourceBalance | undefined {
	const vault = chain.sources.find(
		(source) => source.type === SourceType.VAULT && source.label === `Vault ${symbol}`
	);
	if (vault) return vault;
	if (chain.chainType === ChainType.SVM) {
		return chain.sources.find((source) => source.type === SourceType.WALLET_ARB);
	}
	if (chain.chainType === ChainType.CEX) {
		return chain.sources.find(
			(source) =>
				source.type === SourceType.CEX_ACCOUNT &&
				source.tokens.some(
					(tokenBalance) =>
						tokenBalance.symbol === symbol && tokenBalance.amount !== null && tokenBalance.amount > 0n
				)
		);
	}
	return undefined;
}

function isHiddenZero(balance: TokenBalance | undefined): boolean {
	if (balance === undefined) return true;
	if (balance.amount === null) return false;
	return formatAmount(balance.amount, balance.decimals) === "0";
}

interface StableSourceRow {
	label: string;
	amount: bigint;
	decimals: number;
}

interface StableChainBreakdown {
	sources: StableSourceRow[];
	total: bigint;
	totalDecimals: number;
}

const STABLE_DUST_CENTS = 1n;

function collectStableSources(symbol: TokenSymbol, chain: ChainSnapshot): StableChainBreakdown | null {
	const sources: StableSourceRow[] = [];
	let totalDecimals: number | null = null;
	let total = 0n;

	for (const source of chain.sources) {
		for (const tokenBalance of source.tokens) {
			if (tokenBalance.symbol !== symbol) continue;
			if (tokenBalance.amount === null) continue;
			if (tokenBalance.decimals < 2) continue;
			const dustThreshold = STABLE_DUST_CENTS * 10n ** BigInt(tokenBalance.decimals - 2);
			if (tokenBalance.amount < dustThreshold) continue;
			if (totalDecimals === null) totalDecimals = tokenBalance.decimals;
			sources.push({ label: source.label, amount: tokenBalance.amount, decimals: tokenBalance.decimals });
			total += convertDecimals(tokenBalance.amount, tokenBalance.decimals, totalDecimals);
		}
	}

	if (sources.length === 0 || totalDecimals === null) return null;
	return { sources, total, totalDecimals };
}

interface NativeSourceRow {
	label: string;
	amount: bigint;
}

interface NativeChainBreakdown {
	symbol: TokenSymbol;
	decimals: number;
	sources: NativeSourceRow[];
	total: bigint;
}

function collectNativeSources(chain: ChainSnapshot): NativeChainBreakdown | null {
	const sources: NativeSourceRow[] = [];
	let total = 0n;
	let symbol: TokenSymbol | null = null;
	let decimals = 18;

	for (const source of chain.sources) {
		if (!source.native) continue;
		if (source.native.amount === null || source.native.amount === 0n) continue;
		sources.push({ label: source.label, amount: source.native.amount });
		total += source.native.amount;
		symbol = source.native.symbol;
		decimals = source.native.decimals;
	}

	if (sources.length === 0 || symbol === null) return null;
	return { symbol, decimals, sources, total };
}

export {
	collectNativeSymbols,
	hasAnyVault,
	orderedChains,
	findTokenSource,
	isHiddenZero,
	collectStableSources,
	collectNativeSources,
	NativeChainBreakdown,
	NativeSourceRow,
	StableChainBreakdown,
	StableSourceRow
};
