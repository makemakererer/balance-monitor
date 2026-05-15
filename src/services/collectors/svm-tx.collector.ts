import { ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";
import {
	enabledNetworks,
	loadMonitoredSvmWallet,
	rpcScanLimits,
	svmExecutorProgramId,
	svmScanPrivateRpcUrl,
	svmScanPublicRpcUrl
} from "../../config";
import { Network, ProfitWindow, ScanFailure, SvmParsedTx, SvmTxCollected } from "../../types";
import { errorMessage, log } from "../../utils";
import { collectSvmSignaturesInWindow, parseSvmTransactionsInBatches } from "./svm-rpc-batch";

// Pure I/O collector for the SVM wallet. Arb and rebalance share the same wallet,
// so the expensive signature pagination + parsed-tx fetch happens once; the
// result is split into arbTxs / rebalanceTxs by the executor-program filter.
// Calculators apply per-token / bridge / status filters downstream.
class SvmTxCollector {
	public async collect(window: ProfitWindow): Promise<SvmTxCollected> {
		if (!enabledNetworks[Network.SOLANA]) {
			log.info(`[svm-collector][SOLANA] disabled in enabledNetworks, skipping`);
			return { arbTxs: [], rebalanceTxs: [], failures: [] };
		}

		const walletAddress = loadMonitoredSvmWallet();
		const wallet = new PublicKey(walletAddress);
		const publicConnection = new Connection(svmScanPublicRpcUrl, {
			commitment: "confirmed",
			disableRetryOnRateLimit: true
		});
		const privateConnection = new Connection(svmScanPrivateRpcUrl, "confirmed");

		log.info(`[svm-collector] step 1: collecting signatures within window`);
		let signatures;
		try {
			signatures = await collectSvmSignaturesInWindow(publicConnection, wallet, window);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`[svm-collector] signature scan failed: ${message}`);
			return {
				arbTxs: [],
				rebalanceTxs: [],
				failures: [{ network: Network.SOLANA, detail: `signature scan threw: ${message}` }]
			};
		}
		log.success(`[svm-collector] signatures in window: ${signatures.length}`);
		if (signatures.length === 0) return { arbTxs: [], rebalanceTxs: [], failures: [] };

		log.info(
			`[svm-collector] step 2: fetching parsed transactions in batches of ${rpcScanLimits.svmTransactionsBatchSize}`
		);
		// Mapper-side filter: keep wallet-signer txs with a blockTime (errored sigs
		// stay — native-spend needs them; profit drops errored on its own side).
		const scan = await parseSvmTransactionsInBatches<SvmParsedTx>({
			connection: privateConnection,
			signatures,
			mapper: (sigInfo, tx) => {
				if (!tx.meta) return null;
				if (!this.isWalletSigner(tx, walletAddress)) return null;
				if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) return null;
				return { sigInfo, tx };
			}
		});
		const failures: ScanFailure[] = scan.failure ? [scan.failure] : [];

		const arbTxs: SvmParsedTx[] = [];
		const rebalanceTxs: SvmParsedTx[] = [];
		for (const entry of scan.items) {
			if (this.invokesExecutor(entry.tx)) arbTxs.push(entry);
			else rebalanceTxs.push(entry);
		}

		if (scan.failure) {
			log.error(
				`[svm-collector] scan INCOMPLETE: arb=${arbTxs.length}, rebalance=${rebalanceTxs.length} — chain data partial`
			);
		} else {
			log.success(`[svm-collector] arb txs: ${arbTxs.length}, rebalance txs: ${rebalanceTxs.length}`);
		}
		return { arbTxs, rebalanceTxs, failures };
	}

	private isWalletSigner(tx: ParsedTransactionWithMeta, walletAddress: string): boolean {
		const signers = tx.transaction.message.accountKeys.filter((key) => key.signer).map((key) => key.pubkey.toBase58());
		return signers.includes(walletAddress);
	}

	private invokesExecutor(tx: ParsedTransactionWithMeta): boolean {
		for (const instruction of tx.transaction.message.instructions) {
			if (instruction.programId.toBase58() === svmExecutorProgramId) return true;
		}
		for (const inner of tx.meta?.innerInstructions ?? []) {
			for (const instruction of inner.instructions) {
				if (instruction.programId.toBase58() === svmExecutorProgramId) return true;
			}
		}
		return false;
	}
}

export { SvmTxCollector };
