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
	}
};

export { log };
