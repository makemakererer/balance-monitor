import chalk from "chalk";

function timestamp(): string {
	return new Date().toISOString();
}

const log = {
	info: (msg: string): void => {
		console.log(`${chalk.gray(timestamp())} ${chalk.cyan("[INFO]")} ${msg}`);
	},
	success: (msg: string): void => {
		console.log(`${chalk.gray(timestamp())} ${chalk.green("[OK]")} ${msg}`);
	},
	warning: (msg: string): void => {
		console.log(`${chalk.gray(timestamp())} ${chalk.yellow("[WARN]")} ${msg}`);
	},
	error: (msg: string): void => {
		console.log(`${chalk.gray(timestamp())} ${chalk.red("[ERR]")} ${msg}`);
	},
	// Section header — phase/run boundaries. Distinct visually so they pop in the stream.
	important: (msg: string): void => {
		console.log(`${chalk.gray(timestamp())} ${chalk.magenta.bold("[*]")} ${chalk.bold(msg)}`);
	},
	// Throwaway timing / progress lines that don't deserve the [INFO] tag.
	time: (msg: string): void => {
		console.log(`${chalk.gray(timestamp())} ${chalk.gray("[T]")} ${msg}`);
	}
};

// Progress reporter that fires only when the floored-25% bucket changes.
// Pattern: call inside a loop, hold the returned `lastBucket` across calls.
//   let bucket = -1;
//   for (...) { bucket = reportProgress(label, i, total, bucket); }
function reportProgress(label: string, current: number, total: number, lastBucket: number): number {
	if (total <= 0) return lastBucket;
	const percent = Math.floor((current / total) * 100);
	const bucket = Math.min(100, percent - (percent % 25));
	if (bucket > lastBucket || current === total) {
		log.info(`${label}: ${current}/${total} (${percent}%)`);
		return bucket;
	}
	return lastBucket;
}

export { log, reportProgress };
