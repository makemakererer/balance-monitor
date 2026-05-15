import { Network, ScanFailure } from "../../types";
import { errorMessage, log, sleep } from "../../utils";
import { BlockRange } from "./evm-block-range.resolver";

// Two-pass retry pattern for batched EVM RPC calls — see
// `feedback_two_pass_retry_pattern` in memory. The caller's `fetchOne` /
// `fetchChunk` is expected to handle its own per-call retry (returning null
// only after exhaustion); this helper retries the OUTER set of still-failing
// keys/chunks once more after every key has been attempted, up to `maxPasses`.

interface ChunkScanArgs<T> {
	network: Network;
	label: string;
	blockRange: BlockRange;
	chunkSize: number;
	maxPasses: number;
	fetchChunk: (start: number, end: number) => Promise<T[] | null>;
}

interface ChunkScanResult<T> {
	events: T[];
	failure: ScanFailure | null;
}

async function scanBlockRangeInChunks<T>(args: ChunkScanArgs<T>): Promise<ChunkScanResult<T>> {
	const { network, label, blockRange, chunkSize, maxPasses, fetchChunk } = args;
	const events: T[] = [];

	const allChunks: Array<{ start: number; end: number }> = [];
	for (let start = blockRange.fromBlock; start <= blockRange.toBlock; start += chunkSize) {
		allChunks.push({ start, end: Math.min(start + chunkSize - 1, blockRange.toBlock) });
	}
	const totalChunks = allChunks.length;

	let pending = allChunks;
	for (let pass = 1; pass <= maxPasses; pass++) {
		if (pending.length === 0) break;
		if (pass > 1) {
			log.warning(
				`[${network}] ${label} retry pass ${pass}/${maxPasses}: re-fetching ${pending.length} chunk(s) that failed earlier`
			);
		}
		const stillFailing: Array<{ start: number; end: number }> = [];
		for (const { start, end } of pending) {
			const chunkEvents = await fetchChunk(start, end);
			if (chunkEvents === null) stillFailing.push({ start, end });
			else events.push(...chunkEvents);
		}
		if (pass > 1) {
			const recovered = pending.length - stillFailing.length;
			log.info(`[${network}] ${label} retry pass ${pass}: recovered ${recovered}/${pending.length} chunk(s)`);
		}
		pending = stillFailing;
	}

	if (pending.length === 0) return { events, failure: null };

	const droppedBlocks = pending.reduce((sum, { start, end }) => sum + (end - start + 1), 0);
	const detail = `${label} lost ${pending.length}/${totalChunks} chunk(s) = ${droppedBlocks.toLocaleString()} block(s) after ${maxPasses} pass(es)`;
	log.error(`[${network}] ${detail}; data inside that range will be missing from this run`);
	return { events, failure: { network, detail } };
}

interface BatchFetchArgs<K, V> {
	network: Network;
	label: string;
	keys: K[];
	batchSize: number;
	maxPasses: number;
	fetchOne: (key: K) => Promise<V | null>;
}

interface BatchFetchResult<K, V> {
	items: Map<K, V>;
	failure: ScanFailure | null;
}

async function fetchInBatchesWithRetry<K, V>(args: BatchFetchArgs<K, V>): Promise<BatchFetchResult<K, V>> {
	const { network, label, keys, batchSize, maxPasses, fetchOne } = args;
	const items = new Map<K, V>();
	const totalCount = keys.length;

	let pending = keys;
	for (let pass = 1; pass <= maxPasses; pass++) {
		if (pending.length === 0) break;
		if (pass > 1) {
			log.warning(
				`[${network}] ${label} retry pass ${pass}/${maxPasses}: re-fetching ${pending.length} item(s)`
			);
		}
		const stillFailing: K[] = [];
		for (let offset = 0; offset < pending.length; offset += batchSize) {
			const batch = pending.slice(offset, offset + batchSize);
			const batchResults = await Promise.all(batch.map((key) => fetchOne(key)));
			for (let i = 0; i < batch.length; i++) {
				const result = batchResults[i];
				if (result === null) stillFailing.push(batch[i]);
				else items.set(batch[i], result);
			}
		}
		if (pass > 1) {
			const recovered = pending.length - stillFailing.length;
			log.info(`[${network}] ${label} retry pass ${pass}: recovered ${recovered}/${pending.length}`);
		}
		pending = stillFailing;
	}

	if (pending.length === 0) return { items, failure: null };

	const droppedCount = pending.length;
	log.error(
		`[${network}] permanently lost ${droppedCount}/${totalCount} ${label} after ${maxPasses} pass(es)`
	);
	return {
		items,
		failure: { network, detail: `lost ${droppedCount}/${totalCount} ${label} after ${maxPasses} pass(es)` }
	};
}

// Inner retry shim: try `fn` up to `retries` times with `retryDelayMs` between
// attempts. Returns null after exhaustion (instead of throwing) so the caller's
// outer pass-retry can re-queue this key for a later pass.
async function retryUntilNull<V>(
	fn: () => Promise<V | null>,
	args: {
		retries: number;
		retryDelayMs: number;
		network: Network;
		key: string;
	}
): Promise<V | null> {
	let remaining = args.retries;
	while (remaining > 0) {
		try {
			const result = await fn();
			if (result !== null) return result;
			remaining--;
			if (remaining === 0) {
				log.error(`[${args.network}] ${args.key} returned null after all retries`);
				return null;
			}
			await sleep(args.retryDelayMs);
		} catch (error) {
			remaining--;
			const message = errorMessage(error);
			log.warning(`[${args.network}] ${args.key} failed (${remaining} retries left): ${message}`);
			if (remaining === 0) {
				log.error(`[${args.network}] gave up on ${args.key}`);
				return null;
			}
			await sleep(args.retryDelayMs);
		}
	}
	return null;
}

export { scanBlockRangeInChunks, fetchInBatchesWithRetry, retryUntilNull };
