import { retryConfig } from "../config/retry.config";
import { log } from "./logger";

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(
	executeFunction: () => Promise<T>,
	context: string,
	maxAttempts: number = retryConfig.defaultMaxAttempts,
	delayMs: number = retryConfig.defaultDelayMs
): Promise<T> {
	let lastError: Error = new Error("retry: no attempts executed");

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await executeFunction();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (attempt === maxAttempts) {
				log.error(`[${context}] retry failed after ${maxAttempts} attempts: ${lastError.message}`);
				throw lastError;
			}

			const currentDelay = delayMs * attempt;
			log.warning(
				`[${context}] attempt ${attempt}/${maxAttempts} failed, retry in ${currentDelay / 1000}s: ${lastError.message}`
			);
			await sleep(currentDelay);
		}
	}

	throw lastError;
}

export { retry, sleep };
