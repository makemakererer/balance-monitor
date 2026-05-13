import { chainTypeByNetwork } from "../../config";
import { profitMatcher } from "../../config";
import { ChainType, TokenSymbol } from "../../types";
import { MatchResult, MatchedArbitrage, ParsedTransaction, TypeRoute } from "../../types/profit-calculator.types";

class ArbitrageMatcherService {
	public match(transactions: ParsedTransaction[]): MatchResult {
		const sells = transactions.filter((tx) => tx.type === TypeRoute.SELL);
		const buys = transactions.filter((tx) => tx.type === TypeRoute.BUY);

		const matched: MatchedArbitrage[] = [];
		const usedBuyIndices = new Set<number>();

		for (const sell of sells) {
			const sellTime = Date.parse(sell.timestamp);
			let bestIndex = -1;
			let bestTimeDelta = profitMatcher.maxTimeDeltaMs + 1;

			for (let i = 0; i < buys.length; i++) {
				if (usedBuyIndices.has(i)) continue;
				if (!this.amountsMatch(buys[i], sell)) continue;

				const timeDelta = Math.abs(sellTime - Date.parse(buys[i].timestamp));
				if (timeDelta < bestTimeDelta) {
					bestIndex = i;
					bestTimeDelta = timeDelta;
				}
			}

			if (bestIndex === -1) continue;

			usedBuyIndices.add(bestIndex);
			const buy = buys[bestIndex];

			const stableSpent = parseFloat(buy.amountIn);
			const stableReceived = parseFloat(sell.amountOut);

			matched.push({
				input: sell,
				output: buy,
				timeDeltaMs: bestTimeDelta,
				route: `${buy.network} → ${sell.network}`,
				profitToken: this.resolveProfitToken(buy.tokenIn, sell.tokenOut),
				profitAmount: Number((stableReceived - stableSpent).toFixed(5))
			});
		}

		const matchedHashes = new Set<string>();
		for (const m of matched) {
			matchedHashes.add(m.input.hash);
			matchedHashes.add(m.output.hash);
		}

		const unmatched = transactions.filter((tx) => !matchedHashes.has(tx.hash));

		return { matched, unmatched };
	}

	private amountsMatch(buy: ParsedTransaction, sell: ParsedTransaction): boolean {
		// Strict equality preserves the on-chain↔on-chain case where both legs share the same wei value.
		if (buy.amountOut === sell.amountIn) return true;

		// Tolerance only when a leg is CEX — fills have rounding/slippage that breaks string equality.
		if (!this.involvesCex(buy, sell)) return false;

		const buyAmount = parseFloat(buy.amountOut);
		const sellAmount = parseFloat(sell.amountIn);
		if (buyAmount === 0 || sellAmount === 0) return false;

		const diff = Math.abs(buyAmount - sellAmount);
		const reference = Math.max(Math.abs(buyAmount), Math.abs(sellAmount));
		return diff / reference <= profitMatcher.cexAmountToleranceRelative;
	}

	private involvesCex(buy: ParsedTransaction, sell: ParsedTransaction): boolean {
		return chainTypeByNetwork[buy.network] === ChainType.CEX || chainTypeByNetwork[sell.network] === ChainType.CEX;
	}

	// Same stable on both legs → that stable. Mixed stables (e.g. USDT↔USDC) → USD as abstract marker.
	private resolveProfitToken(buyTokenIn: TokenSymbol, sellTokenOut: TokenSymbol): TokenSymbol {
		return buyTokenIn === sellTokenOut ? buyTokenIn : TokenSymbol.USD;
	}
}

export { ArbitrageMatcherService };
