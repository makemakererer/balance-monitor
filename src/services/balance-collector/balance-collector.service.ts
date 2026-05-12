import { isStableSymbol } from "../../config";
import { ChainSnapshot, GrandTotals, Network, Snapshot, TokenBalance, TokenSymbol } from "../../types";
import {
	COMMON_DECIMALS,
	convertDecimals,
	findTokenSource,
	log,
	readPreviousTotals,
	writeBalanceSnapshot
} from "../../utils";
import { TelegramService } from "../telegram/telegram.service";
import { CexBalanceService } from "./fetchers/cex-balance.service";
import { EvmBalanceService } from "./fetchers/evm-balance.service";
import { SvmBalanceService } from "./fetchers/svm-balance.service";

class BalanceCollectorService {
	private readonly evm = new EvmBalanceService();
	private readonly svm = new SvmBalanceService();
	private readonly cex = new CexBalanceService();
	private readonly telegram = new TelegramService();

	public async collectBalance(date: string): Promise<void> {
		const start = Date.now();
		log.info(`balance snapshot: starting fetch for ${date}`);
		const snapshot = await this.collectSnapshot(date);
		log.info(`balance snapshot: collected in ${this.elapsed(start)}s`);
		const previousTotals = readPreviousTotals(snapshot.date);
		const filePath = writeBalanceSnapshot(snapshot);
		log.success(`balance snapshot: saved → ${filePath}`);
		try {
			await this.telegram.sendSnapshot(snapshot, previousTotals);
			log.success(`balance snapshot: done in ${this.elapsed(start)}s`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram send failed: ${message}`);
		}
	}

	private async collectSnapshot(date: string): Promise<Snapshot> {
		log.info("EVM: fetching enabled chains");
		log.info("SVM: fetching enabled Solana wallet");
		log.info("CEX: fetching enabled accounts");

		const evmPromise = this.evm.collect().then((chains) => {
			log.success(`EVM: ${chains.length} chain(s) collected [${chains.map((c) => c.chain).join(", ")}]`);
			return chains;
		});
		const svmPromise = this.svm.collect().then((chains) => {
			log.success(`SVM: ${chains.length} chain(s) collected`);
			return chains;
		});
		const cexPromise = this.cex.collect().then((chains) => {
			log.success(`CEX: ${chains.length} exchange group(s) collected`);
			return chains;
		});

		const [evmChains, svmChains, cexChains] = await Promise.all([evmPromise, svmPromise, cexPromise]);
		const chains = [...evmChains, ...svmChains, ...cexChains];

		log.info("computing grand totals");

		return {
			date,
			generatedAt: new Date().toISOString(),
			chains,
			grandTotals: this.computeGrandTotals(chains)
		};
	}

	private elapsed(startMillis: number): string {
		return ((Date.now() - startMillis) / 1000).toFixed(1);
	}

	private computeGrandTotals(chains: ChainSnapshot[]): GrandTotals {
		const tokens: Partial<Record<TokenSymbol, bigint>> = {};
		const natives: Partial<Record<Network, TokenBalance>> = {};
		let stablesTotal = 0n;

		for (const chain of chains) {
			if (chain.chainTotals.native) {
				natives[chain.chain] = chain.chainTotals.native;
			}

			for (const symbol of Object.values(TokenSymbol)) {
				if (isStableSymbol(symbol)) {
					const stableAmount = this.sumSymbolAcrossSources(chain, symbol);
					if (stableAmount === 0n) continue;
					tokens[symbol] = (tokens[symbol] ?? 0n) + stableAmount;
					stablesTotal += stableAmount;
				} else {
					const primarySource = findTokenSource(chain, symbol);
					if (!primarySource) continue;
					const tokenBalance = primarySource.tokens.find((entry) => entry.symbol === symbol);
					if (!tokenBalance || tokenBalance.amount === null) continue;
					const normalized = convertDecimals(tokenBalance.amount, tokenBalance.decimals, COMMON_DECIMALS);
					tokens[symbol] = (tokens[symbol] ?? 0n) + normalized;
				}
			}
		}

		return { tokens, stablesTotal, natives };
	}

	private sumSymbolAcrossSources(chain: ChainSnapshot, symbol: TokenSymbol): bigint {
		let total = 0n;
		for (const source of chain.sources) {
			for (const tokenBalance of source.tokens) {
				if (tokenBalance.symbol !== symbol) continue;
				if (tokenBalance.amount === null) continue;
				total += convertDecimals(tokenBalance.amount, tokenBalance.decimals, COMMON_DECIMALS);
			}
		}
		return total;
	}
}

export { BalanceCollectorService };
