import { ConfirmedSignatureInfo, Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { rpcScanLimits } from "../../config";
import { Network, ScanFailure } from "../../types";
import { errorMessage, log, reportProgress, sleep } from "../../utils";

interface SvmWindow {
	fromTimestampSeconds: number;
	toTimestampSeconds: number;
}

// Page backwards via getSignaturesForAddress, keep sigs whose blockTime falls
// inside [from, to). Stops once the cursor crosses below `from`. Throws after
// `svmSignatureMaxConsecutiveErrors` consecutive errors so the caller can decide
// whether to report a chain-level failure or proceed with the partial scan.
async function collectSvmSignaturesInWindow(
	connection: Connection,
	wallet: PublicKey,
	window: SvmWindow
): Promise<ConfirmedSignatureInfo[]> {
	const collected: ConfirmedSignatureInfo[] = [];
	let before: string | undefined = undefined;
	let stoppedByWindow = false;
	let consecutiveErrors = 0;

	while (!stoppedByWindow) {
		try {
			const page: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(wallet, {
				limit: rpcScanLimits.svmSignaturesPerCall,
				before
			});
			consecutiveErrors = 0;
			if (page.length === 0) break;

			for (const sig of page) {
				if (sig.blockTime === null || sig.blockTime === undefined) continue;
				if (sig.blockTime >= window.toTimestampSeconds) continue;
				if (sig.blockTime < window.fromTimestampSeconds) {
					stoppedByWindow = true;
					break;
				}
				collected.push(sig);
			}

			before = page[page.length - 1].signature;
			log.info(`[SOLANA] signatures scanned: page=${page.length} kept=${collected.length}`);
			await sleep(rpcScanLimits.svmSignatureCallDelayMs);
		} catch (error) {
			consecutiveErrors++;
			const message = errorMessage(error);
			if (consecutiveErrors >= rpcScanLimits.svmSignatureMaxConsecutiveErrors) {
				throw new Error(`[SOLANA] signature scan aborted after ${consecutiveErrors} consecutive errors: ${message}`);
			}
			if (message.includes("429")) {
				log.warning(
					`[SOLANA] rate limit (429) ${consecutiveErrors}/${rpcScanLimits.svmSignatureMaxConsecutiveErrors}, backing off ${rpcScanLimits.svmRateLimitBackoffMs}ms`
				);
				await sleep(rpcScanLimits.svmRateLimitBackoffMs);
				continue;
			}
			log.warning(
				`[SOLANA] signature page error ${consecutiveErrors}/${rpcScanLimits.svmSignatureMaxConsecutiveErrors}, retrying: ${message}`
			);
			await sleep(rpcScanLimits.svmGenericErrorBackoffMs);
		}
	}

	return collected;
}

type SvmTxMapper<T> = (sigInfo: ConfirmedSignatureInfo, tx: ParsedTransactionWithMeta) => T | null;

interface ParseSvmTransactionsArgs<T> {
	connection: Connection;
	signatures: ConfirmedSignatureInfo[];
	mapper: SvmTxMapper<T>;
	// When set, emits 25%-bucket progress lines (`[SOLANA] <label>: N/M`) during pass 1.
	progressLabel?: string;
}

interface ParseSvmTransactionsResult<T> {
	items: T[];
	failure: ScanFailure | null;
}

// Two-pass batched getParsedTransactions; the mapper inspects each (sigInfo, tx)
// and returns the converted record or null to skip. Returns aggregated items
// + a single ScanFailure entry if any batches were permanently lost.
async function parseSvmTransactionsInBatches<T>(args: ParseSvmTransactionsArgs<T>): Promise<ParseSvmTransactionsResult<T>> {
	const { connection, signatures, mapper, progressLabel } = args;
	const items: T[] = [];

	const allBatches: ConfirmedSignatureInfo[][] = [];
	for (let offset = 0; offset < signatures.length; offset += rpcScanLimits.svmTransactionsBatchSize) {
		allBatches.push(signatures.slice(offset, offset + rpcScanLimits.svmTransactionsBatchSize));
	}
	const totalBatches = allBatches.length;

	let pending = allBatches;
	for (let pass = 1; pass <= rpcScanLimits.svmTransactionsBatchMaxPasses; pass++) {
		if (pending.length === 0) break;
		if (pass > 1) {
			log.warning(
				`[SOLANA] parsed-tx retry pass ${pass}/${rpcScanLimits.svmTransactionsBatchMaxPasses}: re-fetching ${pending.length} batch(es)`
			);
		}

		const stillFailing: ConfirmedSignatureInfo[][] = [];
		let progressBucket = -1;
		let processed = 0;
		for (const batch of pending) {
			const batchItems = await tryFetchAndMapBatch(connection, batch, mapper);
			if (batchItems === null) stillFailing.push(batch);
			else items.push(...batchItems);
			processed += batch.length;
			if (pass === 1 && progressLabel) {
				progressBucket = reportProgress(`[SOLANA] ${progressLabel}`, processed, signatures.length, progressBucket);
			}
		}

		if (pass > 1) {
			const recovered = pending.length - stillFailing.length;
			log.info(`[SOLANA] parsed-tx retry pass ${pass}: recovered ${recovered}/${pending.length} batch(es)`);
		}
		pending = stillFailing;
	}

	if (pending.length === 0) return { items, failure: null };

	const droppedSigs = pending.reduce((sum, batch) => sum + batch.length, 0);
	const detail = `parsed-tx lost ${pending.length}/${totalBatches} batch(es) = ${droppedSigs} signature(s) after ${rpcScanLimits.svmTransactionsBatchMaxPasses} pass(es)`;
	log.error(`[SOLANA] ${detail}`);
	return { items, failure: { network: Network.SOLANA, detail } };
}

async function tryFetchAndMapBatch<T>(
	connection: Connection,
	batch: ConfirmedSignatureInfo[],
	mapper: SvmTxMapper<T>
): Promise<T[] | null> {
	let retries = rpcScanLimits.svmTransactionsBatchRetries;
	while (retries > 0) {
		try {
			const sigStrings = batch.map((sig) => sig.signature);
			const fetched = await connection.getParsedTransactions(sigStrings, {
				maxSupportedTransactionVersion: 0,
				commitment: "confirmed"
			});
			const out: T[] = [];
			for (let index = 0; index < fetched.length; index++) {
				const tx = fetched[index];
				if (!tx) continue;
				const mapped = mapper(batch[index], tx);
				if (mapped !== null) out.push(mapped);
			}
			await sleep(rpcScanLimits.svmTransactionsBatchInterDelayMs);
			return out;
		} catch (error) {
			retries--;
			const message = errorMessage(error);
			log.warning(`[SOLANA] batch failed (${retries} retries left): ${message}`);
			if (retries === 0) {
				log.error(`[SOLANA] gave up on batch of ${batch.length} signature(s)`);
				return null;
			}
			await sleep(rpcScanLimits.svmTransactionsBatchRetryDelayMs);
		}
	}
	return null;
}

export {
	SvmWindow,
	SvmTxMapper,
	collectSvmSignaturesInWindow,
	parseSvmTransactionsInBatches
};
