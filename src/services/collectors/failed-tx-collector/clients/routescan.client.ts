import { evmChainMetadata, routescanLimits } from "../../../../config";
import { Network } from "../../../../types";
import { EtherscanCompatibleClient } from "./etherscan-compatible.client";

class RoutescanClient extends EtherscanCompatibleClient {
	constructor() {
		super("routescan", routescanLimits);
	}

	protected buildUrl(network: Network, wallet: string, fromBlock: number, toBlock: number, page: number): string {
		const meta = evmChainMetadata[network];
		if (!meta) throw new Error(`[routescan] no chain metadata for ${network}`);
		const params = new URLSearchParams({
			module: "account",
			action: "txlist",
			address: wallet,
			startblock: String(fromBlock),
			endblock: String(toBlock),
			page: String(page),
			offset: String(routescanLimits.pageSize),
			sort: "asc"
		});
		return `${routescanLimits.baseUrl}/${meta.chainId}/etherscan/api?${params.toString()}`;
	}
}

export { RoutescanClient };
