import * as fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { getStableForToken, isStableSymbol, tokenAliases } from "../../config";
import { RemintReport, RemintWindow, Snapshot, TokenBalance, TokenSymbol } from "../../types";
import {
	COMMON_DECIMALS,
	PreviousTotals,
	collectNativeSymbols,
	collectNativeSources,
	collectStableSources,
	convertDecimals,
	escapeHtml,
	findTokenSource,
	formatAmount,
	formatDuration,
	formatTimestamp,
	formatWindowEdge,
	hasAnyVault,
	isHiddenZero,
	log,
	orderedChains
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

	// Generic primitive: send pre-rendered HTML. Daily-report uses this for all
	// per-token cards + daily total — the rendering lives in `daily-report/formatters`.
	public async sendHtml(text: string): Promise<void> {
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
	}

	// Generic primitive: attach a JSON file by path. Caption is optional —
	// daily-report sends snapshot JSONs without one (the filename carries the
	// context).
	public async sendJsonAttachment(filePath: string, fileName: string, caption?: string): Promise<void> {
		const options = caption ? { caption, parse_mode: "HTML" as const } : {};
		await this.bot.sendDocument(
			this.chatId,
			fs.createReadStream(filePath),
			options,
			{ filename: fileName, contentType: "application/json" }
		);
		log.success(`telegram: attachment sent — ${fileName}`);
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

	public async sendReportingStart(): Promise<void> {
		const text = `📡 <b>Collecting cross-chain data</b>\n<i>SVM signatures, EVM rebalance events, failed-tx lists — this can take a few minutes</i>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: reporting start signal sent");
	}

	public async sendDailyRunFinish(date: string, durationMs: number): Promise<void> {
		const text = `🎉 <b>Daily run finished</b> — ${date}\n<i>Duration: ${formatDuration(durationMs)}</i>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: daily run finish signal sent");
	}

	public async sendRemintStart(date: string, window: RemintWindow): Promise<void> {
		const windowLine = `${formatWindowEdge(window.fromIso)} → ${formatWindowEdge(window.toIso)} UTC`;
		const text = `🔄 <b>Remint started</b> — ${date}\n<i>Window: ${windowLine}</i>`;
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: remint start signal sent");
	}

	public async sendRemintFinish(report: RemintReport): Promise<void> {
		const text = this.buildRemintFinishMessage(report);
		await this.bot.sendMessage(this.chatId, text, { parse_mode: "HTML" });
		log.success("telegram: remint finish report sent");
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

		if (report.failedRoutes.length > 0) {
			lines.push("");
			lines.push("⚠️ <b>Failed mints (manual retry needed):</b>");
			for (const route of report.failedRoutes) {
				lines.push(`  ${route.source} → ${route.destination}: ${route.count}`);
			}
		}

		lines.push("");
		lines.push(`<i>Duration: ${formatDuration(report.durationMs)}</i>`);

		return lines.join("\n");
	}

	private formatUsdc(rawAmount: bigint): string {
		return (Number(rawAmount) / 1e6).toLocaleString(undefined, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 6
		});
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

		return `${BLOCKQUOTE_OPEN}🔹 <b>${symbol}</b>\n${escapeHtml(rows.join("\n"))}${BLOCKQUOTE_CLOSE}`;
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

		return `${BLOCKQUOTE_OPEN}🔸 <b>${symbol}</b>\n${escapeHtml(chainBlocks.join("\n"))}${BLOCKQUOTE_CLOSE}`;
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
		return ["🌐 <b>NATIVES</b>", `${BLOCKQUOTE_OPEN}${escapeHtml(blocks.join("\n"))}${BLOCKQUOTE_CLOSE}`];
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
			atoms.push(`${BLOCKQUOTE_OPEN}${escapeHtml(grandLines.join("\n"))}${BLOCKQUOTE_CLOSE}`);
		}
		if (breakdownLines.length > 0) {
			atoms.push(`${BLOCKQUOTE_OPEN}${escapeHtml(breakdownLines.join("\n"))}${BLOCKQUOTE_CLOSE}`);
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

	// Greedy assembly: accumulate atoms into Telegram-sized messages, never split inside an atom.
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
