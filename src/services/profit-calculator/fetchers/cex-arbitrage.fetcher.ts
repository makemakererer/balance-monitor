import ccxt, { Exchange, Trade } from "ccxt";
import {
	CexMarket,
	cexAccounts,
	cexMarkets,
	enabledNetworks,
	exchangeIdToNetwork,
	profitCexLimits
} from "../../../config";
import { CexAccountConfig, CexAccountId, CexExchangeId, Network, TokenSymbol } from "../../../types";
import { FetcherResult, ParsedTransaction, ProfitWindow, ScanFailure, TypeRoute } from "../../../types/profit-calculator.types";
import { log, retry, sleep } from "../../../utils";

class CexArbitrageFetcher {
	private readonly exchangeCache = new Map<CexAccountId, Exchange>();

	public async fetchByToken(token: TokenSymbol, window: ProfitWindow): Promise<FetcherResult> {
		const markets = cexMarkets[token] ?? [];
		if (markets.length === 0) {
			log.info(`[profit:${token}] no CEX markets configured for this token`);
			return { transactions: [], failures: [] };
		}

		const transactions: ParsedTransaction[] = [];
		const failures: ScanFailure[] = [];
		for (const market of markets) {
			const account = cexAccounts[market.accountId];
			const network = exchangeIdToNetwork[account.exchangeId];
			try {
				const marketTransactions = await this.fetchForMarket(token, market, window);
				transactions.push(...marketTransactions);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`[profit:${token}][${market.accountId}:${market.symbol}] CEX scan failed: ${message}`);
				failures.push({ network, detail: `${market.accountId}:${market.symbol} threw: ${message}` });
			}
		}
		return { transactions, failures };
	}

	private async fetchForMarket(
		token: TokenSymbol,
		market: CexMarket,
		window: ProfitWindow
	): Promise<ParsedTransaction[]> {
		const account = cexAccounts[market.accountId];
		const network = exchangeIdToNetwork[account.exchangeId];
		if (!enabledNetworks[network]) {
			log.info(`[profit:${token}][${market.accountId}] network ${network} disabled, skipping`);
			return [];
		}
		if (!account.apiKey || !account.secret) {
			log.warning(`[profit:${token}][${market.accountId}] credentials missing, skipping`);
			return [];
		}

		const baseSymbol = this.parseSymbolPart(market.symbol, 0);
		const quoteSymbol = this.parseSymbolPart(market.symbol, 1);
		if (!baseSymbol || !quoteSymbol) {
			log.warning(`[profit:${token}][${market.accountId}] symbol "${market.symbol}" has unknown base/quote, skipping`);
			return [];
		}

		const exchange = this.getOrCreateExchange(account);
		const trades = await this.fetchAllTrades(token, market, exchange, window);
		const orderGroups = this.aggregateTradesByOrder(trades);

		const transactions: ParsedTransaction[] = [];
		for (const fills of orderGroups) {
			const parsed = this.orderToTransaction(fills, baseSymbol, quoteSymbol, network);
			if (parsed) transactions.push(parsed);
		}
		log.success(`[profit:${token}][${market.accountId}:${market.symbol}] CEX orders: ${transactions.length} (fills: ${trades.length})`);
		return transactions;
	}

	private parseSymbolPart(marketSymbol: string, index: 0 | 1): TokenSymbol | null {
		const parts = marketSymbol.split("/");
		if (parts.length !== 2) return null;
		const raw = parts[index];
		const enumValues = Object.values(TokenSymbol);
		return enumValues.includes(raw as TokenSymbol) ? (raw as TokenSymbol) : null;
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
			throw new Error(`[cex-arb] ccxt does not export exchange "${exchangeId}"`);
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
				`[profit:${token}][${market.accountId}:${market.symbol}] fetched ${collected.length} trades (cursor: ${new Date(since).toISOString()})`
			);

			const lastTs = batch[batch.length - 1].timestamp;
			const reachedEnd = batch.length < profitCexLimits.tradesPageLimit || lastTs == null || lastTs >= endMs;
			if (reachedEnd) break;

			since = lastTs + 1;
			await sleep(profitCexLimits.interPageDelayMs);
		}
		return collected;
	}

	// Group fills by order id so partial fills of one market order roll up into a single arbitrage leg.
	// Fills without an order id stand alone (treated as a single-fill order).
	private aggregateTradesByOrder(trades: Trade[]): Trade[][] {
		const groups = new Map<string, Trade[]>();
		const standalone: Trade[][] = [];

		for (const trade of trades) {
			const orderId = trade.order;
			if (!orderId) {
				standalone.push([trade]);
				continue;
			}
			const existing = groups.get(orderId);
			if (existing) existing.push(trade);
			else groups.set(orderId, [trade]);
		}
		return [...groups.values(), ...standalone];
	}

	private orderToTransaction(
		fills: Trade[],
		baseSymbol: TokenSymbol,
		quoteSymbol: TokenSymbol,
		network: Network
	): ParsedTransaction | null {
		const first = fills[0];
		if (!first.side) return null;
		const isBuy = first.side === "buy";

		let baseAmount = 0;
		let quoteAmount = 0;
		let feeBase = 0;
		let feeQuote = 0;
		let earliestTimestamp = first.timestamp ?? 0;

		for (const fill of fills) {
			baseAmount += fill.amount ?? 0;
			quoteAmount += fill.cost ?? (fill.price ?? 0) * (fill.amount ?? 0);

			const feeCost = fill.fee?.cost ?? 0;
			if (feeCost > 0) {
				if (fill.fee?.currency === baseSymbol) feeBase += feeCost;
				else if (fill.fee?.currency === quoteSymbol) feeQuote += feeCost;
			}

			if (fill.timestamp != null && fill.timestamp < earliestTimestamp) {
				earliestTimestamp = fill.timestamp;
			}
		}

		// Mirror on-chain "amountOut after fee": deduct fee from the received side.
		const receivedAmount = isBuy ? baseAmount - feeBase : quoteAmount - feeQuote;
		const sentAmount = isBuy ? quoteAmount : baseAmount;
		const timestampSec = Math.floor(earliestTimestamp / 1000);
		if (timestampSec <= 0) return null;

		return {
			hash: first.order ?? first.id ?? `${first.timestamp}-${first.symbol}`,
			timestamp: new Date(timestampSec * 1000).toISOString(),
			network,
			type: isBuy ? TypeRoute.BUY : TypeRoute.SELL,
			tokenIn: isBuy ? quoteSymbol : baseSymbol,
			tokenOut: isBuy ? baseSymbol : quoteSymbol,
			amountIn: sentAmount.toFixed(5),
			amountOut: receivedAmount.toFixed(5),
			blockNumber: 0
		};
	}
}

export { CexArbitrageFetcher };
