import { ethers } from "ethers";
import { evmChainMetadata, networkRpcUrls } from "../../config";
import { Network } from "../../types";
import { findEvmBlockAfterTimestamp, findEvmBlockAtOrBeforeTimestamp } from "../../utils";

interface BlockRange {
	fromBlock: number;
	toBlock: number;
}

interface RangeWindow {
	fromTimestampSeconds: number;
	toTimestampSeconds: number;
}

// Per-(network, window) cache so the orchestrator + EvmArbTxCollector +
// FailedTxCollector path all share one binary-search per chain per run.
// `resolve` returns null when the window resolves to an empty block range
// (e.g. toBlock < fromBlock for a freshly-launched chain).
class EvmBlockRangeResolver {
	private readonly cache = new Map<string, Promise<BlockRange | null>>();

	public async resolve(network: Network, window: RangeWindow): Promise<BlockRange | null> {
		const key = `${network}:${window.fromTimestampSeconds}-${window.toTimestampSeconds}`;
		const cached = this.cache.get(key);
		if (cached) return cached;
		const promise = this.compute(network, window).catch((error) => {
			this.cache.delete(key);
			throw error;
		});
		this.cache.set(key, promise);
		return promise;
	}

	private async compute(network: Network, window: RangeWindow): Promise<BlockRange | null> {
		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[evm-block-range] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[evm-block-range] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });
		try {
			const fromBlock = await findEvmBlockAfterTimestamp(provider, window.fromTimestampSeconds, network);
			const toBlock = await findEvmBlockAtOrBeforeTimestamp(provider, window.toTimestampSeconds, network);
			if (toBlock < fromBlock) return null;
			return { fromBlock, toBlock };
		} finally {
			provider.destroy();
		}
	}
}

export { BlockRange, EvmBlockRangeResolver };
