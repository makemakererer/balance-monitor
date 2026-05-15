import { evmChainMetadata, loadMoralisApiKey, moralisLimits } from "../../../../config";
import { FailedTx, MoralisRawTx, MoralisResponse, Network } from "../../../../types";
import { errorMessage, log, RequestThrottle } from "../../../../utils";
import { sleep } from "../../../../utils/retry";

class MoralisClient {
	private readonly cache = new Map<string, Promise<FailedTx[]>>();
	private readonly throttle = new RequestThrottle(moralisLimits.minRequestSpacingMs);
	private readonly apiKey: string = loadMoralisApiKey();

	public async getWalletTxs(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number
	): Promise<FailedTx[]> {
		const cacheKey = `${network}:${wallet.toLowerCase()}:${fromBlock}-${toBlock}`;
		const cached = this.cache.get(cacheKey);
		if (cached) return cached;

		const promise = this.fetchAllPages(network, wallet, fromBlock, toBlock);
		this.cache.set(cacheKey, promise);
		return promise;
	}

	private async fetchAllPages(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number
	): Promise<FailedTx[]> {
		const meta = evmChainMetadata[network];
		if (!meta) throw new Error(`[moralis] no chain metadata for ${network}`);
		const chainHex = `0x${meta.chainId.toString(16)}`;

		const all: FailedTx[] = [];
		let cursor: string | null = null;
		for (let page = 1; page <= moralisLimits.maxPages; page++) {
			const result = await this.fetchPageWithPasses(network, wallet, chainHex, fromBlock, toBlock, cursor, page);
			if (result === null) return all;
			all.push(...result.items);
			if (!result.nextCursor) return all;
			cursor = result.nextCursor;
		}
		log.warning(
			`[moralis][${network}] hit maxPages=${moralisLimits.maxPages} for ${wallet} ${fromBlock}-${toBlock}; some txs may be missing`
		);
		return all;
	}

	private async fetchPageWithPasses(
		network: Network,
		wallet: string,
		chainHex: string,
		fromBlock: number,
		toBlock: number,
		cursor: string | null,
		page: number
	): Promise<{ items: FailedTx[]; nextCursor: string | null } | null> {
		for (let pass = 1; pass <= moralisLimits.maxPasses; pass++) {
			const result = await this.tryFetchPage(network, wallet, chainHex, fromBlock, toBlock, cursor, page);
			if (result !== null) return result;
			if (pass < moralisLimits.maxPasses) {
				log.warning(
					`[moralis][${network}] page ${page} retry pass ${pass + 1}/${moralisLimits.maxPasses}`
				);
			}
		}
		log.error(
			`[moralis][${network}] permanently lost page ${page} of ${wallet} after ${moralisLimits.maxPasses} passes`
		);
		return null;
	}

	private async tryFetchPage(
		network: Network,
		wallet: string,
		chainHex: string,
		fromBlock: number,
		toBlock: number,
		cursor: string | null,
		page: number
	): Promise<{ items: FailedTx[]; nextCursor: string | null } | null> {
		let retries = moralisLimits.retries;
		while (retries > 0) {
			try {
				const body = await this.throttle.enqueue(() =>
					this.callHistory(wallet, chainHex, fromBlock, toBlock, cursor)
				);
				return { items: body.result.map(parseMoralisTx), nextCursor: body.cursor };
			} catch (error) {
				retries--;
				const message = errorMessage(error);
				log.warning(
					`[moralis][${network}] page ${page} request failed (${retries} retries left): ${message}`
				);
				if (retries === 0) return null;
				await sleep(moralisLimits.retryDelayMs);
			}
		}
		return null;
	}

	private async callHistory(
		wallet: string,
		chainHex: string,
		fromBlock: number,
		toBlock: number,
		cursor: string | null
	): Promise<MoralisResponse> {
		const params = new URLSearchParams({
			chain: chainHex,
			from_block: String(fromBlock),
			to_block: String(toBlock),
			order: "ASC",
			limit: String(moralisLimits.pageSize)
		});
		if (cursor) params.set("cursor", cursor);
		const url = `${moralisLimits.baseUrl}/wallets/${wallet}/history?${params.toString()}`;
		const response = await fetch(url, {
			headers: { "X-API-Key": this.apiKey, accept: "application/json" }
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return (await response.json()) as MoralisResponse;
	}
}

function parseMoralisTx(tx: MoralisRawTx): FailedTx {
	return {
		hash: tx.hash,
		blockNumber: Number(tx.block_number),
		timeStamp: Math.floor(Date.parse(tx.block_timestamp) / 1000),
		from: tx.from_address,
		to: tx.to_address ?? "",
		input: tx.input,
		isError: tx.receipt_status === "0",
		gasUsed: BigInt(tx.receipt_gas_used),
		gasPrice: BigInt(tx.gas_price)
	};
}

export { MoralisClient };
