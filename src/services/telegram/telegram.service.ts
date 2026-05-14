import * as fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { getStableForToken, isStableSymbol, tokenAliases } from "../../config";
import {
	FailedTotals,
	IntentNetworkSpend,
	IntentTotals,
	NativeSpendSnapshot,
	NativeSpendWindow,
	Network,
	ProfitSnapshot,
	ProfitWindow,
	RebalanceSpendEntry,
	RemintReport,
	RemintWindow,
	RouteStats,
	Snapshot,
	SpendIntent,
	SpendRecord,
	SpendStatus,
	TokenArbSpendEntry,
	TokenBalance,
	TokenProfitEntry,
	TokenProfitStatistics,
	TokenSymbol,
	UnmatchedStats
} from "../../types";
import { evmChainMetadata, svmChainMetadata } from "../../config";
import {
	COMMON_DECIMALS,
	PreviousTotals,
	collectNativeSymbols,
	collectNativeSources,
	collectStableSources,
	convertDecimals,
	findTokenSource,
	formatAmount,
	formatTimestamp,
	hasAnyVault,
	isHiddenZero,
	log,
	nativeSpendSnapshotPath,
	orderedChains,
	profitSnapshotPath
} from "../../utils";

const TELEGRAM_MESSAGE_LIMIT = 4000;
const BLOCKQUOTE_OPEN = "<blockquote expandable>";
const BLOCKQUOTE_CLOSE = "</blockquote>";

class TelegramService {
	private readonly bot: TelegramBot;
	private readonly chatId: string;

	constructor() {
		const token = process.env.TG_BOT_TOKEN;
		const chatId = process.env.TG_CHAT_ID;
		if (!token) throw new Error("[telegram] Missing env var: TG_BOT_TOKEN");
		if (!chatId) throw new Error("[telegram] Missing env var: TG_CHAT_ID");
		this.bot = new TelegramBot(token, { polling: false });
		this.chatId = chatId;
	}

	public async sendSnapshot(snapshot: Snapshot, previousTotals: PreviousTotals | null): Promise<void> {
		const messages = this.buildMessages(snapshot, previousTotals);
		for (const message of messages) {
			await this.bot.sendMessage(this.chatId, message, { parse_mode: "HTML" });
		}
		log.success(`telegram: sent ${messages.length} message(s)`);
	}

	public async sendDailyRunStart(date: string): Promise<void> {
		const text = `⏰ <b>Daily run started</b> — ${date}`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: daily run start signal sent");
	}

	public async sendDailyRunFinish(date: string, durationMs: number): Promise<void> {
		const text = `🎉 <b>Daily run finished</b> — ${date}\n<i>Duration: ${this.formatDuration(durationMs)}</i>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: daily run finish signal sent");
	}

	public async sendRemintStart(date: string, window: RemintWindow): Promise<void> {
		const windowLine = `${this.formatWindowEdge(window.fromIso)} → ${this.formatWindowEdge(window.toIso)} UTC`;
		const text = `🔄 <b>Remint started</b> — ${date}\n<i>Window: ${windowLine}</i>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: remint start signal sent");
	}

	private formatWindowEdge(iso: string): string {
		// ISO is always `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC); take date + HH:MM.
		return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
	}

	public async sendRemintFinish(report: RemintReport): Promise<void> {
		const text = this.buildRemintFinishMessage(report);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: remint finish report sent");
	}

	public async sendProfitCalcStart(window: ProfitWindow, tokens: TokenSymbol[]): Promise<void> {
		const windowLine = `${this.formatWindowEdge(window.fromIso)} → ${this.formatWindowEdge(window.toIso)} UTC`;
		const tokenLines = tokens.map((token) => `─ ${token}`).join("\n");
		const text =
			`📈 <b>Profit calculation started</b>\n` +
			`<i>Window: ${windowLine}</i>\n\n` +
			`Tokens to process:\n${tokenLines}`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: profit-calc start signal sent");
	}

	public async sendTokenProfitStart(token: TokenSymbol, index: number): Promise<void> {
		const text = `<b>Profit calculating #${index} ${token}</b>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success(`telegram: profit start signal sent for ${token}`);
	}

	public async sendTokenProfitReport(entry: TokenProfitEntry): Promise<void> {
		const text = this.buildTokenProfitMessage(entry);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success(`telegram: profit report sent for ${entry.token}`);
	}

	public async sendProfitGrandTotals(snapshot: ProfitSnapshot): Promise<void> {
		const text = this.buildProfitGrandTotalsMessage(snapshot);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: profit grand totals sent");
	}

	public async sendProfitSnapshotFile(date: string): Promise<void> {
		const filePath = profitSnapshotPath(date);
		const caption =
			`📎 <b>profit-${date}.json</b>\n` +
			"Full snapshot with per-token matched pairs, stats, routes, and raw transaction list.";
		await this.bot.sendDocument(
			this.chatId,
			fs.createReadStream(filePath),
			{ caption, parse_mode: "HTML" },
			{ filename: `profit-${date}.json`, contentType: "application/json" }
		);
		log.success(`telegram: profit snapshot file sent for ${date}`);
	}

	public async sendNativeSpendStart(window: NativeSpendWindow, arbTokens: TokenSymbol[]): Promise<void> {
		const windowLine = `${this.formatWindowEdge(window.fromIso)} → ${this.formatWindowEdge(window.toIso)} UTC`;
		const arbList = arbTokens.map((token) => `  ─ ${token}`).join("\n");
		const text =
			`💸 <b>Native spend calculation started</b>\n` +
			`<i>Window: ${windowLine}</i>\n\n` +
			`📊 <b>Arbitrage — ${arbTokens.length} token(s):</b>\n${arbList}\n\n` +
			`🔄 <b>Rebalance — scanning all vaults</b>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: native-spend start signal sent");
	}

	public async sendNativeSpendTokenReport(entry: TokenArbSpendEntry): Promise<void> {
		const text = this.buildNativeSpendTokenMessage(entry);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success(`telegram: native-spend token report sent for ${entry.token}`);
	}

	public async sendNativeSpendRebalanceReport(entry: RebalanceSpendEntry): Promise<void> {
		const text = this.buildNativeSpendRebalanceMessage(entry);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: native-spend rebalance report sent");
	}

	public async sendNativeSpendGrandTotals(snapshot: NativeSpendSnapshot): Promise<void> {
		const text = this.buildNativeSpendGrandTotalsMessage(snapshot);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: native-spend grand totals sent");
	}

	public async sendNativeSpendFile(date: string): Promise<void> {
		const filePath = nativeSpendSnapshotPath(date);
		const caption =
			`📎 <b>native-spend-${date}.json</b>\n` +
			"Full snapshot with per-token arb spend, rebalance spend, and grand totals.";
		await this.bot.sendDocument(
			this.chatId,
			fs.createReadStream(filePath),
			{ caption, parse_mode: "HTML" },
			{ filename: `native-spend-${date}.json`, contentType: "application/json" }
		);
		log.success(`telegram: native-spend snapshot file sent for ${date}`);
	}

	private buildNativeSpendTokenMessage(entry: TokenArbSpendEntry): string {
		const aggregate = this.aggregateRecordsByNetwork(entry.records);
		const sections: string[] = [];
		sections.push(`💸 <b>Arbitrage native spend — ${entry.token}</b>`);
		sections.push(this.formatStatusSplitHeader(aggregate, "Arbitrage"));

		const networkLines = this.formatIntentNetworkLines(aggregate.byNetwork, false, "Arbitrage");
		if (networkLines.length > 0) {
			sections.push(`${BLOCKQUOTE_OPEN}🌐 <b>By network</b>\n\n${networkLines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		if (entry.scanFailures.length > 0) {
			const failureLines = entry.scanFailures.map(
				(failure) => `  ${failure.network} · ${failure.intent}: ${this.escapeHtml(failure.detail)}`
			);
			sections.push(this.buildFailuresBlock(failureLines, "🚨 <b>Scan failures — data is INCOMPLETE</b>"));
		}

		sections.push(`<i>Duration: ${this.formatDuration(entry.durationMs)}</i>`);
		return sections.join("\n\n");
	}

	private buildNativeSpendRebalanceMessage(entry: RebalanceSpendEntry): string {
		const aggregate = this.aggregateRecordsByNetwork(entry.records);
		const sections: string[] = [];
		sections.push(`🔄 <b>Rebalance spend</b>`);
		sections.push(this.formatStatusSplitHeader(aggregate, "Rebalance"));

		const networkLines = this.formatIntentNetworkLines(aggregate.byNetwork, true, "Rebalance");
		if (networkLines.length > 0) {
			sections.push(`${BLOCKQUOTE_OPEN}🌐 <b>By network</b>\n\n${networkLines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const successRecords = entry.records.filter((r) => r.status === SpendStatus.SUCCESS);
		const failedRecords = entry.records.filter((r) => r.status === SpendStatus.REVERTED);

		const bridgeLines = this.formatBridgeLines(successRecords);
		if (bridgeLines.length > 0) {
			sections.push(`${BLOCKQUOTE_OPEN}🌉 <b>By bridge</b>\n\n${bridgeLines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const tokenLines = this.formatRebalanceTokenLines(successRecords);
		if (tokenLines.length > 0) {
			sections.push(`${BLOCKQUOTE_OPEN}💵 <b>By token</b>\n\n${tokenLines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const failedBridgeLines = this.formatBridgeLines(failedRecords);
		if (failedBridgeLines.length > 0) {
			sections.push(
				`${BLOCKQUOTE_OPEN}🚨 <b>Failed by bridge → chain → token</b>\n\n${failedBridgeLines.join("\n")}${BLOCKQUOTE_CLOSE}`
			);
		}

		if (entry.scanFailures.length > 0) {
			const failureLines = entry.scanFailures.map(
				(failure) => `  ${failure.network} · ${failure.intent}: ${this.escapeHtml(failure.detail)}`
			);
			sections.push(this.buildFailuresBlock(failureLines, "🚨 <b>Scan failures — data is INCOMPLETE</b>"));
		}

		sections.push(`<i>Duration: ${this.formatDuration(entry.durationMs)}</i>`);
		return sections.join("\n\n");
	}

	// Top header for per-token + rebalance blocks: total line + success/failed split.
	// successLabel = caller's intent label (e.g. "Arbitrage" / "Rebalance"); "Failed"
	// covers the REVERTED records of that intent.
	private formatStatusSplitHeader(
		aggregate: {
			usdTotal: number;
			hasPricedRecord: boolean;
			totalTxCount: number;
			successUsd: number;
			successTxCount: number;
			failedUsd: number;
			failedTxCount: number;
		},
		successLabel: string
	): string {
		const totalLine = `Total: <b>${aggregate.hasPricedRecord ? this.formatUsd(aggregate.usdTotal) : "—"}</b>  ·  ${aggregate.totalTxCount} tx`;
		const successLine = `─ ${successLabel}: ${this.formatUsd(aggregate.successUsd)}  ·  ${aggregate.successTxCount} tx`;
		const failedLine = `─ Failed: ${this.formatUsd(aggregate.failedUsd)}  ·  ${aggregate.failedTxCount} tx`;
		return `${totalLine}\n${successLine}\n${failedLine}`;
	}

	private buildNativeSpendGrandTotalsMessage(snapshot: NativeSpendSnapshot): string {
		const totals = snapshot.grandTotals;
		if (!totals) return `🏁 <b>Native spend calculation complete</b>\n<i>(grand totals not computed)</i>`;

		const sections: string[] = [];
		sections.push(`🏁 <b>Native spend calculation complete</b>`);
		sections.push(
			`Total: <b>${this.formatUsd(totals.totalUsd)}</b>  ·  ${totals.totalTxCount} tx\n` +
				`─ Arbitrage: ${this.formatUsd(totals.arbitrage.usdTotal)}  ·  ${totals.arbitrage.txCount} tx\n` +
				`─ Rebalance: ${this.formatUsd(totals.rebalance.usdTotal)}  ·  ${totals.rebalance.txCount} tx\n` +
				`─ Failed: ${this.formatUsd(totals.failed.usdTotal)}  ·  ${totals.failed.txCount} tx`
		);

		if (totals.byToken.length > 0) {
			const lines: string[] = [];
			for (let index = 0; index < totals.byToken.length; index++) {
				const tokenTotals = totals.byToken[index];
				lines.push(`  ${tokenTotals.token}: ${this.formatUsd(tokenTotals.usdTotal)}  ·  ${tokenTotals.txCount} tx`);
				for (const intentEntry of tokenTotals.byIntent) {
					const intentLabel = intentEntry.intent === SpendIntent.ARBITRAGE ? "Arbitrage" : "Rebalance";
					lines.push(`    ${intentLabel}: ${this.formatUsd(intentEntry.usdAmount)}  ·  ${intentEntry.txCount} tx`);
				}
				if (tokenTotals.failedTxCount > 0) {
					lines.push(`    Failed: ${this.formatUsd(tokenTotals.failedUsd)}  ·  ${tokenTotals.failedTxCount} tx`);
				}
				if (index < totals.byToken.length - 1) lines.push("");
			}
			sections.push(`${BLOCKQUOTE_OPEN}💵 <b>By token</b>\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		if (totals.byNativeToken.length > 0) {
			const lines: string[] = [];
			for (let index = 0; index < totals.byNativeToken.length; index++) {
				const entry = totals.byNativeToken[index];
				const native = `${formatAmount(BigInt(entry.nativeAmount), entry.nativeDecimals)} ${entry.nativeSymbol}`;
				const usdPart = entry.usdAmount === null ? "" : ` (${this.formatUsd(entry.usdAmount)})`;
				lines.push(`  ${entry.nativeSymbol}: ${native}${usdPart}`);
				if (index < totals.byNativeToken.length - 1) lines.push("");
			}
			sections.push(`${BLOCKQUOTE_OPEN}🪙 <b>By native token</b>\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const arbitrageBlock = this.buildIntentNetworkBlock(
			"🌐 <b>Arbitrage — by network</b>",
			totals.arbitrage,
			false,
			"Arbitrage"
		);
		if (arbitrageBlock) sections.push(arbitrageBlock);
		const rebalanceBlock = this.buildIntentNetworkBlock(
			"🌐 <b>Rebalance — by network</b>",
			totals.rebalance,
			true,
			"Rebalance"
		);
		if (rebalanceBlock) sections.push(rebalanceBlock);

		const failedBreakdownBlock = this.buildFailedBreakdownBlock(totals.failed);
		if (failedBreakdownBlock) sections.push(failedBreakdownBlock);

		const failureLines = this.collectAllNativeSpendFailures(snapshot);
		if (failureLines.length > 0) {
			sections.push(this.buildFailuresBlock(failureLines, "🚨 <b>Scan failures — totals are PARTIAL</b>"));
		}

		sections.push(`<i>Duration: ${this.formatDuration(totals.durationMs)}</i>`);
		return sections.join("\n\n");
	}

	private buildFailedBreakdownBlock(failed: FailedTotals): string | null {
		if (failed.txCount === 0) return null;
		const lines: string[] = [];
		lines.push(`  By type:`);
		lines.push(`    Arbitrage: ${this.formatUsd(failed.byType.arbitrage.usdAmount)}  ·  ${failed.byType.arbitrage.txCount} tx`);
		lines.push(`    Rebalance: ${this.formatUsd(failed.byType.rebalance.usdAmount)}  ·  ${failed.byType.rebalance.txCount} tx`);
		lines.push(`    Unattributed: ${this.formatUsd(failed.byType.unattributed.usdAmount)}  ·  ${failed.byType.unattributed.txCount} tx`);
		if (failed.byNetwork.length > 0) {
			lines.push("");
			lines.push(`  By chain:`);
			for (const entry of failed.byNetwork) {
				lines.push(`    ${entry.network}: ${this.formatUsd(entry.usdAmount)}  ·  ${entry.txCount} tx`);
			}
		}
		return `${BLOCKQUOTE_OPEN}🚨 <b>Failed breakdown</b>\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	// Roll-up shaped like stats-calculator's IntentTotals; reused for per-token + rebalance
	// messages that render BEFORE grand totals. byNetwork[*].usdAmount/txCount/byToken cover
	// SUCCESS records; revertedUsd/revertedTxCount cover REVERTED in that (intent, chain).
	// Totals at the top level break success vs failed so caller can show "Total / Arb / Failed".
	private aggregateRecordsByNetwork(records: SpendRecord[]): {
		usdTotal: number;
		hasPricedRecord: boolean;
		totalTxCount: number;
		successUsd: number;
		successTxCount: number;
		failedUsd: number;
		failedTxCount: number;
		byNetwork: IntentNetworkSpend[];
	} {
		const buckets = new Map<
			Network,
			{
				native: bigint;
				successUsd: number;
				successHasPriced: boolean;
				successTxCount: number;
				tokens: Map<TokenSymbol, { native: bigint; usd: number; hasPriced: boolean; txCount: number }>;
				revertedUsd: number;
				revertedTxCount: number;
			}
		>();
		let successUsd = 0;
		let failedUsd = 0;
		let successTxCount = 0;
		let failedTxCount = 0;
		let anyPriced = false;
		for (const record of records) {
			const bucket = buckets.get(record.network) ?? {
				native: 0n,
				successUsd: 0,
				successHasPriced: false,
				successTxCount: 0,
				tokens: new Map(),
				revertedUsd: 0,
				revertedTxCount: 0
			};
			bucket.native += BigInt(record.nativeAmount);
			if (record.usdAmount !== null) anyPriced = true;
			if (record.status === SpendStatus.SUCCESS) {
				if (record.usdAmount !== null) {
					bucket.successUsd += record.usdAmount;
					bucket.successHasPriced = true;
					successUsd += record.usdAmount;
				}
				bucket.successTxCount++;
				successTxCount++;
				const tokenBucket = bucket.tokens.get(record.token) ?? { native: 0n, usd: 0, hasPriced: false, txCount: 0 };
				tokenBucket.native += BigInt(record.nativeAmount);
				if (record.usdAmount !== null) {
					tokenBucket.usd += record.usdAmount;
					tokenBucket.hasPriced = true;
				}
				tokenBucket.txCount++;
				bucket.tokens.set(record.token, tokenBucket);
			} else {
				bucket.revertedUsd += record.usdAmount ?? 0;
				bucket.revertedTxCount++;
				failedUsd += record.usdAmount ?? 0;
				failedTxCount++;
			}
			buckets.set(record.network, bucket);
		}
		const byNetwork: IntentNetworkSpend[] = [];
		for (const [network, bucket] of buckets) {
			const meta = this.resolveNativeMeta(network);
			const tokens = [...bucket.tokens.entries()].map(([token, t]) => ({
				token,
				nativeAmount: t.native.toString(),
				usdAmount: t.hasPriced ? Math.round(t.usd * 100) / 100 : null,
				txCount: t.txCount
			}));
			tokens.sort((a, b) => this.compareUsd(a.usdAmount, b.usdAmount, a.token, b.token));
			byNetwork.push({
				network,
				nativeAmount: bucket.native.toString(),
				nativeSymbol: meta.symbol,
				nativeDecimals: meta.decimals,
				usdAmount: bucket.successHasPriced ? Math.round(bucket.successUsd * 100) / 100 : null,
				txCount: bucket.successTxCount,
				byToken: tokens,
				revertedUsd: Math.round(bucket.revertedUsd * 100) / 100,
				revertedTxCount: bucket.revertedTxCount
			});
		}
		byNetwork.sort((a, b) => {
			const aTotal = (a.usdAmount ?? 0) + a.revertedUsd;
			const bTotal = (b.usdAmount ?? 0) + b.revertedUsd;
			return bTotal - aTotal || a.network.localeCompare(b.network);
		});
		return {
			usdTotal: Math.round((successUsd + failedUsd) * 100) / 100,
			hasPricedRecord: anyPriced,
			totalTxCount: successTxCount + failedTxCount,
			successUsd: Math.round(successUsd * 100) / 100,
			successTxCount,
			failedUsd: Math.round(failedUsd * 100) / 100,
			failedTxCount,
			byNetwork
		};
	}

	private resolveNativeMeta(network: Network): { symbol: TokenSymbol; decimals: number } {
		const evm = evmChainMetadata[network];
		if (evm) return { symbol: evm.nativeSymbol, decimals: evm.nativeDecimals };
		const svm = svmChainMetadata[network];
		if (svm) return { symbol: svm.nativeSymbol, decimals: svm.nativeDecimals };
		throw new Error(`[telegram native-spend] no chain metadata for network ${network}`);
	}

	private compareUsd(a: number | null, b: number | null, aKey: string, bKey: string): number {
		if (a === null && b === null) return aKey.localeCompare(bKey);
		if (a === null) return 1;
		if (b === null) return -1;
		return b - a;
	}

	private buildIntentNetworkBlock(
		title: string,
		intent: IntentTotals,
		showSubTokens: boolean,
		successLabel: string
	): string | null {
		if (intent.byNetwork.length === 0) return null;
		const lines = this.formatIntentNetworkLines(intent.byNetwork, showSubTokens, successLabel);
		return `${BLOCKQUOTE_OPEN}${title}\n\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	// Native amount first (with ticker) so the line is readable even when USD is missing.
	// Chain row shows total (success + reverted). Nested success/Failed split only when
	// reverted > 0 (otherwise single line is enough). Token sub-lines apply to success only.
	private formatIntentNetworkLines(
		networks: IntentNetworkSpend[],
		showSubTokens: boolean,
		successLabel: string
	): string[] {
		const lines: string[] = [];
		for (let index = 0; index < networks.length; index++) {
			const entry = networks[index];
			const native = `${formatAmount(BigInt(entry.nativeAmount), entry.nativeDecimals)} ${entry.nativeSymbol}`;
			const totalUsd = (entry.usdAmount ?? 0) + entry.revertedUsd;
			const hasPriced = entry.usdAmount !== null || entry.revertedUsd > 0;
			const totalTxCount = entry.txCount + entry.revertedTxCount;
			const usdPart = hasPriced ? ` (${this.formatUsd(totalUsd)})` : "";
			lines.push(`  ${entry.network}: ${native}${usdPart}  ·  ${totalTxCount} tx`);
			if (entry.revertedTxCount > 0) {
				const successUsd = entry.usdAmount ?? 0;
				lines.push(`    ${successLabel}: ${this.formatUsd(successUsd)}  ·  ${entry.txCount} tx`);
				lines.push(`    Failed: ${this.formatUsd(entry.revertedUsd)}  ·  ${entry.revertedTxCount} tx`);
			}
			if (showSubTokens) {
				for (const tokenEntry of entry.byToken) {
					const tokenNative = `${formatAmount(BigInt(tokenEntry.nativeAmount), entry.nativeDecimals)} ${entry.nativeSymbol}`;
					const tokenUsd = tokenEntry.usdAmount === null ? "" : ` (${this.formatUsd(tokenEntry.usdAmount)})`;
					lines.push(`    ${tokenEntry.token}: ${tokenNative}${tokenUsd}  ·  ${tokenEntry.txCount} tx`);
				}
			}
			if (index < networks.length - 1) lines.push("");
		}
		return lines;
	}

	// Group rebalance records bridge → network → token. Three-level nesting keeps the
	// readout legible even when a single network has multiple tokens under one bridge
	// (flat "BSC · RIVER" labels would collapse into a mess once more tokens appear).
	private formatBridgeLines(records: SpendRecord[]): string[] {
		interface TokenCombo {
			token: TokenSymbol;
			native: bigint;
			usd: number;
			hasPriced: boolean;
			count: number;
		}
		interface NetworkGroup {
			network: Network;
			usd: number;
			count: number;
			hasPriced: boolean;
			tokens: Map<TokenSymbol, TokenCombo>;
		}
		interface BridgeBucket {
			usd: number;
			count: number;
			hasPriced: boolean;
			networks: Map<Network, NetworkGroup>;
		}

		const bridgeBuckets = new Map<string, BridgeBucket>();
		for (const record of records) {
			if (!record.bridge) continue;
			let bucket = bridgeBuckets.get(record.bridge);
			if (!bucket) {
				bucket = { usd: 0, count: 0, hasPriced: false, networks: new Map() };
				bridgeBuckets.set(record.bridge, bucket);
			}
			if (record.usdAmount !== null) {
				bucket.usd += record.usdAmount;
				bucket.hasPriced = true;
			}
			bucket.count++;

			let networkGroup = bucket.networks.get(record.network);
			if (!networkGroup) {
				networkGroup = { network: record.network, usd: 0, count: 0, hasPriced: false, tokens: new Map() };
				bucket.networks.set(record.network, networkGroup);
			}
			if (record.usdAmount !== null) {
				networkGroup.usd += record.usdAmount;
				networkGroup.hasPriced = true;
			}
			networkGroup.count++;

			let combo = networkGroup.tokens.get(record.token);
			if (!combo) {
				combo = { token: record.token, native: 0n, usd: 0, hasPriced: false, count: 0 };
				networkGroup.tokens.set(record.token, combo);
			}
			combo.native += BigInt(record.nativeAmount);
			if (record.usdAmount !== null) {
				combo.usd += record.usdAmount;
				combo.hasPriced = true;
			}
			combo.count++;
		}

		const sortedBridges = [...bridgeBuckets.entries()].sort((a, b) => b[1].usd - a[1].usd);
		const lines: string[] = [];
		for (let bridgeIndex = 0; bridgeIndex < sortedBridges.length; bridgeIndex++) {
			const [bridge, bucket] = sortedBridges[bridgeIndex];
			const usd = bucket.hasPriced ? this.formatUsd(bucket.usd) : "—";
			lines.push(`  ${bridge}: ${usd}  ·  ${bucket.count} tx`);
			const sortedNetworks = [...bucket.networks.values()].sort(
				(a, b) => (b.hasPriced ? b.usd : -1) - (a.hasPriced ? a.usd : -1)
			);
			for (const networkGroup of sortedNetworks) {
				lines.push(`    ${networkGroup.network}`);
				const meta = this.resolveNativeMeta(networkGroup.network);
				const sortedCombos = [...networkGroup.tokens.values()].sort(
					(a, b) => (b.hasPriced ? b.usd : -1) - (a.hasPriced ? a.usd : -1)
				);
				for (const combo of sortedCombos) {
					const native = `${formatAmount(combo.native, meta.decimals)} ${meta.symbol}`;
					const usdPart = combo.hasPriced ? ` (${this.formatUsd(combo.usd)})` : "";
					lines.push(`      ${combo.token}: ${native}${usdPart}  ·  ${combo.count} tx`);
				}
			}
			if (bridgeIndex < sortedBridges.length - 1) lines.push("");
		}
		return lines;
	}

	// Group rebalance records by token, then by network — answers "for ANON, how much
	// native did each chain burn?". Per-network sub-lines use that chain's native ticker.
	private formatRebalanceTokenLines(records: SpendRecord[]): string[] {
		const buckets = new Map<
			TokenSymbol,
			{
				usd: number;
				count: number;
				anyPriced: boolean;
				networks: Map<Network, { native: bigint; usd: number; hasPriced: boolean; count: number }>;
			}
		>();
		for (const record of records) {
			const bucket = buckets.get(record.token) ?? { usd: 0, count: 0, anyPriced: false, networks: new Map() };
			if (record.usdAmount !== null) {
				bucket.usd += record.usdAmount;
				bucket.anyPriced = true;
			}
			bucket.count++;
			const networkBucket = bucket.networks.get(record.network) ?? { native: 0n, usd: 0, hasPriced: false, count: 0 };
			networkBucket.native += BigInt(record.nativeAmount);
			if (record.usdAmount !== null) {
				networkBucket.usd += record.usdAmount;
				networkBucket.hasPriced = true;
			}
			networkBucket.count++;
			bucket.networks.set(record.network, networkBucket);
			buckets.set(record.token, bucket);
		}

		const sortedTokens = [...buckets.entries()].sort((a, b) => b[1].usd - a[1].usd);
		const lines: string[] = [];
		for (let tokenIndex = 0; tokenIndex < sortedTokens.length; tokenIndex++) {
			const [token, bucket] = sortedTokens[tokenIndex];
			const usd = bucket.anyPriced ? this.formatUsd(bucket.usd) : "—";
			lines.push(`  ${token}: ${usd}  ·  ${bucket.count} tx`);
			const sortedNetworks = [...bucket.networks.entries()].sort(
				(a, b) => (b[1].hasPriced ? b[1].usd : -1) - (a[1].hasPriced ? a[1].usd : -1)
			);
			for (const [network, networkBucket] of sortedNetworks) {
				const meta = this.resolveNativeMeta(network);
				const native = `${formatAmount(networkBucket.native, meta.decimals)} ${meta.symbol}`;
				const usdPart = networkBucket.hasPriced ? ` (${this.formatUsd(networkBucket.usd)})` : "";
				lines.push(`    ${network}: ${native}${usdPart}  ·  ${networkBucket.count} tx`);
			}
			if (tokenIndex < sortedTokens.length - 1) lines.push("");
		}
		return lines;
	}

	private collectAllNativeSpendFailures(snapshot: NativeSpendSnapshot): string[] {
		const lines: string[] = [];
		for (const entry of Object.values(snapshot.arbSpend.perToken)) {
			if (!entry) continue;
			for (const failure of entry.scanFailures) {
				lines.push(`  ${entry.token} · ${failure.network} · ${failure.intent}: ${this.escapeHtml(failure.detail)}`);
			}
		}
		if (snapshot.rebalanceSpend) {
			for (const failure of snapshot.rebalanceSpend.scanFailures) {
				lines.push(`  rebalance · ${failure.network} · ${failure.intent}: ${this.escapeHtml(failure.detail)}`);
			}
		}
		if (snapshot.unattributedSpend) {
			for (const failure of snapshot.unattributedSpend.scanFailures) {
				lines.push(`  unattributed · ${failure.network} · ${failure.intent}: ${this.escapeHtml(failure.detail)}`);
			}
		}
		return lines;
	}

	private buildTokenProfitMessage(entry: TokenProfitEntry): string {
		const stats = entry.stats;
		const sections: string[] = [];
		sections.push(`💰 <b>Profit — ${entry.token}</b>`);
		sections.push(`Profit: <b>${this.formatUsd(stats.profit.total)}</b>`);
		sections.push(this.buildPerTokenStatsBlock(stats));
		if (stats.byRoute.length > 0) {
			sections.push(this.buildRoutesBlock(stats.byRoute, "🔀 <b>Routes</b>"));
		}
		const imbalanceBlock = this.buildPositionImbalanceBlock(stats.unmatchedStats);
		if (imbalanceBlock) sections.push(imbalanceBlock);
		if (entry.scanFailures.length > 0) {
			const failureLines = entry.scanFailures.map(
				(failure) => `  ${failure.network}: ${this.escapeHtml(failure.detail)}`
			);
			sections.push(this.buildFailuresBlock(failureLines, "🚨 <b>Scan failures — data is INCOMPLETE</b>"));
		}
		sections.push(`<i>Duration: ${this.formatDuration(entry.durationMs)}</i>`);
		return sections.join("\n\n");
	}

	private buildPerTokenStatsBlock(stats: TokenProfitStatistics): string {
		const lines: string[] = [];
		lines.push(`  Trades: ${stats.totals.transactions}`);
		lines.push(`  Matched: ${stats.totals.matchedPairs}`);
		lines.push(`  Unmatched: ${stats.totals.unmatched}`);
		lines.push(`  Match rate: ${stats.totals.matchRate}`);
		lines.push("  ─────────");
		lines.push(`  Avg: ${this.formatUsd(stats.profit.avg)}`);
		lines.push(`  Median: ${this.formatUsd(stats.profit.median)}`);
		lines.push(`  Min: ${this.formatUsd(stats.profit.min)}`);
		lines.push(`  Max: ${this.formatUsd(stats.profit.max)}`);
		if (stats.bestArbitrage || stats.worstArbitrage) {
			lines.push("  ─────────");
			if (stats.bestArbitrage) {
				lines.push(
					`  Best: ${this.formatUsd(stats.bestArbitrage.profit)} · ${this.escapeHtml(stats.bestArbitrage.route)}`
				);
			}
			if (stats.worstArbitrage) {
				lines.push(
					`  Worst: ${this.formatUsd(stats.worstArbitrage.profit)} · ${this.escapeHtml(stats.worstArbitrage.route)}`
				);
			}
		}
		return `${BLOCKQUOTE_OPEN}🧾 <b>Stats</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	private buildRoutesBlock(routes: RouteStats[], title: string): string {
		const lines = routes.map(
			(route) => `  ${this.escapeHtml(route.route)}: ${route.count}× · ${this.formatUsd(route.totalProfit)}`
		);
		return `${BLOCKQUOTE_OPEN}${title}\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	private buildPositionImbalanceBlock(unmatched: UnmatchedStats): string | null {
		if (unmatched.closing.action === "NONE" || !unmatched.targetToken) return null;
		const net = unmatched.netTarget;
		const netSign = net > 0 ? "+" : "";
		const lines: string[] = [];
		lines.push(`  Bought: ${this.formatTokenAmount(unmatched.targetBought)}`);
		lines.push(`  Sold: ${this.formatTokenAmount(unmatched.targetSold)}`);
		lines.push(`  Net: ${netSign}${this.formatTokenAmount(net)}`);
		lines.push(`  Avg price: ${this.formatUsd(unmatched.closing.breakEvenPrice)}`);
		return `${BLOCKQUOTE_OPEN}⚖️ <b>Position imbalance</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	private buildTotalsImbalanceBlock(snapshot: ProfitSnapshot): string | null {
		const lines: string[] = [];
		for (const entry of Object.values(snapshot.perToken)) {
			if (!entry) continue;
			const unmatched = entry.stats.unmatchedStats;
			if (unmatched.closing.action === "NONE" || !unmatched.targetToken) continue;
			const netSign = unmatched.netTarget > 0 ? "+" : "";
			lines.push(
				`  ${entry.token}: ${netSign}${this.formatTokenAmount(unmatched.netTarget)}  (avg ${this.formatUsd(unmatched.closing.breakEvenPrice)})`
			);
		}
		if (lines.length === 0) return null;
		return `${BLOCKQUOTE_OPEN}⚖️ <b>Position imbalance</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	private buildFailuresBlock(failureLines: string[], title: string): string {
		return `${BLOCKQUOTE_OPEN}${title}\n${failureLines.join("\n")}${BLOCKQUOTE_CLOSE}`;
	}

	private buildProfitGrandTotalsMessage(snapshot: ProfitSnapshot): string {
		const totals = snapshot.grandTotals;
		if (!totals) return `🏆 <b>Profit calculation complete</b>\n<i>(grand totals not computed)</i>`;

		const totalProfitUsd = totals.byToken.reduce((sum, t) => sum + t.total, 0);

		const sections: string[] = [];
		sections.push(`🏆 <b>Profit calculation complete</b>`);
		sections.push(`Total profit: <b>${this.formatUsd(totalProfitUsd)}</b>`);

		if (totals.byToken.length > 0) {
			const lines = totals.byToken.map(
				(t) => `  ${t.token}: ${this.formatUsd(t.total)}  (${t.matchedPairs} matched)`
			);
			sections.push(`${BLOCKQUOTE_OPEN}💵 <b>Profit by token</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const imbalanceBlock = this.buildTotalsImbalanceBlock(snapshot);
		if (imbalanceBlock) sections.push(imbalanceBlock);

		const statsLines: string[] = [
			`  Transactions: ${totals.totalTransactions}`,
			`  Matched: ${totals.totalMatched}`,
			`  Unmatched: ${totals.totalUnmatched}`,
			`  Match rate: ${totals.overallMatchRate}`
		];
		sections.push(`${BLOCKQUOTE_OPEN}🧾 <b>Stats</b>\n${statsLines.join("\n")}${BLOCKQUOTE_CLOSE}`);

		if (totals.byRoute.length > 0) {
			sections.push(this.buildRoutesBlock(totals.byRoute.slice(0, 8), "🔀 <b>Top routes</b>"));
		}

		if (totals.byNetwork.length > 0) {
			const lines = totals.byNetwork.map(
				(n) => `  ${n.network}: ${n.totalCount}× (in ${n.inputCount} / out ${n.outputCount})`
			);
			sections.push(`${BLOCKQUOTE_OPEN}🌐 <b>Activity by network</b>\n${lines.join("\n")}${BLOCKQUOTE_CLOSE}`);
		}

		const failuresByToken = Object.values(snapshot.perToken)
			.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.scanFailures.length > 0));
		if (failuresByToken.length > 0) {
			const failureLines: string[] = [];
			for (const entry of failuresByToken) {
				for (const failure of entry.scanFailures) {
					failureLines.push(`  ${entry.token} · ${failure.network}: ${this.escapeHtml(failure.detail)}`);
				}
			}
			sections.push(this.buildFailuresBlock(failureLines, "🚨 <b>Scan failures — totals are PARTIAL</b>"));
		}

		sections.push(`<i>Duration: ${this.formatDuration(totals.durationMs)}</i>`);
		return sections.join("\n\n");
	}

	private formatUsd(value: number): string {
		if (!Number.isFinite(value)) return "—";
		const absolute = Math.abs(value);
		const sign = value < 0 ? "-" : "";
		if (absolute > 0 && absolute < 0.01) {
			return `${sign}&lt;$0.01`;
		}
		return `${sign}$${absolute.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	private formatTokenAmount(value: number): string {
		if (!Number.isFinite(value)) return "—";
		return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
	}

	private buildRemintFinishMessage(report: RemintReport): string {
		const lines: string[] = [`✅ <b>Remint finished</b> — ${report.date}`, ""];

		const mintedChains = report.perChain.filter((chain) => chain.newMintedRaw > 0n);
		if (mintedChains.length > 0) {
			for (const chain of mintedChains) {
				lines.push(`  ${chain.network}: ${this.formatUsdc(chain.newMintedRaw)} USDC`);
			}
			lines.push("");
			lines.push(`<b>Total: ${this.formatUsdc(report.totalMintedRaw)} USDC</b>`);
		} else {
			lines.push("No new mints — no missed bridges in the last 24h.");
		}

		const failedChains = report.perChain.filter((chain) => chain.failedCount > 0);
		if (failedChains.length > 0) {
			lines.push("");
			lines.push("⚠️ <b>Failed mints (manual retry needed):</b>");
			for (const chain of failedChains) {
				lines.push(`  ${chain.network}: ${chain.failedCount}`);
			}
		}

		lines.push("");
		lines.push(`<i>Duration: ${this.formatDuration(report.durationMs)}</i>`);

		return lines.join("\n");
	}

	private formatUsdc(rawAmount: bigint): string {
		return (Number(rawAmount) / 1e6).toLocaleString(undefined, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 6
		});
	}

	private formatDuration(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;
		const parts: string[] = [];
		if (hours > 0) parts.push(`${hours}h`);
		if (minutes > 0) parts.push(`${minutes}m`);
		if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
		return parts.join(" ");
	}

	private buildMessages(snapshot: Snapshot, previousTotals: PreviousTotals | null): string[] {
		const atoms: string[] = [];
		atoms.push(this.buildHeader(snapshot));
		atoms.push(...this.buildTotalsAtoms(snapshot, previousTotals));
		atoms.push(...this.buildTokensAtoms(snapshot));
		atoms.push(...this.buildStablesAtoms(snapshot));
		atoms.push(...this.buildNativesAtoms(snapshot));
		return this.assembleMessages(atoms);
	}

	private buildHeader(snapshot: Snapshot): string {
		return `📊 <b>Daily Balance Snapshot</b> — ${snapshot.date}\n<i>Generated: ${formatTimestamp(snapshot.generatedAt)}</i>`;
	}

	private buildTokensAtoms(snapshot: Snapshot): string[] {
		const blocks: string[] = [];
		const nativeSymbols = collectNativeSymbols();

		for (const symbol of Object.values(TokenSymbol)) {
			if (isStableSymbol(symbol)) continue;
			if (nativeSymbols.has(symbol) && !hasAnyVault(symbol)) continue;
			const block = this.buildWorkingTokenBlock(symbol, snapshot);
			if (block) blocks.push(block);
		}

		if (blocks.length === 0) return [];
		return ["🪙 <b>TOKENS</b>", ...blocks];
	}

	private buildWorkingTokenBlock(symbol: TokenSymbol, snapshot: Snapshot): string | null {
		const rows: string[] = [];

		for (const chain of orderedChains(snapshot)) {
			const source = findTokenSource(chain, symbol);
			if (!source) continue;

			const tokenBalance = source.tokens.find((token) => token.symbol === symbol);
			if (!tokenBalance) continue;

			if (isHiddenZero(tokenBalance)) continue;
			const stableSymbol = getStableForToken(symbol, chain.chain);
			const stableBalance = source.tokens.find((token) => token.symbol === stableSymbol);

			const tokenStr = this.amountString(tokenBalance);
			const stableStr = stableBalance ? this.amountString(stableBalance) : "—";
			rows.push(`  ${chain.chain}: ${tokenStr} ${symbol} │ ${stableStr} ${stableSymbol}`);
		}

		if (rows.length === 0) return null;

		return `${BLOCKQUOTE_OPEN}🔹 <b>${symbol}</b>\n${this.escapeHtml(rows.join("\n"))}${BLOCKQUOTE_CLOSE}`;
	}

	private buildStablesAtoms(snapshot: Snapshot): string[] {
		const blocks: string[] = [];
		for (const symbol of Object.values(TokenSymbol)) {
			if (!isStableSymbol(symbol)) continue;
			const block = this.buildStableBlock(symbol, snapshot);
			if (block) blocks.push(block);
		}

		if (blocks.length === 0) return [];
		return ["💵 <b>STABLES</b>", ...blocks];
	}

	private buildStableBlock(symbol: TokenSymbol, snapshot: Snapshot): string | null {
		const chainBlocks: string[] = [];

		for (const chain of orderedChains(snapshot)) {
			const breakdown = collectStableSources(symbol, chain);
			if (breakdown === null) continue;

			const chainTotalStr = formatAmount(breakdown.total, breakdown.totalDecimals);
			if (chainTotalStr === "0") continue;

			const lines = breakdown.sources.map(
				(source) => `    ${source.label}: ${formatAmount(source.amount, source.decimals)} ${symbol}`
			);
			lines.push(`    Total: ${chainTotalStr} ${symbol}`);
			chainBlocks.push(`  ${chain.chain}:\n${lines.join("\n")}`);
		}

		if (chainBlocks.length === 0) return null;

		return `${BLOCKQUOTE_OPEN}🔸 <b>${symbol}</b>\n${this.escapeHtml(chainBlocks.join("\n"))}${BLOCKQUOTE_CLOSE}`;
	}

	private buildNativesAtoms(snapshot: Snapshot): string[] {
		const blocks: string[] = [];

		for (const chain of orderedChains(snapshot)) {
			const breakdown = collectNativeSources(chain);
			if (breakdown === null) continue;

			const totalStr = formatAmount(breakdown.total, breakdown.decimals);
			if (totalStr === "0") continue;

			const symbol = breakdown.symbol;
			const lines = breakdown.sources.map(
				(source) => `    ${source.label}: ${formatAmount(source.amount, breakdown.decimals)} ${symbol}`
			);
			lines.push(`    Total: ${totalStr} ${symbol}`);
			blocks.push(`  ${chain.chain} (${symbol}):\n${lines.join("\n")}`);
		}

		if (blocks.length === 0) return [];
		return ["🌐 <b>NATIVES</b>", `${BLOCKQUOTE_OPEN}${this.escapeHtml(blocks.join("\n"))}${BLOCKQUOTE_CLOSE}`];
	}

	private buildTotalsAtoms(snapshot: Snapshot, previousTotals: PreviousTotals | null): string[] {
		const nativesBySymbol: Partial<Record<TokenSymbol, bigint>> = {};
		for (const native of Object.values(snapshot.grandTotals.natives)) {
			if (!native || native.amount === null) continue;
			const normalized = convertDecimals(native.amount, native.decimals, COMMON_DECIMALS);
			nativesBySymbol[native.symbol] = (nativesBySymbol[native.symbol] ?? 0n) + normalized;
		}

		const aliasToCanonical = new Map<TokenSymbol, TokenSymbol>();
		for (const [canonical, aliases] of Object.entries(tokenAliases)) {
			if (!aliases) continue;
			for (const alias of aliases) {
				aliasToCanonical.set(alias, canonical as TokenSymbol);
			}
		}

		const grandByCanonical: Partial<Record<TokenSymbol, bigint>> = {};
		for (const symbol of Object.values(TokenSymbol)) {
			const traded = snapshot.grandTotals.tokens[symbol] ?? 0n;
			const native = nativesBySymbol[symbol] ?? 0n;
			const combined = traded + native;
			if (combined === 0n) continue;
			const canonical = aliasToCanonical.get(symbol) ?? symbol;
			grandByCanonical[canonical] = (grandByCanonical[canonical] ?? 0n) + combined;
		}

		const grandNonStableLines: string[] = [];
		const grandStableLines: string[] = [];
		for (const symbol of Object.values(TokenSymbol)) {
			const amount = grandByCanonical[symbol];
			if (amount === undefined) continue;
			const amountStr = formatAmount(amount, COMMON_DECIMALS);
			if (amountStr === "0") continue;
			const line = `  ${symbol}: ${amountStr} ${symbol}`;
			if (isStableSymbol(symbol)) {
				grandStableLines.push(line);
			} else {
				grandNonStableLines.push(line);
			}
		}

		const grandLines: string[] = [];
		if (grandNonStableLines.length > 0 || grandStableLines.length > 0) {
			grandLines.push("Grand totals:");
			grandLines.push(...grandNonStableLines);
			if (grandStableLines.length > 0) {
				if (grandNonStableLines.length > 0) grandLines.push("  ─────────");
				grandLines.push(...grandStableLines);
				const stablesTotalStr = formatAmount(snapshot.grandTotals.stablesTotal, COMMON_DECIMALS);
				const stablesDelta = previousTotals
					? this.formatDelta(snapshot.grandTotals.stablesTotal, previousTotals.stablesTotal, COMMON_DECIMALS)
					: "";
				const stablesDeltaPart = stablesDelta ? ` (${stablesDelta})` : "";
				grandLines.push(`  Stables total: ${stablesTotalStr} USD${stablesDeltaPart}`);
			}
		}

		const tokenLines: string[] = [];
		for (const symbol of Object.values(TokenSymbol)) {
			if (isStableSymbol(symbol)) continue;
			const amount = snapshot.grandTotals.tokens[symbol] ?? 0n;
			if (amount === 0n) continue;
			const amountStr = formatAmount(amount, COMMON_DECIMALS);
			if (amountStr === "0") continue;
			const delta = previousTotals
				? this.formatDelta(amount, previousTotals.tokens[symbol] ?? 0n, COMMON_DECIMALS)
				: "";
			const deltaPart = delta ? ` (${delta})` : "";
			tokenLines.push(`  ${symbol}: ${amountStr} ${symbol}${deltaPart}`);
		}

		const nativeLines: string[] = [];
		for (const symbol of Object.values(TokenSymbol)) {
			const amount = nativesBySymbol[symbol];
			if (amount === undefined || amount === 0n) continue;
			const amountStr = formatAmount(amount, COMMON_DECIMALS);
			if (amountStr === "0") continue;
			nativeLines.push(`  ${symbol}: ${amountStr} ${symbol}`);
		}

		const stableLines: string[] = [];
		for (const symbol of Object.values(TokenSymbol)) {
			if (!isStableSymbol(symbol)) continue;
			const amount = snapshot.grandTotals.tokens[symbol] ?? 0n;
			if (amount === 0n) continue;
			const amountStr = formatAmount(amount, COMMON_DECIMALS);
			if (amountStr === "0") continue;
			const delta = previousTotals
				? this.formatDelta(amount, previousTotals.tokens[symbol] ?? 0n, COMMON_DECIMALS)
				: "";
			const deltaPart = delta ? ` (${delta})` : "";
			stableLines.push(`  ${symbol}: ${amountStr} ${symbol}${deltaPart}`);
		}

		const breakdownLines: string[] = [];
		if (tokenLines.length > 0) {
			breakdownLines.push("Tokens:");
			breakdownLines.push(...tokenLines);
		}
		if (nativeLines.length > 0) {
			breakdownLines.push("Natives:");
			breakdownLines.push(...nativeLines);
		}
		if (stableLines.length > 0) {
			breakdownLines.push("Stables:");
			breakdownLines.push(...stableLines);
		}

		if (grandLines.length === 0 && breakdownLines.length === 0) return [];

		const atoms: string[] = ["📈 <b>TOTALS</b>"];
		if (grandLines.length > 0) {
			atoms.push(`${BLOCKQUOTE_OPEN}${this.escapeHtml(grandLines.join("\n"))}${BLOCKQUOTE_CLOSE}`);
		}
		if (breakdownLines.length > 0) {
			atoms.push(`${BLOCKQUOTE_OPEN}${this.escapeHtml(breakdownLines.join("\n"))}${BLOCKQUOTE_CLOSE}`);
		}
		return atoms;
	}

	private formatDelta(current: bigint, previous: bigint, decimals: number): string {
		const diff = current - previous;
		if (diff === 0n) return "";
		const sign = diff > 0n ? "+" : "-";
		const absolute = diff > 0n ? diff : -diff;
		return `${sign}${formatAmount(absolute, decimals)}`;
	}

	private amountString(balance: TokenBalance): string {
		if (balance.amount === null) return "failed";
		return formatAmount(balance.amount, balance.decimals);
	}

	private escapeHtml(text: string): string {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	// Greedy assembly: accumulate atoms into Telegram-sized messages, never split inside an atom.
	// If a single atom exceeds the limit (rare), `fitAtom` chops it on safe boundaries first.
	private assembleMessages(atoms: string[]): string[] {
		const messages: string[] = [];
		let current = "";
		for (const atom of atoms) {
			for (const piece of this.fitAtom(atom)) {
				const candidate = current.length === 0 ? piece : `${current}\n\n${piece}`;
				if (candidate.length <= TELEGRAM_MESSAGE_LIMIT) {
					current = candidate;
					continue;
				}
				if (current.length > 0) messages.push(current);
				current = piece;
			}
		}
		if (current.length > 0) messages.push(current);
		return messages;
	}

	// Chop a single oversized atom into pieces that each fit the Telegram limit.
	// Blockquote atoms split on inner-text newlines and re-wrap each piece in its own blockquote
	// so HTML stays valid; other atoms hard-split on the last newline before the limit.
	private fitAtom(atom: string): string[] {
		if (atom.length <= TELEGRAM_MESSAGE_LIMIT) return [atom];

		if (atom.startsWith(BLOCKQUOTE_OPEN) && atom.endsWith(BLOCKQUOTE_CLOSE)) {
			const inner = atom.slice(BLOCKQUOTE_OPEN.length, atom.length - BLOCKQUOTE_CLOSE.length);
			const innerLimit = TELEGRAM_MESSAGE_LIMIT - BLOCKQUOTE_OPEN.length - BLOCKQUOTE_CLOSE.length;
			const pieces: string[] = [];
			let buffer = "";
			for (const line of inner.split("\n")) {
				const candidate = buffer.length === 0 ? line : `${buffer}\n${line}`;
				if (candidate.length <= innerLimit) {
					buffer = candidate;
					continue;
				}
				if (buffer.length > 0) pieces.push(`${BLOCKQUOTE_OPEN}${buffer}${BLOCKQUOTE_CLOSE}`);
				buffer = line;
			}
			if (buffer.length > 0) pieces.push(`${BLOCKQUOTE_OPEN}${buffer}${BLOCKQUOTE_CLOSE}`);
			log.warning(`telegram: atom exceeded ${TELEGRAM_MESSAGE_LIMIT} bytes, split into ${pieces.length} pieces`);
			return pieces;
		}

		const pieces: string[] = [];
		let remaining = atom;
		while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
			let cutAt = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
			if (cutAt < TELEGRAM_MESSAGE_LIMIT / 2) cutAt = TELEGRAM_MESSAGE_LIMIT;
			pieces.push(remaining.slice(0, cutAt));
			remaining = remaining.slice(cutAt).replace(/^\n+/, "");
		}
		if (remaining.length > 0) pieces.push(remaining);
		log.warning(`telegram: atom exceeded ${TELEGRAM_MESSAGE_LIMIT} bytes, split into ${pieces.length} pieces`);
		return pieces;
	}
}

export { TelegramService };
