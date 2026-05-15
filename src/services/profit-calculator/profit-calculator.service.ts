import { Trade } from "ccxt";
import { ethers } from "ethers";
import { cexAccounts, exchangeIdToNetwork, loadMonitoredSvmWallet, tokenConfig } from "../../config";
import {
	CexArbCollected,
	EvmArbCollected,
	EvmArbCollectedNetwork,
	MatchedArbitrage,
	Network,
	NetworkBreakdown,
	ParsedTransaction,
	ProfitGrandTotals,
	ProfitSnapshot,
	ProfitWindow,
	RouteStats,
	ScanFailure,
	SvmParsedTx,
	SvmTxCollected,
	TokenProfitEntry,
	TokenSymbol,
	TypeRoute
} from "../../types";
import { SvmMintInfo, buildSvmMintLookup, log, roundProfit5 } from "../../utils";
import { ArbitrageMatcherService } from "./arbitrage-matcher.service";
import { StatsCalculatorService } from "./stats-calculator.service";

class ProfitCalculatorService {
	private readonly matcher = new ArbitrageMatcherService();
	private readonly stats = new StatsCalculatorService();

	// Stateless per-token compute. Takes raw on-chain/CEX data already collected
	// by the orchestrator and produces a TokenProfitEntry. No I/O.
	public calculateForToken(args: {
		token: TokenSymbol;
		window: ProfitWindow;
		evmData: EvmArbCollected;
		svm: SvmTxCollected;
		cexData: CexArbCollected;
	}): TokenProfitEntry {
		const { token, window, evmData, svm, cexData } = args;
		const tokenStart = Date.now();

		const evmTransactions = this.buildEvmTransactions(evmData, window);
		const svmTransactions = this.buildSvmTransactions(svm.arbTxs, token);
		const cexTransactions = this.buildCexTransactions(cexData);

		const transactions = [...evmTransactions, ...svmTransactions, ...cexTransactions];
		transactions.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

		const scanFailures: ScanFailure[] = [...evmData.failures, ...svm.failures, ...cexData.failures];

		const matchResult = this.matcher.match(transactions);
		const stats = this.stats.calculate(token, window, transactions, matchResult);

		return {
			token,
			fetchedAt: new Date().toISOString(),
			durationMs: Date.now() - tokenStart,
			stats,
			matched: matchResult.matched,
			unmatched: matchResult.unmatched,
			scanFailures
		};
	}

	// Grand totals across all per-token entries in the snapshot.
	public computeGrandTotals(snapshot: ProfitSnapshot): ProfitGrandTotals {
		const entries = Object.values(snapshot.perToken).filter((entry): entry is TokenProfitEntry => entry !== undefined);

		const byToken = entries.map((entry) => ({
			token: entry.token,
			profitToken: entry.stats.profit.profitToken,
			total: entry.stats.profit.total,
			matchedPairs: entry.stats.totals.matchedPairs
		}));

		const allMatched: MatchedArbitrage[] = [];
		const allTransactions: ParsedTransaction[] = [];
		for (const entry of entries) {
			allMatched.push(...entry.matched);
			allTransactions.push(...entry.matched.flatMap((m) => [m.input, m.output]));
			allTransactions.push(...entry.unmatched);
		}

		const totalMatched = entries.reduce((sum, entry) => sum + entry.stats.totals.matchedPairs, 0);
		const totalUnmatched = entries.reduce((sum, entry) => sum + entry.stats.totals.unmatched, 0);
		const totalTransactions = entries.reduce((sum, entry) => sum + entry.stats.totals.transactions, 0);
		const overallMatchRate = totalTransactions > 0
			? (((totalMatched * 2) / totalTransactions) * 100).toFixed(1) + "%"
			: "0.0%";
		const durationMs = entries.reduce((sum, entry) => sum + entry.durationMs, 0);

		return {
			completedAt: new Date().toISOString(),
			durationMs,
			byToken,
			totalMatched,
			totalUnmatched,
			totalTransactions,
			overallMatchRate,
			byNetwork: this.aggregateByNetwork(allTransactions),
			byRoute: this.aggregateByRoute(allMatched)
		};
	}

	private buildEvmTransactions(evmData: EvmArbCollected, window: ProfitWindow): ParsedTransaction[] {
		const out: ParsedTransaction[] = [];
		for (const networkData of evmData.perNetwork) {
			out.push(...this.buildEvmTransactionsForNetwork(networkData, window));
		}
		return out;
	}

	private buildEvmTransactionsForNetwork(
		networkData: EvmArbCollectedNetwork,
		window: ProfitWindow
	): ParsedTransaction[] {
		const out: ParsedTransaction[] = [];
		for (const raw of networkData.events) {
			const block = networkData.blocks.get(raw.blockNumber);
			if (!block) continue;
			if (block.timestamp < window.fromTimestampSeconds || block.timestamp > window.toTimestampSeconds) continue;

			const tokenInMeta = tokenConfig[raw.tokenInAddress];
			const tokenOutMeta = tokenConfig[raw.tokenOutAddress];
			if (!tokenInMeta) {
				log.warning(
					`[${networkData.network}] unknown tokenIn ${raw.tokenInAddress} in tx ${raw.transactionHash} — dropping event`
				);
				continue;
			}
			if (!tokenOutMeta) {
				log.warning(
					`[${networkData.network}] unknown tokenOut ${raw.tokenOutAddress} in tx ${raw.transactionHash} — dropping event`
				);
				continue;
			}
			out.push({
				hash: raw.transactionHash,
				timestamp: new Date(block.timestamp * 1000).toISOString(),
				network: networkData.network,
				type: raw.type,
				tokenIn: tokenInMeta.symbol,
				tokenOut: tokenOutMeta.symbol,
				amountIn: parseFloat(ethers.formatUnits(raw.amountIn, tokenInMeta.decimals)).toFixed(5),
				amountOut: parseFloat(ethers.formatUnits(raw.amountOut, tokenOutMeta.decimals)).toFixed(5),
				blockNumber: raw.blockNumber
			});
		}
		return out;
	}

	private buildSvmTransactions(arbTxs: SvmParsedTx[], targetToken: TokenSymbol): ParsedTransaction[] {
		const mintLookup = buildSvmMintLookup();
		const walletAddress = loadMonitoredSvmWallet();
		const out: ParsedTransaction[] = [];
		for (const { sigInfo, tx } of arbTxs) {
			if (!tx.meta || tx.meta.err) continue;
			const changes = this.getSvmTokenBalanceChanges(tx, walletAddress, mintLookup);
			if (changes.length < 2) continue;

			const received = changes.find((c) => c.change > 0n);
			const sent = changes.find((c) => c.change < 0n);
			if (!received || !sent) continue;

			const receivedMeta = mintLookup.get(received.mint);
			const sentMeta = mintLookup.get(sent.mint);
			if (!receivedMeta || !sentMeta) continue;
			if (receivedMeta.symbol !== targetToken && sentMeta.symbol !== targetToken) continue;
			if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) continue;

			const type = sentMeta.symbol === targetToken ? TypeRoute.SELL : TypeRoute.BUY;
			const amountIn = parseFloat(ethers.formatUnits(-sent.change, sentMeta.decimals)).toFixed(5);
			const amountOut = parseFloat(ethers.formatUnits(received.change, receivedMeta.decimals)).toFixed(5);

			out.push({
				hash: sigInfo.signature,
				timestamp: new Date(sigInfo.blockTime * 1000).toISOString(),
				network: Network.SOLANA,
				type,
				tokenIn: sentMeta.symbol,
				tokenOut: receivedMeta.symbol,
				amountIn,
				amountOut,
				blockNumber: sigInfo.slot
			});
		}
		return out;
	}

	private buildCexTransactions(cexData: CexArbCollected): ParsedTransaction[] {
		const out: ParsedTransaction[] = [];
		for (const entry of cexData.perMarket) {
			const baseSymbol = this.parseCexSymbolPart(entry.market.symbol, 0);
			const quoteSymbol = this.parseCexSymbolPart(entry.market.symbol, 1);
			if (!baseSymbol || !quoteSymbol) {
				log.warning(
					`[profit:cex][${entry.market.accountId}] symbol "${entry.market.symbol}" has unknown base/quote — skipping`
				);
				continue;
			}
			const network = exchangeIdToNetwork[cexAccounts[entry.market.accountId].exchangeId];
			const orderGroups = this.groupTradesByOrder(entry.trades);
			for (const fills of orderGroups) {
				const parsed = this.orderToTransaction(fills, baseSymbol, quoteSymbol, network);
				if (parsed) out.push(parsed);
			}
		}
		return out;
	}

	private getSvmTokenBalanceChanges(
		tx: SvmParsedTx["tx"],
		walletAddress: string,
		mintLookup: Map<string, SvmMintInfo>
	): { mint: string; change: bigint }[] {
		const pre = tx.meta?.preTokenBalances ?? [];
		const post = tx.meta?.postTokenBalances ?? [];
		const changes: { mint: string; change: bigint }[] = [];

		for (const postEntry of post) {
			if (postEntry.owner !== walletAddress) continue;
			const preEntry = pre.find((b) => b.mint === postEntry.mint && b.owner === postEntry.owner);
			const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
			const postAmount = BigInt(postEntry.uiTokenAmount.amount);
			const change = postAmount - preAmount;
			if (change !== 0n && mintLookup.has(postEntry.mint)) {
				changes.push({ mint: postEntry.mint, change });
			}
		}
		return changes;
	}

	private parseCexSymbolPart(marketSymbol: string, index: 0 | 1): TokenSymbol | null {
		const parts = marketSymbol.split("/");
		if (parts.length !== 2) return null;
		const raw = parts[index];
		const enumValues = Object.values(TokenSymbol);
		return enumValues.includes(raw as TokenSymbol) ? (raw as TokenSymbol) : null;
	}

	// Group fills by order id so partial fills of one market order roll up into a single arbitrage leg.
	// Fills without an order id stand alone (treated as a single-fill order).
	private groupTradesByOrder(trades: Trade[]): Trade[][] {
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

	private aggregateByNetwork(transactions: ParsedTransaction[]): NetworkBreakdown[] {
		const counts = new Map<string, { inputCount: number; outputCount: number }>();
		for (const tx of transactions) {
			const entry = counts.get(tx.network) ?? { inputCount: 0, outputCount: 0 };
			if (tx.type === TypeRoute.SELL) entry.inputCount++;
			else entry.outputCount++;
			counts.set(tx.network, entry);
		}
		const breakdown: NetworkBreakdown[] = [];
		for (const [network, c] of counts) {
			breakdown.push({
				network: network as NetworkBreakdown["network"],
				inputCount: c.inputCount,
				outputCount: c.outputCount,
				totalCount: c.inputCount + c.outputCount
			});
		}
		return breakdown.sort((a, b) => b.totalCount - a.totalCount);
	}

	private aggregateByRoute(matched: MatchedArbitrage[]): RouteStats[] {
		const routeMap = new Map<string, number[]>();
		for (const m of matched) {
			const profits = routeMap.get(m.route) ?? [];
			profits.push(m.profitAmount);
			routeMap.set(m.route, profits);
		}
		const stats: RouteStats[] = [];
		for (const [route, profits] of routeMap) {
			const sorted = [...profits].sort((a, b) => a - b);
			const total = profits.reduce((sum, p) => sum + p, 0);
			stats.push({
				route,
				count: profits.length,
				totalProfit: roundProfit5(total),
				avgProfit: roundProfit5(total / profits.length),
				minProfit: roundProfit5(sorted[0]),
				maxProfit: roundProfit5(sorted[sorted.length - 1])
			});
		}
		return stats.sort((a, b) => b.totalProfit - a.totalProfit);
	}
}

export { ProfitCalculatorService };
