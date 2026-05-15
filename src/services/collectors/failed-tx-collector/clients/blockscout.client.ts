import { blockscoutLimits, evmChainMetadata } from "../../../../config";
import { Network } from "../../../../types";
import { EtherscanCompatibleClient } from "./etherscan-compatible.client";

class BlockscoutClient extends EtherscanCompatibleClient {
	constructor() {
		super("blockscout", blockscoutLimits);
	}

	protected buildUrl(network: Network, wallet: string, fromBlock: number, toBlock: number, page: number): string {
		const meta = evmChainMetadata[network];
		if (!meta) throw new Error(`[blockscout] no chain metadata for ${network}`);
		if (!meta.blockscoutBaseUrl) throw new Error(`[blockscout] no blockscoutBaseUrl for ${network}`);
		const params = new URLSearchParams({
			module: "account",
			action: "txlist",
			address: wallet,
			startblock: String(fromBlock),
			endblock: String(toBlock),
			page: String(page),
			offset: String(blockscoutLimits.pageSize),
			sort: "asc"
		});
		return `${meta.blockscoutBaseUrl}?${params.toString()}`;
	}
}

export { BlockscoutClient };
