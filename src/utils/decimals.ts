import { ethers } from "ethers";

function convertDecimals(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
	if (fromDecimals === toDecimals) return amount;
	if (fromDecimals > toDecimals) {
		return amount / 10n ** BigInt(fromDecimals - toDecimals);
	}
	return amount * 10n ** BigInt(toDecimals - fromDecimals);
}

function formatAmount(amount: bigint, decimals: number, maxFractionDigits: number = 4): string {
	const full = ethers.formatUnits(amount, decimals);
	const [whole, fraction = ""] = full.split(".");
	const trimmedFraction = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
	return trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : whole;
}

function formatTimestamp(isoString: string): string {
	return isoString.replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// USD displays — 2-decimal precision (cents). Used by native-spend stats,
// daily-report aggregators, and the per-token card builder.
function roundUsd2(value: number): number {
	return Math.round(value * 100) / 100;
}

// Profit math — 5-decimal precision so per-leg amount diffs don't lose
// sub-cent accuracy when they later roll up into route totals.
function roundProfit5(value: number): number {
	return Math.round(value * 100000) / 100000;
}

export { convertDecimals, formatAmount, formatTimestamp, roundUsd2, roundProfit5 };
