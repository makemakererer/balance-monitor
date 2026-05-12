import { AccountLayout, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import {
	enabledNetworks,
	loadMonitoredSvmWallet,
	svmChainMetadata,
	svmRpcUrl,
	tokenConfig,
	tokensToChain
} from "../../../config";
import {
	ChainSnapshot,
	ChainType,
	Network,
	SourceBalance,
	SourceType,
	SvmChainMeta,
	TokenBalance,
	TokenSymbol
} from "../../../types";
import { log, retry } from "../../../utils";

const NATIVE_ADDRESS_SENTINEL = "native";

type SplAccountsResult = PromiseSettledResult<(AccountInfo<Buffer> | null)[]>;
type NativeLamportsResult = PromiseSettledResult<number>;

class SvmBalanceService {
	public async collect(): Promise<ChainSnapshot[]> {
		if (!enabledNetworks[Network.SOLANA]) return [];
		const walletAddress = loadMonitoredSvmWallet();
		return [await this.collectSolana(walletAddress)];
	}

	private async collectSolana(walletAddress: string): Promise<ChainSnapshot> {
		const meta = svmChainMetadata[Network.SOLANA];
		if (!meta) throw new Error(`[svm-balance] missing svmChainMetadata[${Network.SOLANA}]`);

		const chainTokens = tokensToChain[Network.SOLANA];
		if (!chainTokens) throw new Error(`[svm-balance] missing tokensToChain[${Network.SOLANA}]`);

		const tokenSymbols = Object.keys(chainTokens) as TokenSymbol[];
		const mintAddresses = tokenSymbols.map((symbol) => chainTokens[symbol]);

		for (const mint of mintAddresses) {
			if (!tokenConfig[mint]) {
				throw new Error(`[svm-balance] missing tokenConfig entry for ${mint}`);
			}
		}

		const ownerPubkey = new PublicKey(walletAddress);
		const ataAddresses = mintAddresses.map((mint) => getAssociatedTokenAddressSync(new PublicKey(mint), ownerPubkey));

		const connection = new Connection(svmRpcUrl, "confirmed");

		const [splResult, nativeResult] = await Promise.allSettled([
			retry(() => connection.getMultipleAccountsInfo(ataAddresses), "solana getMultipleAccountsInfo"),
			retry(() => connection.getBalance(ownerPubkey), "solana getBalance")
		]);

		const tokens = this.buildSplTokens(tokenSymbols, mintAddresses, splResult);
		const native = this.buildNative(meta, nativeResult);

		const source: SourceBalance = {
			type: SourceType.WALLET_ARB,
			label: "Solana wallet",
			native,
			tokens,
			error: null
		};

		return {
			chain: Network.SOLANA,
			chainType: ChainType.SVM,
			sources: [source],
			chainTotals: this.computeChainTotals(tokens, native)
		};
	}

	private buildSplTokens(
		tokenSymbols: TokenSymbol[],
		mintAddresses: string[],
		splResult: SplAccountsResult
	): TokenBalance[] {
		if (splResult.status === "rejected") {
			const message = splResult.reason instanceof Error ? splResult.reason.message : String(splResult.reason);
			log.error(`[SOLANA] SPL batch fetch failed: ${message}`);
			return tokenSymbols.map((symbol, index) => ({
				symbol,
				address: mintAddresses[index],
				amount: null,
				decimals: tokenConfig[mintAddresses[index]].decimals,
				error: message
			}));
		}

		return tokenSymbols.map((symbol, index) => {
			const mint = mintAddresses[index];
			const accountInfo = splResult.value[index];
			const decimals = tokenConfig[mint].decimals;

			if (!accountInfo) {
				return { symbol, address: mint, amount: 0n, decimals, error: null };
			}

			try {
				const decoded = AccountLayout.decode(accountInfo.data);
				return { symbol, address: mint, amount: decoded.amount, decimals, error: null };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error(`[SOLANA] SPL decode failed for ${mint}: ${message}`);
				return { symbol, address: mint, amount: null, decimals, error: `decode failed: ${message}` };
			}
		});
	}

	private buildNative(meta: SvmChainMeta, nativeResult: NativeLamportsResult): TokenBalance {
		if (nativeResult.status === "rejected") {
			const message = nativeResult.reason instanceof Error ? nativeResult.reason.message : String(nativeResult.reason);
			log.error(`[SOLANA] native fetch failed: ${message}`);
			return {
				symbol: meta.nativeSymbol,
				address: NATIVE_ADDRESS_SENTINEL,
				amount: null,
				decimals: meta.nativeDecimals,
				error: message
			};
		}
		return {
			symbol: meta.nativeSymbol,
			address: NATIVE_ADDRESS_SENTINEL,
			amount: BigInt(nativeResult.value),
			decimals: meta.nativeDecimals,
			error: null
		};
	}

	private computeChainTotals(tokens: TokenBalance[], native: TokenBalance): ChainSnapshot["chainTotals"] {
		const tokensTotals: Partial<Record<TokenSymbol, bigint>> = {};
		for (const tokenBalance of tokens) {
			if (tokenBalance.amount === null) continue;
			tokensTotals[tokenBalance.symbol] = (tokensTotals[tokenBalance.symbol] ?? 0n) + tokenBalance.amount;
		}
		return { tokens: tokensTotals, native: native.amount === null ? null : native };
	}
}

export { SvmBalanceService };
