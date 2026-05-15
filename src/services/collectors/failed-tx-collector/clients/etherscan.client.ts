import { etherscanLimits, evmChainMetadata, loadEtherscanApiKey } from "../../../../config";
import { Network } from "../../../../types";
import { EtherscanCompatibleClient } from "./etherscan-compatible.client";

class EtherscanClient extends EtherscanCompatibleClient {
	private readonly apiKey: string = loadEtherscanApiKey();

	constructor() {
		super("etherscan", etherscanLimits);
	}

	protected buildUrl(network: Network, wallet: string, fromBlock: number, toBlock: number, page: number): string {
		const meta = evmChainMetadata[network];
		if (!meta) throw new Error(`[etherscan] no chain metadata for ${network}`);
		const params = new URLSearchParams({
			chainid: String(meta.chainId),
			module: "account",
			action: "txlist",
			address: wallet,
			startblock: String(fromBlock),
			endblock: String(toBlock),
			page: String(page),
			offset: String(etherscanLimits.pageSize),
			sort: "asc",
			apikey: this.apiKey
		});
		return `${etherscanLimits.baseUrl}?${params.toString()}`;
	}
}

export { EtherscanClient };
