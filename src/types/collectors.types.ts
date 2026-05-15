import { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import { Trade } from "ccxt";
import { ethers } from "ethers";
import { CexMarket } from "../config";
import { Network, TokenSymbol } from "./config.types";
import { FailedTx } from "./failed-tx.types";
import { RawArbitrageEvent, ScanFailure } from "./profit-calculator.types";

// Raw RPC data — no domain shapes (ParsedTransaction / SpendRecord), no vault
// attribution, no FailedTx classification. Calculators consume these and build
// their domain records.

interface EvmReceiptInfo {
	transactionHash: string;
	blockNumber: number;
	gasUsed: bigint;
	effectiveGasPrice: bigint;
	from: string;
}

interface EvmBlockInfo {
	timestamp: number;
	// ETH/BSC only: full tx objects so native-spend can read `tx.value` for the
	// builder bribe. null on chains that pay gas only.
	txs: ethers.TransactionResponse[] | null;
}

// Per-token EVM arb scan, sliced per network. Each slice carries raw event args
// + receipts + blocks for the token's vault. vaultAddress is exposed so calculators
// can use it for downstream attribution (e.g. matching failed txs).
interface EvmArbCollectedNetwork {
	network: Network;
	vaultAddress: string;
	events: RawArbitrageEvent[];
	receipts: Map<string, EvmReceiptInfo>;
	blocks: Map<number, EvmBlockInfo>;
}

interface EvmArbCollected {
	token: TokenSymbol;
	perNetwork: EvmArbCollectedNetwork[];
	failures: ScanFailure[];
}

interface SvmParsedTx {
	sigInfo: ConfirmedSignatureInfo;
	tx: ParsedTransactionWithMeta;
}

// Window-wide SVM scan, split by intent. Both buckets share the same underlying
// signature pagination + parsed-tx fetch — only the post-filter differs:
//   - arbTxs: wallet-signer + invokes executor program
//   - rebalanceTxs: wallet-signer + does NOT invoke executor program
// Calculators filter further per-token / bridge / status.
interface SvmTxCollected {
	arbTxs: SvmParsedTx[];
	rebalanceTxs: SvmParsedTx[];
	failures: ScanFailure[];
}

interface CexMarketTrades {
	market: CexMarket;
	trades: Trade[];
}

// Per-token CEX scan. Profit-only — no native spend on a CEX.
interface CexArbCollected {
	token: TokenSymbol;
	perMarket: CexMarketTrades[];
	failures: ScanFailure[];
}

// Failed-tx fetch result per (network, wallet, window). Orchestrator runs this
// once per (network, wallet) and feeds the result into both arb and rebalance
// flows of native-spend.
interface FailedTxCollectedNetwork {
	network: Network;
	txs: FailedTx[];
	failure: ScanFailure | null;
}

interface EvmRebalanceReceiptInfo extends EvmReceiptInfo {
	logs: ReadonlyArray<ethers.Log>;
}

// Chain-level EVM rebalance scan, per network. Raw Transfer-from-vault hits
// + receipts (with logs for token attribution) + blocks (with txs for bribe).
interface EvmRebalanceCollectedNetwork {
	network: Network;
	vaultAddresses: string[];
	txHashes: string[];
	receipts: Map<string, EvmRebalanceReceiptInfo>;
	blocks: Map<number, EvmBlockInfo>;
}

// Whole-window EVM rebalance data; orchestrator collects once per run. SVM
// rebalance txs come from SvmTxCollector — both arb and rebalance share the
// same SVM wallet, so we collect once and split by program-invoked filter.
interface RebalanceCollected {
	evm: EvmRebalanceCollectedNetwork[];
	failures: ScanFailure[];
}

export {
	EvmReceiptInfo,
	EvmBlockInfo,
	EvmArbCollectedNetwork,
	EvmArbCollected,
	SvmParsedTx,
	SvmTxCollected,
	CexMarketTrades,
	CexArbCollected,
	FailedTxCollectedNetwork,
	EvmRebalanceReceiptInfo,
	EvmRebalanceCollectedNetwork,
	RebalanceCollected
};
