import { EtherscanCompatibleResponse, FailedTx, Network, ProviderLimits } from "../../../../types";
import { log, RequestThrottle } from "../../../../utils";
import { sleep } from "../../../../utils/retry";

abstract class EtherscanCompatibleClient {
	private readonly cache = new Map<string, Promise<FailedTx[]>>();
	private readonly throttle: RequestThrottle;
	protected readonly providerName: string;
	protected readonly limits: ProviderLimits;

	constructor(providerName: string, limits: ProviderLimits) {
		this.providerName = providerName;
		this.limits = limits;
		this.throttle = new RequestThrottle(limits.minRequestSpacingMs);
	}

	protected abstract buildUrl(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number,
		page: number
	): string;

	public async getWalletTxs(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number
	): Promise<FailedTx[]> {
		const cacheKey = `${network}:${wallet.toLowerCase()}:${fromBlock}-${toBlock}`;
		const cached = this.cache.get(cacheKey);
		if (cached) return cached;

		const promise = this.fetchWithPagination(network, wallet, fromBlock, toBlock);
		this.cache.set(cacheKey, promise);
		return promise;
	}

	private async fetchWithPagination(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number
	): Promise<FailedTx[]> {
		const all: FailedTx[] = [];
		for (let page = 1; page <= this.limits.maxPages; page++) {
			const txs = await this.fetchPageWithPasses(network, wallet, fromBlock, toBlock, page);
			all.push(...txs);
			if (txs.length < this.limits.pageSize) return all;
		}
		log.warning(
			`[${this.providerName}][${network}] hit maxPages=${this.limits.maxPages} for ${wallet} ${fromBlock}-${toBlock}; some txs may be missing`
		);
		return all;
	}

	private async fetchPageWithPasses(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number,
		page: number
	): Promise<FailedTx[]> {
		for (let pass = 1; pass <= this.limits.maxPasses; pass++) {
			const result = await this.tryFetchPage(network, wallet, fromBlock, toBlock, page);
			if (result !== null) return result;
			if (pass < this.limits.maxPasses) {
				log.warning(
					`[${this.providerName}][${network}] page ${page} retry pass ${pass + 1}/${this.limits.maxPasses}`
				);
			}
		}
		log.error(
			`[${this.providerName}][${network}] permanently lost page ${page} of ${wallet} after ${this.limits.maxPasses} passes`
		);
		return [];
	}

	private async tryFetchPage(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number,
		page: number
	): Promise<FailedTx[] | null> {
		let retries = this.limits.retries;
		while (retries > 0) {
			try {
				const body = await this.throttle.enqueue(() =>
					this.callTxList(network, wallet, fromBlock, toBlock, page)
				);
				return parseTxs(body);
			} catch (error) {
				retries--;
				const message = error instanceof Error ? error.message : String(error);
				log.warning(
					`[${this.providerName}][${network}] page ${page} request failed (${retries} retries left): ${message}`
				);
				if (retries === 0) return null;
				await sleep(this.limits.retryDelayMs);
			}
		}
		return null;
	}

	private async callTxList(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number,
		page: number
	): Promise<EtherscanCompatibleResponse> {
		const url = this.buildUrl(network, wallet, fromBlock, toBlock, page);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const body = (await response.json()) as EtherscanCompatibleResponse;
		if (body.status === "0" && body.message !== "No transactions found") {
			const detail = typeof body.result === "string" ? body.result : "";
			throw new Error(`${this.providerName} status=0: ${body.message} ${detail}`.trim());
		}
		return body;
	}
}

function parseTxs(body: EtherscanCompatibleResponse): FailedTx[] {
	if (typeof body.result === "string") return [];
	return body.result.map((tx) => ({
		hash: tx.hash,
		blockNumber: Number(tx.blockNumber),
		timeStamp: Number(tx.timeStamp),
		from: tx.from,
		to: tx.to,
		input: tx.input,
		isError: tx.isError === "1",
		gasUsed: BigInt(tx.gasUsed),
		gasPrice: BigInt(tx.gasPrice)
	}));
}

export { EtherscanCompatibleClient };
