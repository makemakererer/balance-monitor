import { nativeSpendWindowSeconds, tradingTokens } from "../../config";
import {
	NativeSpendSnapshot,
	NativeSpendWindow,
	RebalanceSpendEntry,
	TokenArbSpendEntry,
	TokenSymbol,
	UnattributedSpendRecord
} from "../../types";
import { log, nativeSpendSnapshotComplete, readNativeSpendSnapshot, writeNativeSpendSnapshot } from "../../utils";
import { FailedTxScanner } from "./failed-tx-scanner";
import { TelegramService } from "../telegram/telegram.service";
import { EvmArbSpendFetcher } from "./fetchers/evm-arb-spend.fetcher";
import { EvmRebalanceSpendFetcher } from "./fetchers/evm-rebalance-spend.fetcher";
import { SvmArbSpendFetcher } from "./fetchers/svm-arb-spend.fetcher";
import { SvmRebalanceSpendFetcher } from "./fetchers/svm-rebalance-spend.fetcher";
import { PriceResolverService } from "./price-resolver.service";
import { StatsCalculatorService } from "./stats-calculator.service";

class NativeSpendCalculatorService {
	private readonly telegram = new TelegramService();
	private readonly failedTx = new FailedTxScanner();
	private readonly evmArb = new EvmArbSpendFetcher(this.failedTx);
	private readonly svmArb = new SvmArbSpendFetcher();
	private readonly evmRebalance = new EvmRebalanceSpendFetcher(this.failedTx);
	private readonly svmRebalance = new SvmRebalanceSpendFetcher();
	private readonly priceResolver = new PriceResolverService();
	private readonly stats = new StatsCalculatorService();

	public async calculate(date: string): Promise<void> {
		if (nativeSpendSnapshotComplete(date)) {
			log.info(`native-spend: snapshot for ${date} already complete, skipping`);
			return;
		}

		const window = this.buildWindow(date);
		const runStart = Date.now();
		log.important(`NATIVE-SPEND: window ${window.fromIso} → ${window.toIso}`);

		const enabledTokens = (Object.keys(tradingTokens) as TokenSymbol[]).filter((token) => tradingTokens[token]);
		log.info(`native-spend: ${enabledTokens.length} trading token(s): ${enabledTokens.join(", ")}`);

		try {
			await this.telegram.sendNativeSpendStart(window, enabledTokens);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram native-spend start failed: ${message}`);
		}

		const snapshot = this.loadOrInitSnapshot(date, window);

		for (let index = 0; index < enabledTokens.length; index++) {
			const token = enabledTokens[index];
			const progress = `(${index + 1}/${enabledTokens.length})`;

			if (snapshot.arbSpend.perToken[token]) {
				log.info(`native-spend: ${token} ${progress} already in snapshot, skipping`);
				continue;
			}

			log.important(`native-spend: ${token} ${progress} starting`);
			const tokenStart = Date.now();
			const { tokenEntry, unattributedRecords } = await this.calculateArbSpendForToken(token, window, tokenStart);
			snapshot.arbSpend.perToken[token] = tokenEntry;
			this.appendUnattributed(snapshot, unattributedRecords);
			writeNativeSpendSnapshot(snapshot);
			log.success(`native-spend: ${token} ${progress} done in ${this.elapsed(tokenStart)}s`);

			try {
				await this.telegram.sendNativeSpendTokenReport(tokenEntry);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`telegram native-spend token ${token} failed: ${message}`);
			}
		}

		if (snapshot.rebalanceSpend === null) {
			log.important(`native-spend: rebalance pass starting`);
			const rebalanceStart = Date.now();
			const { rebalanceEntry, unattributedRecords } = await this.calculateRebalanceSpend(window, rebalanceStart);
			snapshot.rebalanceSpend = rebalanceEntry;
			this.appendUnattributed(snapshot, unattributedRecords);
			writeNativeSpendSnapshot(snapshot);
			log.success(`native-spend: rebalance pass done in ${this.elapsed(rebalanceStart)}s`);

			try {
				await this.telegram.sendNativeSpendRebalanceReport(snapshot.rebalanceSpend);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`telegram native-spend rebalance failed: ${message}`);
			}
		} else {
			log.info(`native-spend: rebalance pass already in snapshot, skipping`);
		}

		await this.priceUnattributed(snapshot, window);
		writeNativeSpendSnapshot(snapshot);

		snapshot.grandTotals = this.stats.calculate({
			perTokenEntries: Object.values(snapshot.arbSpend.perToken).filter(
				(entry): entry is TokenArbSpendEntry => entry !== undefined
			),
			rebalanceEntry: snapshot.rebalanceSpend,
			unattributedEntry: snapshot.unattributedSpend,
			startedAtMs: runStart
		});
		writeNativeSpendSnapshot(snapshot);
		log.important(`NATIVE-SPEND: done in ${this.elapsed(runStart)}s — total $${snapshot.grandTotals.totalUsd.toFixed(2)}`);

		try {
			await this.telegram.sendNativeSpendGrandTotals(snapshot);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram native-spend grand totals failed: ${message}`);
		}

		try {
			await this.telegram.sendNativeSpendFile(date);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.error(`telegram native-spend snapshot file failed: ${message}`);
		}
	}

	private async calculateArbSpendForToken(
		token: TokenSymbol,
		window: NativeSpendWindow,
		tokenStart: number
	): Promise<{ tokenEntry: TokenArbSpendEntry; unattributedRecords: UnattributedSpendRecord[] }> {
		const [evmResult, svmResult] = await Promise.all([
			this.evmArb.fetchByToken(token, window),
			this.svmArb.fetchByToken(token, window)
		]);
		const records = [...evmResult.records, ...svmResult.records];
		const scanFailures = [...evmResult.failures, ...svmResult.failures];

		const pricingFailures = await this.priceResolver.priceAll(window, records);
		scanFailures.push(...pricingFailures);

		records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

		return {
			tokenEntry: {
				token,
				fetchedAt: new Date().toISOString(),
				durationMs: Date.now() - tokenStart,
				records,
				scanFailures
			},
			unattributedRecords: [...evmResult.unattributedRecords, ...svmResult.unattributedRecords]
		};
	}

	private async calculateRebalanceSpend(
		window: NativeSpendWindow,
		rebalanceStart: number
	): Promise<{ rebalanceEntry: RebalanceSpendEntry; unattributedRecords: UnattributedSpendRecord[] }> {
		const [evmResult, svmResult] = await Promise.all([
			this.evmRebalance.fetch(window),
			this.svmRebalance.fetch(window)
		]);
		const records = [...evmResult.records, ...svmResult.records];
		const scanFailures = [...evmResult.failures, ...svmResult.failures];

		const pricingFailures = await this.priceResolver.priceAll(window, records);
		scanFailures.push(...pricingFailures);

		records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

		return {
			rebalanceEntry: {
				fetchedAt: new Date().toISOString(),
				durationMs: Date.now() - rebalanceStart,
				records,
				scanFailures
			},
			unattributedRecords: [...evmResult.unattributedRecords, ...svmResult.unattributedRecords]
		};
	}

	// Dedup by txHash: on resume the arb fetcher may re-claim a chain it already
	// processed in the previous run and re-emit identical unattributed records.
	private appendUnattributed(snapshot: NativeSpendSnapshot, incoming: UnattributedSpendRecord[]): void {
		if (incoming.length === 0) return;
		if (!snapshot.unattributedSpend) {
			snapshot.unattributedSpend = {
				fetchedAt: new Date().toISOString(),
				durationMs: 0,
				records: [],
				scanFailures: []
			};
		}
		const seen = new Set(snapshot.unattributedSpend.records.map((r) => r.txHash));
		for (const rec of incoming) {
			if (seen.has(rec.txHash)) continue;
			seen.add(rec.txHash);
			snapshot.unattributedSpend.records.push(rec);
		}
	}

	private async priceUnattributed(snapshot: NativeSpendSnapshot, window: NativeSpendWindow): Promise<void> {
		const entry = snapshot.unattributedSpend;
		if (!entry) return;
		const unpriced = entry.records.filter((r) => r.usdAmount === null);
		if (unpriced.length === 0) return;
		const failures = await this.priceResolver.priceAll(window, unpriced);
		entry.scanFailures.push(...failures);
		entry.records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
	}

	private loadOrInitSnapshot(date: string, window: NativeSpendWindow): NativeSpendSnapshot {
		const existing = readNativeSpendSnapshot(date);
		if (existing && existing.grandTotals === null) {
			const doneTokens = Object.keys(existing.arbSpend.perToken).length;
			const rebalanceDone = existing.rebalanceSpend !== null;
			log.info(
				`native-spend: resuming partial snapshot (${doneTokens} token(s) done, rebalance=${rebalanceDone ? "done" : "pending"})`
			);
			if (existing.unattributedSpend === undefined) existing.unattributedSpend = null;
			return existing;
		}
		return {
			date,
			generatedAt: new Date().toISOString(),
			window,
			arbSpend: { perToken: {} },
			rebalanceSpend: null,
			unattributedSpend: null,
			grandTotals: null
		};
	}

	private buildWindow(date: string): NativeSpendWindow {
		const dayStartMs = Date.parse(`${date}T00:00:00Z`);
		if (Number.isNaN(dayStartMs)) throw new Error(`[native-spend] invalid date: ${date}`);
		const toTimestampSeconds = Math.floor(dayStartMs / 1000);
		const fromTimestampSeconds = toTimestampSeconds - nativeSpendWindowSeconds;
		return {
			fromTimestampSeconds,
			toTimestampSeconds,
			fromIso: new Date(fromTimestampSeconds * 1000).toISOString(),
			toIso: new Date(toTimestampSeconds * 1000).toISOString()
		};
	}

	private elapsed(startMillis: number): string {
		return ((Date.now() - startMillis) / 1000).toFixed(1);
	}
}

export { NativeSpendCalculatorService };
