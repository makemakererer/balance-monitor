import ccxt, { Balances, Exchange } from "ccxt";
import { ethers } from "ethers";
import { cexAccounts, enabledNetworks, exchangeIdToNetwork, tokensToChain } from "../../../config";
import {
	CexAccountConfig,
	CexExchangeId,
	ChainSnapshot,
	ChainType,
	Network,
	SourceBalance,
	SourceType,
	TokenBalance,
	TokenSymbol
} from "../../../types";
import { COMMON_DECIMALS, log, retry } from "../../../utils";

class CexBalanceService {
	public async collect(): Promise<ChainSnapshot[]> {
		const enabledAccounts = Object.values(cexAccounts).filter((account) => {
			const network = exchangeIdToNetwork[account.exchangeId];
			if (!enabledNetworks[network]) return false;
			if (!account.apiKey || !account.secret) {
				log.warning(`[CEX ${account.id}] skipped: credentials not configured`);
				return false;
			}
			return true;
		});

		const collected = await Promise.all(enabledAccounts.map((account) => this.collectAccount(account)));

		const sourcesByNetwork = new Map<Network, SourceBalance[]>();
		for (let index = 0; index < enabledAccounts.length; index++) {
			const network = exchangeIdToNetwork[enabledAccounts[index].exchangeId];
			const bucket = sourcesByNetwork.get(network) ?? [];
			bucket.push(collected[index]);
			sourcesByNetwork.set(network, bucket);
		}

		const chains: ChainSnapshot[] = [];
		for (const [network, sources] of sourcesByNetwork) {
			chains.push({
				chain: network,
				chainType: ChainType.CEX,
				sources,
				chainTotals: this.computeChainTotals(sources)
			});
		}
		return chains;
	}

	private async collectAccount(account: CexAccountConfig): Promise<SourceBalance> {
		const network = exchangeIdToNetwork[account.exchangeId];
		const exchange = this.instantiateExchange(account.exchangeId, account.apiKey, account.secret);

		try {
			const balance = await retry(() => exchange.fetchBalance(), `cex ${account.id} fetchBalance`);
			return this.buildSource(account, network, balance);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				type: SourceType.CEX_ACCOUNT,
				label: account.id,
				native: null,
				tokens: [],
				error: message
			};
		}
	}

	private instantiateExchange(exchangeId: CexExchangeId, apiKey: string, secret: string): Exchange {
		const ExchangeClass = (ccxt as unknown as Record<string, new (params: object) => Exchange>)[exchangeId];
		if (!ExchangeClass) {
			throw new Error(`[cex-balance] ccxt does not export exchange "${exchangeId}"`);
		}
		return new ExchangeClass({ apiKey, secret, enableRateLimit: true });
	}

	private buildSource(account: CexAccountConfig, network: Network, balance: Balances): SourceBalance {
		const watchedTokens = tokensToChain[network];
		if (!watchedTokens) {
			throw new Error(`[cex-balance] missing tokensToChain[${network}]`);
		}

		const tokens: TokenBalance[] = [];

		for (const symbol of Object.keys(watchedTokens) as TokenSymbol[]) {
			const ticker = watchedTokens[symbol];
			const numericTotal = Number(balance[ticker]?.total ?? 0);
			if (!Number.isFinite(numericTotal) || numericTotal <= 0) continue;

			tokens.push({
				symbol,
				address: ticker,
				amount: ethers.parseUnits(numericTotal.toString(), COMMON_DECIMALS),
				decimals: COMMON_DECIMALS,
				error: null
			});
		}

		return {
			type: SourceType.CEX_ACCOUNT,
			label: account.id,
			native: null,
			tokens,
			error: null
		};
	}

	private computeChainTotals(sources: SourceBalance[]): ChainSnapshot["chainTotals"] {
		const tokens: Partial<Record<TokenSymbol, bigint>> = {};
		for (const source of sources) {
			for (const tokenBalance of source.tokens) {
				if (tokenBalance.amount === null) continue;
				tokens[tokenBalance.symbol] = (tokens[tokenBalance.symbol] ?? 0n) + tokenBalance.amount;
			}
		}
		return { tokens, native: null };
	}
}

export { CexBalanceService };
