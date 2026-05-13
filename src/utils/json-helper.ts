import * as fs from "fs";
import * as path from "path";
import { ProfitSnapshot, ReclaimPendingFile, Snapshot, TokenSymbol } from "../types";

const SNAPSHOTS_DIR = "./data/snapshots";
const RECLAIM_PENDING_DIR = "./data/reclaim-pending";
const PROFITS_DIR = "./data/profits";

const bigintReplacer = (_key: string, value: unknown): unknown => {
	return typeof value === "bigint" ? value.toString() : value;
};

interface PreviousTotals {
	date: string;
	tokens: Partial<Record<TokenSymbol, bigint>>;
	stablesTotal: bigint;
}

// Balance snapshot — `data/snapshots/YYYY-MM-DD.json`
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

// Reclaim-pending — `data/reclaim-pending/YYYY-MM-DD.json`
const writeReclaimPending = (file: ReclaimPendingFile): string => {
	if (!fs.existsSync(RECLAIM_PENDING_DIR)) {
		fs.mkdirSync(RECLAIM_PENDING_DIR, { recursive: true });
	}
	const filePath = path.join(RECLAIM_PENDING_DIR, `${file.date}.json`);
	fs.writeFileSync(filePath, JSON.stringify(file, null, 2), "utf-8");
	return filePath;
};

const reclaimPendingExists = (date: string): boolean => {
	return fs.existsSync(path.join(RECLAIM_PENDING_DIR, `${date}.json`));
};

// Profit snapshot — `data/profits/YYYY-MM-DD.json`. Written incrementally by
// the per-token loop; `grandTotals` is filled only after every token has
// completed, so `profitSnapshotComplete` distinguishes mid-run state from
// fully-done state (allows retry resume).
const writeProfitSnapshot = (snapshot: ProfitSnapshot): string => {
	if (!fs.existsSync(PROFITS_DIR)) {
		fs.mkdirSync(PROFITS_DIR, { recursive: true });
	}
	const filePath = path.join(PROFITS_DIR, `${snapshot.date}.json`);
	fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
	return filePath;
};

const readProfitSnapshot = (date: string): ProfitSnapshot | null => {
	const filePath = path.join(PROFITS_DIR, `${date}.json`);
	if (!fs.existsSync(filePath)) return null;
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProfitSnapshot;
};

const profitSnapshotComplete = (date: string): boolean => {
	const snapshot = readProfitSnapshot(date);
	return snapshot !== null && snapshot.grandTotals !== null;
};

const profitSnapshotPath = (date: string): string => {
	return path.join(PROFITS_DIR, `${date}.json`);
};

export {
	writeBalanceSnapshot,
	snapshotExists,
	readPreviousTotals,
	PreviousTotals,
	writeReclaimPending,
	reclaimPendingExists,
	writeProfitSnapshot,
	readProfitSnapshot,
	profitSnapshotComplete,
	profitSnapshotPath
};
