function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "—";
	const absolute = Math.abs(value);
	const sign = value < 0 ? "-" : "";
	if (absolute > 0 && absolute < 0.01) {
		return `${sign}&lt;$0.01`;
	}
	return `${sign}$${absolute.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Signed $ form for headline lines like "Net: +$69.36" / "−$28.79". For zero, returns "$0.00".
function formatUsdSigned(value: number): string {
	if (!Number.isFinite(value)) return "—";
	if (value === 0) return "$0.00";
	const absolute = Math.abs(value);
	const sign = value < 0 ? "−" : "+";
	if (absolute > 0 && absolute < 0.01) {
		return `${sign}&lt;$0.01`;
	}
	return `${sign}$${absolute.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Cost amounts are stored as positive numbers in our data model, but in reports
// they always represent a deduction → render with a leading minus. Zero stays
// unsigned ("$0.00").
function formatCostUsd(positiveAmount: number): string {
	if (positiveAmount === 0) return "$0.00";
	return formatUsdSigned(-positiveAmount);
}

function formatTokenAmount(value: number): string {
	if (!Number.isFinite(value)) return "—";
	return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

function formatDuration(ms: number): string {
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

// ISO is always `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC); take date + HH:MM.
function formatWindowEdge(iso: string): string {
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export { escapeHtml, formatUsd, formatUsdSigned, formatCostUsd, formatTokenAmount, formatDuration, formatWindowEdge };
