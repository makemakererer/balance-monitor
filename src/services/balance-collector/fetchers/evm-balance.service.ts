import { ethers } from "ethers";
import { EXTRACTOR_ABI } from "../../../abis";
import {
	enabledNetworks,
	evmChainMetadata,
	extractorAddresses,
	loadMonitoredEvmWallets,
	MonitoredEvmWallets,
	networkRpcUrls,
	tokenConfig,
	tokensToChain,
	vaultExecutorAddresses
} from "../../../config";
import {
	ChainSnapshot,
	ChainType,
	EvmChainMeta,
	Network,
	SourceBalance,
	SourceType,
	TokenBalance,
	TokenSymbol
} from "../../../types";
import { errorMessage, log, retry } from "../../../utils";

const NATIVE_ADDRESS_SENTINEL = "native";

class EvmBalanceService {
	public async collect(): Promise<ChainSnapshot[]> {
		const wallets = loadMonitoredEvmWallets();
		const networks = (Object.keys(evmChainMetadata) as Network[]).filter((network) => enabledNetworks[network]);
		return Promise.all(networks.map((network) => this.collectChain(network, wallets)));
	}

	private async collectChain(network: Network, wallets: MonitoredEvmWallets): Promise<ChainSnapshot> {
		const rpcUrl = networkRpcUrls[network];
		const extractorAddr = extractorAddresses[network];
		const meta = evmChainMetadata[network];

		if (!rpcUrl) throw new Error(`[evm-balance] missing networkRpcUrls[${network}]`);
		if (!extractorAddr) throw new Error(`[evm-balance] missing extractorAddresses[${network}]`);
		if (!meta) throw new Error(`[evm-balance] missing evmChainMetadata[${network}]`);

		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });
		const extractor = new ethers.Contract(extractorAddr, EXTRACTOR_ABI, provider);

		const chainTokens = tokensToChain[network];
		const tokenSymbols = Object.keys(chainTokens) as TokenSymbol[];
		const tokenAddresses = tokenSymbols.map((symbol) => chainTokens[symbol]);

		for (const address of tokenAddresses) {
			if (!tokenConfig[address]) {
				throw new Error(`[evm-balance] missing tokenConfig entry for ${address} on ${network}`);
			}
		}

		const vaultEntries = Object.entries(vaultExecutorAddresses[network] ?? {}) as [TokenSymbol, string][];
		const vaultAddresses = vaultEntries.map(([, address]) => address);

		const accounts = [wallets.arb, ...vaultAddresses];
		const nativeAccounts = [wallets.arb, wallets.rebalancer, ...vaultAddresses];
		const tokensPerAccount = accounts.map(() => tokenAddresses);

		try {
			const result = (await retry(
				() => extractor.getBalances(tokensPerAccount, accounts, nativeAccounts),
				`${network} extractor.getBalances`
			)) as [bigint[][], bigint[]];

			const [balances, nativeBalances] = result;

			const sources: SourceBalance[] = [];

			sources.push(
				this.buildSource(SourceType.WALLET_ARB, "Arb wallet", tokenSymbols, tokenAddresses, balances[0], nativeBalances[0], meta)
			);

			sources.push({
				type: SourceType.WALLET_REBALANCER,
				label: "Rebalancer",
				native: this.buildNativeBalance(nativeBalances[1], meta),
				tokens: [],
				error: null
			});

			vaultEntries.forEach(([vaultSymbol], i) => {
				sources.push(
					this.buildSource(
						SourceType.VAULT,
						`Vault ${vaultSymbol}`,
						tokenSymbols,
						tokenAddresses,
						balances[i + 1],
						nativeBalances[i + 2],
						meta
					)
				);
			});

			return {
				chain: network,
				chainType: ChainType.EVM,
				sources,
				chainTotals: this.computeChainTotals(sources, meta)
			};
		} catch (error) {
			const message = errorMessage(error);
			return this.buildFailedChain(network, meta, vaultEntries, message);
		} finally {
			provider.destroy();
		}
	}

	private buildSource(
		type: SourceType,
		label: string,
		tokenSymbols: TokenSymbol[],
		tokenAddresses: string[],
		balanceRow: bigint[],
		nativeBalance: bigint,
		meta: EvmChainMeta
	): SourceBalance {
		const tokens: TokenBalance[] = tokenSymbols.map((symbol, i) => {
			const address = tokenAddresses[i];
			const info = tokenConfig[address];
			if (!info) {
				throw new Error(`[evm-balance] missing tokenConfig entry for ${address}`);
			}
			return {
				symbol,
				address,
				amount: balanceRow[i],
				decimals: info.decimals,
				error: null
			};
		});

		return {
			type,
			label,
			native: this.buildNativeBalance(nativeBalance, meta),
			tokens,
			error: null
		};
	}

	private buildNativeBalance(amount: bigint, meta: EvmChainMeta): TokenBalance {
		return {
			symbol: meta.nativeSymbol,
			address: NATIVE_ADDRESS_SENTINEL,
			amount,
			decimals: meta.nativeDecimals,
			error: null
		};
	}

	private computeChainTotals(sources: SourceBalance[], meta: EvmChainMeta): ChainSnapshot["chainTotals"] {
		const tokens: Partial<Record<TokenSymbol, bigint>> = {};
		let nativeTotal = 0n;

		for (const source of sources) {
			for (const tb of source.tokens) {
				if (tb.amount === null) continue;
				tokens[tb.symbol] = (tokens[tb.symbol] ?? 0n) + tb.amount;
			}
			if (source.native?.amount != null) {
				nativeTotal += source.native.amount;
			}
		}

		const native: TokenBalance = {
			symbol: meta.nativeSymbol,
			address: NATIVE_ADDRESS_SENTINEL,
			amount: nativeTotal,
			decimals: meta.nativeDecimals,
			error: null
		};

		return { tokens, native };
	}

	private buildFailedChain(
		network: Network,
		meta: EvmChainMeta,
		vaultEntries: [TokenSymbol, string][],
		errorMessage: string
	): ChainSnapshot {
		log.error(`[${network}] EVM batch fetch failed: ${errorMessage}`);
		const failedNative = (): TokenBalance => ({
			symbol: meta.nativeSymbol,
			address: NATIVE_ADDRESS_SENTINEL,
			amount: null,
			decimals: meta.nativeDecimals,
			error: errorMessage
		});

		const sources: SourceBalance[] = [
			{ type: SourceType.WALLET_ARB, label: "Arb wallet", native: failedNative(), tokens: [], error: errorMessage },
			{
				type: SourceType.WALLET_REBALANCER,
				label: "Rebalancer",
				native: failedNative(),
				tokens: [],
				error: errorMessage
			}
		];

		for (const [vaultSymbol] of vaultEntries) {
			sources.push({
				type: SourceType.VAULT,
				label: `Vault ${vaultSymbol}`,
				native: failedNative(),
				tokens: [],
				error: errorMessage
			});
		}

		return {
			chain: network,
			chainType: ChainType.EVM,
			sources,
			chainTotals: { tokens: {}, native: null }
		};
	}
}

export { EvmBalanceService };
