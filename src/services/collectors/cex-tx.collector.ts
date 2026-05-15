import ccxt, { Exchange, Trade } from "ccxt";
import {
	CexMarket,
	cexAccounts,
	cexMarkets,
	enabledNetworks,
	exchangeIdToNetwork,
	profitCexLimits
} from "../../config";
import {
	CexAccountConfig,
	CexArbCollected,
	CexExchangeId,
	CexMarketTrades,
	ProfitWindow,
	ScanFailure,
	TokenSymbol
} from "../../types";
import { errorMessage, log, retry, sleep } from "../../utils";

// Pure I/O collector. Fetches `Trade[]` per (token, market) from each CEX account.
// Order-grouping, symbol parsing, and ParsedTransaction conversion all live in
// ProfitCalculator.
class CexTxCollector {
	private readonly exchangeCache = new Map<string, Exchange>();

	public async collectByToken(token: TokenSymbol, window: ProfitWindow): Promise<CexArbCollected> {
		const markets = cexMarkets[token] ?? [];
		if (markets.length === 0) {
			log.info(`[cex-collector:${token}] no CEX markets configured for this token`);
			return { token, perMarket: [], failures: [] };
		}

		const perMarket: CexMarketTrades[] = [];
		const failures: ScanFailure[] = [];
		for (const market of markets) {
			const account = cexAccounts[market.accountId];
			const network = exchangeIdToNetwork[account.exchangeId];
			try {
				const trades = await this.fetchForMarket(token, market, window);
				if (trades !== null) perMarket.push({ market, trades });
			} catch (error) {
				const message = errorMessage(error);
				log.error(`[cex-collector:${token}][${market.accountId}:${market.symbol}] CEX scan failed: ${message}`);
				failures.push({ network, detail: `${market.accountId}:${market.symbol} threw: ${message}` });
			}
		}
		return { token, perMarket, failures };
	}

	private async fetchForMarket(token: TokenSymbol, market: CexMarket, window: ProfitWindow): Promise<Trade[] | null> {
		const account = cexAccounts[market.accountId];
		const network = exchangeIdToNetwork[account.exchangeId];
		if (!enabledNetworks[network]) {
			log.info(`[cex-collector:${token}][${market.accountId}] network ${network} disabled, skipping`);
			return null;
		}
		if (!account.apiKey || !account.secret) {
			log.warning(`[cex-collector:${token}][${market.accountId}] credentials missing, skipping`);
			return null;
		}

		const exchange = this.getOrCreateExchange(account);
		const trades = await this.fetchAllTrades(token, market, exchange, window);
		log.success(`[cex-collector:${token}][${market.accountId}:${market.symbol}] fills: ${trades.length}`);
		return trades;
	}

	private getOrCreateExchange(account: CexAccountConfig): Exchange {
		const cached = this.exchangeCache.get(account.id);
		if (cached) return cached;
		const exchange = this.instantiateExchange(account.exchangeId, account.apiKey, account.secret);
		this.exchangeCache.set(account.id, exchange);
		return exchange;
	}

	private instantiateExchange(exchangeId: CexExchangeId, apiKey: string, secret: string): Exchange {
		const ExchangeClass = (ccxt as unknown as Record<string, new (params: object) => Exchange>)[exchangeId];
		if (!ExchangeClass) {
			throw new Error(`[cex-collector] ccxt does not export exchange "${exchangeId}"`);
		}
		return new ExchangeClass({ apiKey, secret, enableRateLimit: true });
	}

	private async fetchAllTrades(
		token: TokenSymbol,
		market: CexMarket,
		exchange: Exchange,
		window: ProfitWindow
	): Promise<Trade[]> {
		const startMs = window.fromTimestampSeconds * 1000;
		const endMs = window.toTimestampSeconds * 1000;

		const collected: Trade[] = [];
		let since = startMs;

		while (true) {
			const batch = await retry(
				() => exchange.fetchMyTrades(market.symbol, since, profitCexLimits.tradesPageLimit),
				`cex ${market.accountId}:${market.symbol} fetchMyTrades`
			);
			if (!batch || batch.length === 0) break;

			const inRange = batch.filter((t) => t.timestamp != null && t.timestamp <= endMs);
			collected.push(...inRange);

			log.info(
				`[cex-collector:${token}][${market.accountId}:${market.symbol}] fetched ${collected.length} trades (cursor: ${new Date(since).toISOString()})`
			);

			const lastTs = batch[batch.length - 1].timestamp;
			const reachedEnd = batch.length < profitCexLimits.tradesPageLimit || lastTs == null || lastTs >= endMs;
			if (reachedEnd) break;

			since = lastTs + 1;
			await sleep(profitCexLimits.interPageDelayMs);
		}
		return collected;
	}
}

export { CexTxCollector };
