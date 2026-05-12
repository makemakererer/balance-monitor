import * as fs from "fs";
import * as path from "path";
import { Snapshot, TokenSymbol } from "../types";

const SNAPSHOTS_DIR = "./data/snapshots";

const bigintReplacer = (_key: string, value: unknown): unknown => {
	return typeof value === "bigint" ? value.toString() : value;
};

interface PreviousTotals {
	date: string;
	tokens: Partial<Record<TokenSymbol, bigint>>;
	stablesTotal: bigint;
}

const writeBalanceSnapshot = (snapshot: Snapshot): string => {
	if (!fs.existsSync(SNAPSHOTS_DIR)) {
		fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
	}
	const filePath = path.join(SNAPSHOTS_DIR, `${snapshot.date}.json`);
	fs.writeFileSync(filePath, JSON.stringify(snapshot, bigintReplacer, 2), "utf-8");
	return filePath;
};

const snapshotExists = (date: string): boolean => {
	return fs.existsSync(path.join(SNAPSHOTS_DIR, `${date}.json`));
};

const readPreviousTotals = (currentDate: string): PreviousTotals | null => {
	if (!fs.existsSync(SNAPSHOTS_DIR)) return null;
	const priorDates = fs
		.readdirSync(SNAPSHOTS_DIR)
		.filter((name) => name.endsWith(".json"))
		.map((name) => name.slice(0, -5))
		.filter((date) => date < currentDate)
		.sort();
	const previousDate = priorDates.pop();
	if (!previousDate) return null;
	const filePath = path.join(SNAPSHOTS_DIR, `${previousDate}.json`);
	const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
		grandTotals: { tokens: Record<string, string>; stablesTotal: string };
	};
	const tokens: Partial<Record<TokenSymbol, bigint>> = {};
	for (const [symbol, value] of Object.entries(parsed.grandTotals.tokens)) {
		tokens[symbol as TokenSymbol] = BigInt(value);
	}
	return {
		date: previousDate,
		tokens,
		stablesTotal: BigInt(parsed.grandTotals.stablesTotal)
	};
};

export { writeBalanceSnapshot, snapshotExists, readPreviousTotals, PreviousTotals };
