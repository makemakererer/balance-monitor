import {
	chainTypeByNetwork,
	dailyReportConfig,
	enabledNetworks,
	isStableSymbol,
	loadMonitoredEvmWallets,
	tradingTokens,
	vaultExecutorAddresses
} from "../../config";
import {
	ChainType,
	DailyTotals,
	EvmArbCollected,
	FailedTxCollectedNetwork,
	NativeSpendSnapshot,
	NativeSpendWindow,
	Network,
	ProfitSnapshot,
	RebalanceCollected,
	ScanFailure,
	Snapshot,
	SvmTxCollected,
	TokenArbSpendEntry,
	TokenDayCard,
	TokenSymbol,
	UnattributedSpendRecord
} from "../../types";
import {
	errorMessage,
	log,
	nativeSpendSnapshotPath,
	profitSnapshotPath,
	readNativeSpendSnapshot,
	readPreviousTotals,
	readProfitSnapshot,
	snapshotExists,
	writeBalanceSnapshot,
	writeNativeSpendSnapshot,
	writeProfitSnapshot
} from "../../utils";
import { BalanceCollectorService } from "../balance-collector/balance-collector.service";
import { CexTxCollector } from "../collectors/cex-tx.collector";
import { EvmArbTxCollector } from "../collectors/evm-arb-tx.collector";
import { BlockRange, EvmBlockRangeResolver } from "../collectors/evm-block-range.resolver";
import { FailedTxCollector, UnsupportedFailedTxChainError } from "../collectors/failed-tx-collector";
import { RebalanceTxCollector } from "../collectors/rebalance-tx.collector";
import { SvmTxCollector } from "../collectors/svm-tx.collector";
import { NativeSpendCalculatorService } from "../native-spend-calculator/native-spend-calculator.service";
import { ProfitCalculatorService } from "../profit-calculator/profit-calculator.service";
import { RemintService } from "../remint/remint.service";
import { TelegramService } from "../telegram/telegram.service";
import { buildTokenDayCard, renderDailyTotal, renderTokenCard } from "./formatters";

class DailyReportService {
	private readonly remint = new RemintService();
	private readonly profit = new ProfitCalculatorService();
	private readonly nativeSpend = new NativeSpendCalculatorService();
	private readonly balanceCollector = new BalanceCollectorService();
	private readonly telegram = new TelegramService();
	// Collectors and the block-range resolver are constructed fresh per `run()`
	// so caches don't leak across daily runs (see initCollectors).
	private blockRange = new EvmBlockRangeResolver();
	private failedTx = new FailedTxCollector();
	private evmArbCollector = new EvmArbTxCollector(this.blockRange);
	private svmCollector = new SvmTxCollector();
	private rebalanceCollector = new RebalanceTxCollector(this.blockRange);
	private cexCollector = new CexTxCollector();

	// Full daily pipeline: remint → profit/native per-token → balance snapshot.
	// `attempt` lets the scheduler suppress the "Daily run started" Telegram signal
	// on retries (only the first attempt fires it).
	public async run(attempt: number = 0): Promise<void> {
		const date = todayUtcDate();
		if (snapshotExists(date)) {
			log.info(`daily-report: snapshot for ${date} already exists, skipping`);
			return;
		}

		this.initCollectors();
		const window = this.buildWindow(date);
		const runStart = Date.now();
		log.important(`DAILY RUN: started — ${date}`);
		if (attempt === 0) await this.notifyDailyRunStart(date);

		await this.runRemintSafely(date);
		await this.runReportingSafely(date, window, runStart);
		log.important(`daily-report: balance snapshot — collecting EVM + SVM + CEX balances`);
		await this.balanceCollector.collectSnapshot(date).then(async (snapshot) => {
			await this.persistAndSendBalanceSnapshot(snapshot);
		});

		const durationMs = Date.now() - runStart;
		log.important(`DAILY RUN: finished — ${date} in ${(durationMs / 1000).toFixed(1)}s`);
		await this.notifyDailyRunFinish(date, durationMs);
	}

	private initCollectors(): void {
		this.blockRange = new EvmBlockRangeResolver();
		this.failedTx = new FailedTxCollector();
		this.evmArbCollector = new EvmArbTxCollector(this.blockRange);
		this.svmCollector = new SvmTxCollector();
		this.rebalanceCollector = new RebalanceTxCollector(this.blockRange);
		this.cexCollector = new CexTxCollector();
	}

	private async notifyDailyRunStart(date: string): Promise<void> {
		try {
			await this.telegram.sendDailyRunStart(date);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`telegram daily-run-start signal failed: ${message}`);
		}
	}

	private async notifyDailyRunFinish(date: string, durationMs: number): Promise<void> {
		try {
			await this.telegram.sendDailyRunFinish(date, durationMs);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`telegram daily-run-finish signal failed: ${message}`);
		}
	}

	private async notifyReportingStart(): Promise<void> {
		try {
			await this.telegram.sendReportingStart();
		} catch (error) {
			const message = errorMessage(error);
			log.error(`telegram reporting-start signal failed: ${message}`);
		}
	}

	// Remint must never block the snapshot — log loudly on failure and continue.
	private async runRemintSafely(date: string): Promise<void> {
		try {
			await this.remint.remint(date);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`REMINT FAILED — manual review required: ${message}`);
		}
	}

	// Profit + native-spend phases — safely wrapped so failure here doesn't block the
	// balance snapshot at the end. Balance snapshot stays unwrapped: if it fails, the
	// scheduler-level retry kicks in.
	private async runReportingSafely(date: string, window: NativeSpendWindow, runStart: number): Promise<void> {
		try {
			await this.runReportingPhases(date, window, runStart);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`DAILY-REPORT (profit/native) FAILED — manual review required: ${message}`);
		}
	}

	private async runReportingPhases(date: string, window: NativeSpendWindow, runStart: number): Promise<void> {
		const enabledTokens = (Object.keys(tradingTokens) as TokenSymbol[]).filter((token) => tradingTokens[token]);

		const profitSnapshot = this.loadOrInitProfitSnapshot(date, window);
		const nativeSnapshot = this.loadOrInitNativeSnapshot(date, window);

		// Telegram heads-up — the user otherwise sees only the run-start signal
		// followed by silence until the first per-token card lands minutes later.
		await this.notifyReportingStart();

		// Block ranges are resolved sequentially (per-chain binary search burst is
		// already heavy on a single provider; doing N chains in parallel is worse).
		const evmNetworks = this.listEvmNetworksWithVaults();
		log.important(`daily-report: prelude — resolving block ranges for ${evmNetworks.length} EVM network(s)`);
		const blockRanges = await this.resolveAllBlockRanges(evmNetworks, window);
		log.success(`daily-report: block ranges resolved for ${blockRanges.size}/${evmNetworks.length} chain(s)`);

		const wallets = loadMonitoredEvmWallets();

		// Rebalance-side fetches run in parallel: SVM (Solana RPC), EVM rebalance
		// events (EVM RPC), rebalancer-failed-tx (Etherscan/Blockscout/etc).
		// Different APIs → no shared rate-limit contention.
		log.important(`daily-report: prelude — collecting rebalance data (SVM + EVM events + failed-tx in parallel)`);
		const [svmAll, rebalanceData, rebalancerFailedTx] = await Promise.all([
			this.svmCollector.collect(window),
			this.rebalanceCollector.collect(window),
			this.collectFailedTxAcrossNetworks(blockRanges, wallets.rebalancer, "rebalancer")
		]);
		log.success(`daily-report: rebalance data collected`);

		await this.runRebalancePhase(nativeSnapshot, window, svmAll, rebalanceData, rebalancerFailedTx);

		// Arb-wallet failed-tx is sequential AFTER the rebalancer walk — both hit the
		// same Etherscan-family APIs, so doing them simultaneously would double the
		// load on one shared key.
		log.important(`daily-report: prelude — failed-tx fetch for arb wallet`);
		const arbFailedTx = await this.collectFailedTxAcrossNetworks(blockRanges, wallets.arb, "arb");

		await this.runArbWalletUnattributedPhase(nativeSnapshot, window, arbFailedTx);

		log.info(`daily-report: ${enabledTokens.length} trading token(s): ${enabledTokens.join(", ")}`);
		const tokenCards: TokenDayCard[] = [];
		for (let index = 0; index < enabledTokens.length; index++) {
			const token = enabledTokens[index];
			const card = await this.runTokenLane(
				token,
				index + 1,
				enabledTokens.length,
				profitSnapshot,
				nativeSnapshot,
				window,
				svmAll,
				arbFailedTx
			);
			tokenCards.push(card);
		}

		await this.finalizeUnattributedPricing(nativeSnapshot, window);
		this.finalizeNativeSpendGrandTotals(nativeSnapshot, runStart);
		this.finalizeProfitGrandTotals(profitSnapshot);

		const rebalanceStableRecords = nativeSnapshot.rebalanceSpend
			? nativeSnapshot.rebalanceSpend.records.filter((record) => isStableSymbol(record.token))
			: [];

		const dailyTotals: DailyTotals = {
			date,
			window,
			tokenCards,
			rebalanceStableRecords,
			profitSnapshot,
			nativeSpendSnapshot: nativeSnapshot,
			totalDurationMs: Date.now() - runStart
		};
		await this.telegram.sendHtml(renderDailyTotal(dailyTotals));

		await this.telegram.sendJsonAttachment(profitSnapshotPath(date), `profit-${date}.json`);
		await this.telegram.sendJsonAttachment(nativeSpendSnapshotPath(date), `native-spend-${date}.json`);
	}

	private async persistAndSendBalanceSnapshot(snapshot: Snapshot): Promise<void> {
		const previousTotals = readPreviousTotals(snapshot.date);
		const filePath = writeBalanceSnapshot(snapshot);
		log.success(`balance snapshot: saved → ${filePath}`);
		try {
			await this.telegram.sendSnapshot(snapshot, previousTotals);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`telegram balance snapshot send failed: ${message}`);
		}
	}

	private async runRebalancePhase(
		snapshot: NativeSpendSnapshot,
		window: NativeSpendWindow,
		svm: SvmTxCollected,
		rebalanceData: RebalanceCollected,
		rebalancerFailedTx: Map<Network, FailedTxCollectedNetwork>
	): Promise<void> {
		if (snapshot.rebalanceSpend !== null) {
			log.info(`daily-report: rebalance pass already in snapshot, skipping`);
			return;
		}
		log.important(`daily-report: rebalance pass — calculating`);
		const rebalanceStart = Date.now();
		const result = await this.nativeSpend.scanRebalance({
			window,
			rebalanceData,
			svm,
			rebalancerFailedTxByNetwork: rebalancerFailedTx
		});
		snapshot.rebalanceSpend = result.entry;
		this.appendUnattributed(snapshot, result.unattributedRecords);
		writeNativeSpendSnapshot(snapshot);
		log.success(`daily-report: rebalance pass done in ${this.elapsed(rebalanceStart)}s`);
	}

	private async runArbWalletUnattributedPhase(
		snapshot: NativeSpendSnapshot,
		window: NativeSpendWindow,
		arbFailedTx: Map<Network, FailedTxCollectedNetwork>
	): Promise<void> {
		// Always re-runs on resume: appendUnattributed dedups by txHash. Cheap
		// because the failed-tx fetch is already complete by this point.
		log.important(`daily-report: arb-wallet unattributed pass starting`);
		const entry = await this.nativeSpend.computeArbWalletUnattributed({
			window,
			arbFailedTxByNetwork: arbFailedTx
		});
		this.appendUnattributed(snapshot, entry.records);
		if (snapshot.unattributedSpend !== null) {
			snapshot.unattributedSpend.scanFailures.push(...entry.scanFailures);
		} else if (entry.scanFailures.length > 0) {
			// Failures only — no records — still surface them.
			snapshot.unattributedSpend = {
				fetchedAt: entry.fetchedAt,
				durationMs: entry.durationMs,
				records: [],
				scanFailures: entry.scanFailures
			};
		}
		writeNativeSpendSnapshot(snapshot);
	}

	private async runTokenLane(
		token: TokenSymbol,
		position: number,
		total: number,
		profitSnapshot: ProfitSnapshot,
		nativeSnapshot: NativeSpendSnapshot,
		window: NativeSpendWindow,
		svm: SvmTxCollected,
		arbFailedTx: Map<Network, FailedTxCollectedNetwork>
	): Promise<TokenDayCard> {
		const progress = `(${position}/${total})`;
		const laneStart = Date.now();
		log.important(`daily-report: ${token} ${progress} starting`);
		await this.telegram.sendHtml(`<b>Profit calculating #${position} ${token}</b>`);

		const needProfit = !profitSnapshot.perToken[token];
		const needArb = !nativeSnapshot.arbSpend.perToken[token];

		let profitEntry = profitSnapshot.perToken[token];
		let arbEntry: TokenArbSpendEntry | undefined = nativeSnapshot.arbSpend.perToken[token];

		if (needProfit || needArb) {
			const evmData: EvmArbCollected = await this.evmArbCollector.collectByToken(token, window);

			if (needProfit) {
				const cexData = await this.cexCollector.collectByToken(token, window);
				profitEntry = this.profit.calculateForToken({ token, window, evmData, svm, cexData });
				profitSnapshot.perToken[token] = profitEntry;
				writeProfitSnapshot(profitSnapshot);
			} else {
				log.info(`daily-report: ${token} profit already in snapshot, reusing`);
			}

			if (needArb) {
				arbEntry = await this.nativeSpend.calculateArbForToken({
					token,
					window,
					evmData,
					svm,
					arbFailedTxByNetwork: arbFailedTx
				});
				nativeSnapshot.arbSpend.perToken[token] = arbEntry;
				writeNativeSpendSnapshot(nativeSnapshot);
			} else {
				log.info(`daily-report: ${token} arb spend already in snapshot, reusing`);
			}
		} else {
			log.info(`daily-report: ${token} both profit + arb spend already in snapshot, reusing`);
		}

		const rebalanceRecords = nativeSnapshot.rebalanceSpend
			? nativeSnapshot.rebalanceSpend.records.filter((record) => record.token === token)
			: [];

		const card = buildTokenDayCard({
			token,
			window,
			profit: profitEntry!,
			arbSpend: arbEntry!,
			rebalanceRecords,
			durationMs: Date.now() - laneStart
		});
		await this.telegram.sendHtml(renderTokenCard(card));
		log.success(`daily-report: ${token} ${progress} done in ${this.elapsed(laneStart)}s`);
		return card;
	}

	private listEvmNetworksWithVaults(): Network[] {
		return Object.keys(vaultExecutorAddresses).filter((name) => {
			const network = name as Network;
			if (!enabledNetworks[network]) return false;
			if (chainTypeByNetwork[network] !== ChainType.EVM) return false;
			const vaults = vaultExecutorAddresses[network];
			return Boolean(vaults && Object.keys(vaults).length > 0);
		}) as Network[];
	}

	private async resolveAllBlockRanges(
		networks: Network[],
		window: NativeSpendWindow
	): Promise<Map<Network, BlockRange>> {
		const out = new Map<Network, BlockRange>();
		for (const network of networks) {
			try {
				const range = await this.blockRange.resolve(network, window);
				if (range) out.set(network, range);
			} catch (error) {
				const message = errorMessage(error);
				log.error(`daily-report: block-range resolution failed for ${network}: ${message}`);
			}
		}
		return out;
	}

	private async collectFailedTxAcrossNetworks(
		blockRanges: Map<Network, BlockRange>,
		wallet: string,
		label: string
	): Promise<Map<Network, FailedTxCollectedNetwork>> {
		const out = new Map<Network, FailedTxCollectedNetwork>();
		const total = blockRanges.size;
		let index = 0;
		for (const [network, range] of blockRanges) {
			index++;
			log.info(`daily-report: failed-tx [${label}] (${index}/${total}) ${network}`);
			const entry = await this.collectFailedTxForNetwork(network, wallet, range);
			out.set(network, entry);
			if (entry.failure) {
				log.warning(`daily-report: failed-tx [${label}] ${network}: ${entry.failure.detail}`);
			} else {
				log.success(`daily-report: failed-tx [${label}] ${network}: ${entry.txs.length} tx(s)`);
			}
		}
		return out;
	}

	private async collectFailedTxForNetwork(
		network: Network,
		wallet: string,
		range: BlockRange
	): Promise<FailedTxCollectedNetwork> {
		try {
			const txs = await this.failedTx.getWalletTxs(network, wallet, range.fromBlock, range.toBlock);
			return { network, txs, failure: null };
		} catch (error) {
			let detail: string;
			if (error instanceof UnsupportedFailedTxChainError) {
				detail = `failed-tx scanning unsupported on ${network}`;
			} else {
				const message = errorMessage(error);
				detail = `failed-tx scan threw: ${message}`;
			}
			const failure: ScanFailure = { network, detail };
			return { network, txs: [], failure };
		}
	}

	private async finalizeUnattributedPricing(snapshot: NativeSpendSnapshot, window: NativeSpendWindow): Promise<void> {
		const entry = snapshot.unattributedSpend;
		if (!entry) return;
		const failures = await this.nativeSpend.priceUnattributedRecords(window, entry.records);
		if (failures.length > 0) entry.scanFailures.push(...failures);
		entry.records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
		writeNativeSpendSnapshot(snapshot);
	}

	private finalizeNativeSpendGrandTotals(snapshot: NativeSpendSnapshot, runStart: number): void {
		if (snapshot.grandTotals !== null) return;
		const perTokenEntries = Object.values(snapshot.arbSpend.perToken).filter(
			(entry): entry is TokenArbSpendEntry => entry !== undefined
		);
		snapshot.grandTotals = this.nativeSpend.stats.calculate({
			perTokenEntries,
			rebalanceEntry: snapshot.rebalanceSpend,
			unattributedEntry: snapshot.unattributedSpend,
			startedAtMs: runStart
		});
		writeNativeSpendSnapshot(snapshot);
	}

	private finalizeProfitGrandTotals(snapshot: ProfitSnapshot): void {
		if (snapshot.grandTotals !== null) return;
		snapshot.grandTotals = this.profit.computeGrandTotals(snapshot);
		writeProfitSnapshot(snapshot);
	}

	private loadOrInitProfitSnapshot(date: string, window: NativeSpendWindow): ProfitSnapshot {
		const existing = readProfitSnapshot(date);
		if (existing) {
			const doneTokens = Object.keys(existing.perToken).length;
			if (doneTokens > 0) {
				log.info(`daily-report: resuming partial profit snapshot (${doneTokens} token(s) already done)`);
			}
			return existing;
		}
		return {
			date,
			generatedAt: new Date().toISOString(),
			window,
			perToken: {},
			grandTotals: null
		};
	}

	private loadOrInitNativeSnapshot(date: string, window: NativeSpendWindow): NativeSpendSnapshot {
		const existing = readNativeSpendSnapshot(date);
		if (existing) {
			const doneTokens = Object.keys(existing.arbSpend.perToken).length;
			const rebalanceDone = existing.rebalanceSpend !== null;
			log.info(
				`daily-report: resuming partial native-spend snapshot (${doneTokens} token(s) done, rebalance=${rebalanceDone ? "done" : "pending"})`
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

	// Dedup by txHash: arb-wallet-unattributed + rebalance-unattributed both flow
	// into the same slot and may overlap on resume.
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
		const seen = new Set(snapshot.unattributedSpend.records.map((record) => record.txHash));
		for (const record of incoming) {
			if (seen.has(record.txHash)) continue;
			seen.add(record.txHash);
			snapshot.unattributedSpend.records.push(record);
		}
	}

	// Window anchored to today's UTC midnight: [today 00:00 UTC − windowLengthSeconds, today 00:00 UTC].
	// Cron fires at 00:00 UTC → window covers the previous full day. Anchoring to
	// `date` (not `Date.now()`) keeps retries / day-rollover re-runs idempotent
	// even when wall-clock has drifted minutes past midnight.
	private buildWindow(date: string): NativeSpendWindow {
		const toTimestampSeconds = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
		const fromTimestampSeconds = toTimestampSeconds - dailyReportConfig.windowLengthSeconds;
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

function todayUtcDate(): string {
	return new Date().toISOString().slice(0, 10);
}

export { DailyReportService };
