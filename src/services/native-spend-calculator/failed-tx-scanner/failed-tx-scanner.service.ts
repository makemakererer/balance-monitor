import { evmChainMetadata } from "../../../config";
import { FailedTx, Network } from "../../../types";
import { BlockscoutClient } from "./clients/blockscout.client";
import { EtherscanClient } from "./clients/etherscan.client";
import { MoralisClient } from "./clients/moralis.client";
import { RoutescanClient } from "./clients/routescan.client";

class UnsupportedFailedTxChainError extends Error {
	constructor(public readonly network: Network) {
		super(`[failed-tx-scanner] no source configured for ${network}`);
	}
}

class FailedTxScanner {
	private readonly etherscan = new EtherscanClient();
	private readonly blockscout = new BlockscoutClient();
	private readonly routescan = new RoutescanClient();
	private readonly moralis = new MoralisClient();

	public async getWalletTxs(
		network: Network,
		wallet: string,
		fromBlock: number,
		toBlock: number
	): Promise<FailedTx[]> {
		const meta = evmChainMetadata[network];
		if (!meta) throw new Error(`[failed-tx-scanner] no chain metadata for ${network}`);
		switch (meta.failedTxSource) {
			case "etherscan":
				return this.etherscan.getWalletTxs(network, wallet, fromBlock, toBlock);
			case "blockscout":
				return this.blockscout.getWalletTxs(network, wallet, fromBlock, toBlock);
			case "routescan":
				return this.routescan.getWalletTxs(network, wallet, fromBlock, toBlock);
			case "moralis":
				return this.moralis.getWalletTxs(network, wallet, fromBlock, toBlock);
			case null:
				throw new UnsupportedFailedTxChainError(network);
		}
	}
}

export { FailedTxScanner, UnsupportedFailedTxChainError };
