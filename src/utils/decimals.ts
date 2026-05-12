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

export { convertDecimals, formatAmount, formatTimestamp };
