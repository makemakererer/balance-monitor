import { ethers } from "ethers";
import { retry } from "./retry";

// Binary search the largest block whose timestamp <= targetUnixSeconds. Each chain
// has its own block cadence, so we can't precompute; we ask the RPC. Each RPC call
// is retried so a transient blip doesn't lose the whole chain.
async function findEvmBlockAtOrBeforeTimestamp(
	provider: ethers.JsonRpcProvider,
	targetUnixSeconds: number,
	context: string
): Promise<number> {
	const latestBlockNumber = await retry(() => provider.getBlockNumber(), `${context} getBlockNumber`);
	const latestBlock = await retry(() => provider.getBlock(latestBlockNumber), `${context} getBlock(latest)`);
	if (!latestBlock) throw new Error(`[${context}] getBlock(${latestBlockNumber}) returned null`);
	if (latestBlock.timestamp <= targetUnixSeconds) return latestBlockNumber;

	let low = 0;
	let high = latestBlockNumber;
	let best = 0;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const block = await retry(() => provider.getBlock(mid), `${context} getBlock(${mid})`);
		if (!block) {
			low = mid + 1;
			continue;
		}
		if (block.timestamp <= targetUnixSeconds) {
			best = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return best;
}

// First block strictly AFTER targetUnixSeconds — i.e. the inclusive lower bound for "happened after target".
async function findEvmBlockAfterTimestamp(
	provider: ethers.JsonRpcProvider,
	targetUnixSeconds: number,
	context: string
): Promise<number> {
	const before = await findEvmBlockAtOrBeforeTimestamp(provider, targetUnixSeconds, context);
	return before + 1;
}

export { findEvmBlockAtOrBeforeTimestamp, findEvmBlockAfterTimestamp };
