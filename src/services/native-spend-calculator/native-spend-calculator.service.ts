import {
	ParsedInstruction,
	ParsedTransactionWithMeta,
	PartiallyDecodedInstruction
} from "@solana/web3.js";
import { ethers } from "ethers";
import {
	cctpSvmTokenMessengerProgramId,
	loadMonitoredSvmWallet,
	svmOftProgramId,
	tokenConfig,
	vaultExecutorAddresses
} from "../../config";
import {
	BridgeKind,
	EvmArbCollected,
	EvmArbCollectedNetwork,
	EvmRebalanceCollectedNetwork,
	FailedTx,
	FailedTxCollectedNetwork,
	NativeSpendScanFailure,
	NativeSpendWindow,
	Network,
	RebalanceCollected,
	RebalanceSpendEntry,
	ScanFailure,
	SpendIntent,
	SpendRecord,
	SpendStatus,
	SvmParsedTx,
	SvmTxCollected,
	TokenArbSpendEntry,
	TokenSymbol,
	UnattributedSpendEntry,
	UnattributedSpendRecord
} from "../../types";
import { SvmMintInfo, buildSvmMintLookup, log } from "../../utils";
import { PriceResolverService } from "./price-resolver.service";
import { StatsCalculatorService } from "./stats-calculator.service";

const TRANSFER_TOPIC0: string = ethers.id("Transfer(address,address,uint256)");

// Vault function signatures verified against v3Pools-Arb typechain (Vault.ts:1086-1117).
// Selectors derived at runtime so we never hardcode a 4-byte hex.
const VAULT_REBALANCE_FRAGMENTS: ReadonlyArray<string> = [
	"function rebalanceCCTPV2(uint256,address,uint256,(uint32,bytes32,bytes32,uint256,uint32))",
	"function rebalanceLZV2(uint256,address,uint256,(address,(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address))",
	"function rebalanceBungee(uint256,address,uint256,(address,address,bytes))"
];

const FUNCTION_TO_BRIDGE: Record<string, BridgeKind> = {
	rebalanceCCTPV2: BridgeKind.CCTP,
	rebalanceLZV2: BridgeKind.OFT,
	rebalanceBungee: BridgeKind.BUNGEE
};

function buildBridgeBySelector(): Map<string, BridgeKind> {
	const iface = new ethers.Interface(VAULT_REBALANCE_FRAGMENTS);
	const map = new Map<string, BridgeKind>();
	for (const [name, bridge] of Object.entries(FUNCTION_TO_BRIDGE)) {
		const fragment = iface.getFunction(name);
		if (!fragment) throw new Error(`[native-spend] vault fragment "${name}" not resolvable`);
		map.set(fragment.selector.toLowerCase(), bridge);
	}
	return map;
}

// Pure compute service. Takes raw collector data + raw FailedTx[] and produces
// priced, attributed SpendRecord lists. All I/O lives in collectors; only
// PriceResolverService (RPC pool reads) is owned here and runs after records
// are built.
class NativeSpendCalculatorService {
	private readonly bridgeBySelector: Map<string, BridgeKind> = buildBridgeBySelector();
	private readonly priceResolver = new PriceResolverService();
	public readonly stats = new StatsCalculatorService();

	// Per-token arb: SUCCESS records from on-chain receipts/blocks + REVERTED
	// records from failed-tx-to-this-token's-vault, EVM and SVM combined.
	public async calculateArbForToken(args: {
		token: TokenSymbol;
		window: NativeSpendWindow;
		evmData: EvmArbCollected;
		svm: SvmTxCollected;
		arbFailedTxByNetwork: Map<Network, FailedTxCollectedNetwork>;
	}): Promise<TokenArbSpendEntry> {
		const { token, window, evmData, svm, arbFailedTxByNetwork } = args;
		const startedAt = Date.now();

		const successEvm = this.buildEvmArbSuccessRecords(token, evmData, window);
		const revertedEvm = this.buildEvmArbRevertedRecords(token, evmData, arbFailedTxByNetwork);
		const svmRecords = this.buildSvmArbRecords(token, svm.arbTxs);

		const records = [...successEvm, ...revertedEvm, ...svmRecords];

		const scanFailures: NativeSpendScanFailure[] = [
			...evmData.failures.map((failure) => this.toIntentFailure(failure, SpendIntent.ARBITRAGE)),
			...svm.failures.map((failure) => this.toIntentFailure(failure, SpendIntent.ARBITRAGE)),
			...this.collectFailedTxFailures(arbFailedTxByNetwork, SpendIntent.ARBITRAGE, evmData)
		];

		const pricingFailures = await this.priceResolver.priceAll(window, records);
		scanFailures.push(...pricingFailures);

		records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

		return {
			token,
			fetchedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAt,
			records,
			scanFailures
		};
	}

	// Chain-level rebalance: SUCCESS + REVERTED + UNATTRIBUTED. Single call per run.
	public async scanRebalance(args: {
		window: NativeSpendWindow;
		rebalanceData: RebalanceCollected;
		svm: SvmTxCollected;
		rebalancerFailedTxByNetwork: Map<Network, FailedTxCollectedNetwork>;
	}): Promise<{ entry: RebalanceSpendEntry; unattributedRecords: UnattributedSpendRecord[] }> {
		const { window, rebalanceData, svm, rebalancerFailedTxByNetwork } = args;
		const startedAt = Date.now();

		const successEvm = this.buildEvmRebalanceSuccessRecords(rebalanceData, window);
		const revertedAndUnattributedEvm = this.buildEvmRebalanceRevertedAndUnattributed(rebalancerFailedTxByNetwork);
		const svmRebalance = this.buildSvmRebalanceRecords(svm.rebalanceTxs);

		const records = [...successEvm, ...revertedAndUnattributedEvm.records, ...svmRebalance.records];
		const unattributedRecords = [...revertedAndUnattributedEvm.unattributedRecords, ...svmRebalance.unattributedRecords];

		const scanFailures: NativeSpendScanFailure[] = [
			...rebalanceData.failures.map((failure) => this.toIntentFailure(failure, SpendIntent.REBALANCE)),
			...svm.failures.map((failure) => this.toIntentFailure(failure, SpendIntent.REBALANCE)),
			...this.collectFailedTxFailures(rebalancerFailedTxByNetwork, SpendIntent.REBALANCE)
		];

		const pricingFailures = await this.priceResolver.priceAll(window, records);
		scanFailures.push(...pricingFailures);

		records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

		return {
			entry: {
				fetchedAt: new Date().toISOString(),
				durationMs: Date.now() - startedAt,
				records,
				scanFailures
			},
			unattributedRecords
		};
	}

	// Chain-level unattributed: reverts from the ARB wallet whose `to` is NOT any
	// of our vaults. Run once per run (not per token). Prices the records on
	// behalf of the orchestrator.
	public async computeArbWalletUnattributed(args: {
		window: NativeSpendWindow;
		arbFailedTxByNetwork: Map<Network, FailedTxCollectedNetwork>;
	}): Promise<UnattributedSpendEntry> {
		const { window, arbFailedTxByNetwork } = args;
		const startedAt = Date.now();
		const records: UnattributedSpendRecord[] = [];
		const scanFailures: NativeSpendScanFailure[] = this.collectFailedTxFailures(
			arbFailedTxByNetwork,
			SpendIntent.ARBITRAGE
		);

		for (const [network, entry] of arbFailedTxByNetwork) {
			const allVaultsLower = this.buildAllVaultsLower(network);
			for (const tx of entry.txs) {
				if (!tx.isError) continue;
				const toLower = tx.to ? tx.to.toLowerCase() : null;
				if (toLower !== null && allVaultsLower.has(toLower)) continue;
				records.push(this.buildUnattributedFromEvmFailedTx(tx, network));
			}
		}

		const pricingFailures = await this.priceResolver.priceAll(window, records);
		scanFailures.push(...pricingFailures);
		records.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

		return {
			fetchedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAt,
			records,
			scanFailures
		};
	}

	// Re-price accumulated unattributed records (mutates `records[*].usdAmount` in place).
	// Used by the orchestrator after both rebalance + per-token arb scans complete, since
	// the priceResolver may now have anchor data it lacked during the original scan.
	public async priceUnattributedRecords(
		window: NativeSpendWindow,
		records: UnattributedSpendRecord[]
	): Promise<NativeSpendScanFailure[]> {
		const unpriced = records.filter((record) => record.usdAmount === null);
		if (unpriced.length === 0) return [];
		return this.priceResolver.priceAll(window, unpriced);
	}

	// -------- EVM ARB BUILDERS --------

	private buildEvmArbSuccessRecords(
		token: TokenSymbol,
		evmData: EvmArbCollected,
		window: NativeSpendWindow
	): SpendRecord[] {
		const out: SpendRecord[] = [];
		for (const networkData of evmData.perNetwork) {
			out.push(...this.buildEvmArbSuccessForNetwork(token, networkData, window));
		}
		return out;
	}

	private buildEvmArbSuccessForNetwork(
		token: TokenSymbol,
		networkData: EvmArbCollectedNetwork,
		window: NativeSpendWindow
	): SpendRecord[] {
		const out: SpendRecord[] = [];
		for (const receipt of networkData.receipts.values()) {
			const block = networkData.blocks.get(receipt.blockNumber);
			if (!block) continue;
			if (block.timestamp < window.fromTimestampSeconds || block.timestamp > window.toTimestampSeconds) continue;

			const arbTx = block.txs?.find((tx) => tx.hash === receipt.transactionHash);
			const gas = receipt.gasUsed * receipt.effectiveGasPrice;
			// ETH and BSC pay the builder bribe via tx.value on the arb tx itself
			// (vault forwards it to the bundler internally). Other EVM chains pay gas only.
			const bribe = arbTx && arbTx.value > 0n ? arbTx.value : 0n;
			const total = gas + bribe;
			out.push({
				network: networkData.network,
				intent: SpendIntent.ARBITRAGE,
				status: SpendStatus.SUCCESS,
				token,
				txHash: receipt.transactionHash,
				blockNumber: receipt.blockNumber,
				timestampSeconds: block.timestamp,
				timestampIso: new Date(block.timestamp * 1000).toISOString(),
				payer: receipt.from,
				nativeAmount: total.toString(),
				usdAmount: null,
				breakdown: {
					gas: gas.toString(),
					...(bribe > 0n ? { bribe: bribe.toString() } : {})
				},
				detail: bribe > 0n ? "arb tx (gas + builder bribe)" : "arb tx gas"
			});
		}
		return out;
	}

	private buildEvmArbRevertedRecords(
		token: TokenSymbol,
		evmData: EvmArbCollected,
		arbFailedTxByNetwork: Map<Network, FailedTxCollectedNetwork>
	): SpendRecord[] {
		const out: SpendRecord[] = [];
		for (const networkData of evmData.perNetwork) {
			const vaultLower = networkData.vaultAddress.toLowerCase();
			const entry = arbFailedTxByNetwork.get(networkData.network);
			const failedTxs = entry?.txs ?? [];
			for (const tx of failedTxs) {
				if (!tx.isError) continue;
				if (!tx.to || tx.to.toLowerCase() !== vaultLower) continue;
				const gas = tx.gasUsed * tx.gasPrice;
				out.push({
					network: networkData.network,
					intent: SpendIntent.ARBITRAGE,
					status: SpendStatus.REVERTED,
					token,
					txHash: tx.hash,
					blockNumber: tx.blockNumber,
					timestampSeconds: tx.timeStamp,
					timestampIso: new Date(tx.timeStamp * 1000).toISOString(),
					payer: ethers.getAddress(tx.from),
					nativeAmount: gas.toString(),
					usdAmount: null,
					breakdown: { gas: gas.toString() },
					detail: "arb tx reverted"
				});
			}
		}
		return out;
	}

	// -------- SVM ARB BUILDERS --------

	private buildSvmArbRecords(token: TokenSymbol, arbTxs: SvmParsedTx[]): SpendRecord[] {
		const walletAddress = loadMonitoredSvmWallet();
		const mintLookup = buildSvmMintLookup();
		const out: SpendRecord[] = [];
		for (const { sigInfo, tx } of arbTxs) {
			if (!tx.meta) continue;
			if (!this.svmInvolvesTargetToken(tx, walletAddress, token, mintLookup)) continue;
			if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) continue;

			const status = tx.meta.err === null ? SpendStatus.SUCCESS : SpendStatus.REVERTED;
			const fee = BigInt(tx.meta.fee ?? 0);
			// SystemProgram.Transfer instructions roll back on revert — only the
			// base+priority fee is actually charged for a failed tx.
			const tips = status === SpendStatus.SUCCESS ? this.svmSumSystemTransfersFromWallet(tx, walletAddress) : 0n;
			const total = fee + tips;
			if (total === 0n) continue;

			const detailParts: string[] = [];
			if (fee > 0n) detailParts.push("base+priority fee");
			if (tips > 0n) detailParts.push("validator tips");
			const label = status === SpendStatus.SUCCESS ? "Solana arb tx" : "Solana arb tx reverted";
			out.push({
				network: Network.SOLANA,
				intent: SpendIntent.ARBITRAGE,
				status,
				token,
				txHash: sigInfo.signature,
				blockNumber: sigInfo.slot,
				timestampSeconds: sigInfo.blockTime,
				timestampIso: new Date(sigInfo.blockTime * 1000).toISOString(),
				payer: walletAddress,
				nativeAmount: total.toString(),
				usdAmount: null,
				breakdown: {
					gas: fee.toString(),
					...(tips > 0n ? { tips: tips.toString() } : {})
				},
				detail: `${label} (${detailParts.join(" + ")})`
			});
		}
		return out;
	}

	// -------- EVM REBALANCE BUILDERS --------

	private buildEvmRebalanceSuccessRecords(rebalanceData: RebalanceCollected, window: NativeSpendWindow): SpendRecord[] {
		const out: SpendRecord[] = [];
		for (const networkData of rebalanceData.evm) {
			out.push(...this.buildEvmRebalanceSuccessForNetwork(networkData, window));
		}
		return out;
	}

	private buildEvmRebalanceSuccessForNetwork(
		networkData: EvmRebalanceCollectedNetwork,
		window: NativeSpendWindow
	): SpendRecord[] {
		const vaultSet = new Set(networkData.vaultAddresses);
		const out: SpendRecord[] = [];
		for (const receipt of networkData.receipts.values()) {
			const block = networkData.blocks.get(receipt.blockNumber);
			if (!block) continue;
			if (block.timestamp < window.fromTimestampSeconds || block.timestamp > window.toTimestampSeconds) continue;

			const tx = block.txs?.find((entry) => entry.hash === receipt.transactionHash);
			if (!tx || !tx.data || tx.data.length < 10) continue;

			const selector = tx.data.slice(0, 10).toLowerCase();
			const bridge = this.bridgeBySelector.get(selector);
			if (!bridge) continue;

			const tokenSymbol = this.attributeTokenFromLogs(receipt.logs, vaultSet);
			if (!tokenSymbol) {
				log.warning(
					`[${networkData.network}] rebalance tx ${receipt.transactionHash}: no Transfer-from-vault log matched tokenConfig; dropping record`
				);
				continue;
			}

			const gas = receipt.gasUsed * receipt.effectiveGasPrice;
			const bribe = tx.value > 0n ? tx.value : 0n;
			out.push({
				network: networkData.network,
				intent: SpendIntent.REBALANCE,
				status: SpendStatus.SUCCESS,
				token: tokenSymbol,
				txHash: receipt.transactionHash,
				blockNumber: receipt.blockNumber,
				timestampSeconds: block.timestamp,
				timestampIso: new Date(block.timestamp * 1000).toISOString(),
				payer: receipt.from,
				nativeAmount: (gas + bribe).toString(),
				usdAmount: null,
				breakdown: {
					gas: gas.toString(),
					...(bribe > 0n ? { bribe: bribe.toString() } : {})
				},
				bridge,
				detail: `${bridge} rebalance — ${tokenSymbol}`
			});
		}
		return out;
	}

	private buildEvmRebalanceRevertedAndUnattributed(
		rebalancerFailedTxByNetwork: Map<Network, FailedTxCollectedNetwork>
	): { records: SpendRecord[]; unattributedRecords: UnattributedSpendRecord[] } {
		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];
		for (const [network, entry] of rebalancerFailedTxByNetwork) {
			const vaultToToken = this.buildVaultToTokenMap(network);
			for (const tx of entry.txs) {
				if (!tx.isError) continue;
				const toAddress = tx.to ? ethers.getAddress(tx.to) : null;
				const selector = tx.input && tx.input.length >= 10 ? tx.input.slice(0, 10).toLowerCase() : null;
				const bridge = selector ? this.bridgeBySelector.get(selector) : undefined;
				const token = toAddress ? vaultToToken.get(toAddress) : undefined;
				const gas = tx.gasUsed * tx.gasPrice;
				if (toAddress && bridge && token) {
					records.push({
						network,
						intent: SpendIntent.REBALANCE,
						status: SpendStatus.REVERTED,
						token,
						txHash: tx.hash,
						blockNumber: tx.blockNumber,
						timestampSeconds: tx.timeStamp,
						timestampIso: new Date(tx.timeStamp * 1000).toISOString(),
						payer: ethers.getAddress(tx.from),
						nativeAmount: gas.toString(),
						usdAmount: null,
						breakdown: { gas: gas.toString() },
						bridge,
						detail: `${bridge} rebalance reverted — ${token}`
					});
				} else {
					unattributedRecords.push(this.buildUnattributedFromEvmFailedTx(tx, network));
				}
			}
		}
		return { records, unattributedRecords };
	}

	// -------- SVM REBALANCE BUILDERS --------

	private buildSvmRebalanceRecords(
		rebalanceTxs: SvmParsedTx[]
	): { records: SpendRecord[]; unattributedRecords: UnattributedSpendRecord[] } {
		const walletAddress = loadMonitoredSvmWallet();
		const mintLookup = buildSvmMintLookup();
		const records: SpendRecord[] = [];
		const unattributedRecords: UnattributedSpendRecord[] = [];

		for (const { sigInfo, tx } of rebalanceTxs) {
			if (!tx.meta) continue;
			if (sigInfo.blockTime === null || sigInfo.blockTime === undefined) continue;

			const bridge = this.svmDetectBridge(tx);
			if (!bridge) {
				// Failed sig that touches none of our known programs (CCTP / OFT) =
				// unattributed spend on the SVM wallet (approval, claim, etc).
				if (tx.meta.err !== null) {
					const fee = BigInt(tx.meta.fee ?? 0);
					if (fee > 0n) {
						unattributedRecords.push({
							network: Network.SOLANA,
							txHash: sigInfo.signature,
							blockNumber: sigInfo.slot,
							timestampSeconds: sigInfo.blockTime,
							timestampIso: new Date(sigInfo.blockTime * 1000).toISOString(),
							payer: walletAddress,
							nativeAmount: fee.toString(),
							usdAmount: null,
							detail: "Solana tx reverted (no known program)"
						});
					}
				}
				continue;
			}

			const tokenSymbol = this.svmAttributeBridgedToken(tx, walletAddress, mintLookup);
			if (!tokenSymbol) {
				log.warning(`[SOLANA] rebalance tx ${sigInfo.signature}: no token balance change for our wallet — dropping record`);
				continue;
			}

			const status = tx.meta.err === null ? SpendStatus.SUCCESS : SpendStatus.REVERTED;
			let nativeAmount: bigint;
			if (status === SpendStatus.SUCCESS) {
				const walletIndex = tx.transaction.message.accountKeys.findIndex(
					(key) => key.pubkey.toBase58() === walletAddress
				);
				if (walletIndex === -1) continue;
				const preLamports = BigInt(tx.meta.preBalances[walletIndex] ?? 0);
				const postLamports = BigInt(tx.meta.postBalances[walletIndex] ?? 0);
				nativeAmount = preLamports - postLamports;
				// CCTP burns fund the event_account PDA rent that we reclaim later;
				// subtract so daily spend isn't inflated. CCTP mints have a different
				// layout — helper returns 0n there.
				if (bridge === BridgeKind.CCTP) {
					nativeAmount -= this.svmFindReclaimableEventAccountRent(tx);
				}
			} else {
				// Reverted tx: state rolled back, only base+priority fee is actually charged.
				nativeAmount = BigInt(tx.meta.fee ?? 0);
			}
			if (nativeAmount <= 0n) continue;

			const label = status === SpendStatus.SUCCESS ? `${bridge} rebalance` : `${bridge} rebalance reverted`;
			records.push({
				network: Network.SOLANA,
				intent: SpendIntent.REBALANCE,
				status,
				token: tokenSymbol,
				txHash: sigInfo.signature,
				blockNumber: sigInfo.slot,
				timestampSeconds: sigInfo.blockTime,
				timestampIso: new Date(sigInfo.blockTime * 1000).toISOString(),
				payer: walletAddress,
				nativeAmount: nativeAmount.toString(),
				usdAmount: null,
				breakdown: { gas: nativeAmount.toString() },
				bridge,
				detail: `${label} — ${tokenSymbol}`
			});
		}
		return { records, unattributedRecords };
	}

	// -------- SHARED HELPERS --------

	private toIntentFailure(failure: ScanFailure, intent: SpendIntent): NativeSpendScanFailure {
		return { network: failure.network, intent, detail: failure.detail };
	}

	private collectFailedTxFailures(
		failedTxByNetwork: Map<Network, FailedTxCollectedNetwork>,
		intent: SpendIntent,
		filter?: EvmArbCollected
	): NativeSpendScanFailure[] {
		// When `filter` is provided (per-token arb path), only surface failed-tx
		// failures for networks that are in scope for the token. Otherwise emit
		// failures for every network the orchestrator fetched (rebalance + arb-
		// wallet-unattributed scopes both span all configured EVM chains).
		const scopeNetworks = filter ? new Set(filter.perNetwork.map((n) => n.network)) : null;
		const out: NativeSpendScanFailure[] = [];
		for (const [network, entry] of failedTxByNetwork) {
			if (!entry.failure) continue;
			if (scopeNetworks && !scopeNetworks.has(network)) continue;
			out.push({ network, intent, detail: entry.failure.detail });
		}
		return out;
	}

	private buildVaultToTokenMap(network: Network): Map<string, TokenSymbol> {
		const map = new Map<string, TokenSymbol>();
		const vaults = vaultExecutorAddresses[network] ?? {};
		for (const [tokenKey, address] of Object.entries(vaults)) {
			if (!address) continue;
			map.set(ethers.getAddress(address), tokenKey as TokenSymbol);
		}
		return map;
	}

	private buildAllVaultsLower(network: Network): Set<string> {
		const vaults = vaultExecutorAddresses[network] ?? {};
		const set = new Set<string>();
		for (const address of Object.values(vaults)) {
			if (address) set.add(address.toLowerCase());
		}
		return set;
	}

	private attributeTokenFromLogs(
		logs: ReadonlyArray<ethers.Log>,
		vaultSet: Set<string>
	): TokenSymbol | null {
		for (const entry of logs) {
			if (entry.topics.length < 3) continue;
			if (entry.topics[0].toLowerCase() !== TRANSFER_TOPIC0) continue;
			const fromTopic = entry.topics[1];
			const fromAddress = ethers.getAddress("0x" + fromTopic.slice(26));
			if (!vaultSet.has(fromAddress)) continue;
			const tokenAddress = ethers.getAddress(entry.address);
			const meta = tokenConfig[tokenAddress];
			if (meta) return meta.symbol;
		}
		return null;
	}

	private buildUnattributedFromEvmFailedTx(tx: FailedTx, network: Network): UnattributedSpendRecord {
		const gas = tx.gasUsed * tx.gasPrice;
		return {
			network,
			txHash: tx.hash,
			blockNumber: tx.blockNumber,
			timestampSeconds: tx.timeStamp,
			timestampIso: new Date(tx.timeStamp * 1000).toISOString(),
			payer: ethers.getAddress(tx.from),
			nativeAmount: gas.toString(),
			usdAmount: null,
			detail: `reverted tx to ${tx.to || "<contract creation>"}`
		};
	}

	private svmInvolvesTargetToken(
		tx: ParsedTransactionWithMeta,
		walletAddress: string,
		targetToken: TokenSymbol,
		mintLookup: Map<string, SvmMintInfo>
	): boolean {
		const pre = tx.meta?.preTokenBalances ?? [];
		const post = tx.meta?.postTokenBalances ?? [];
		for (const entry of [...pre, ...post]) {
			if (entry.owner !== walletAddress) continue;
			const info = mintLookup.get(entry.mint);
			if (info?.symbol === targetToken) return true;
		}
		return false;
	}

	private svmAttributeBridgedToken(
		tx: ParsedTransactionWithMeta,
		walletAddress: string,
		mintLookup: Map<string, SvmMintInfo>
	): TokenSymbol | null {
		const pre = tx.meta?.preTokenBalances ?? [];
		const post = tx.meta?.postTokenBalances ?? [];
		for (const postEntry of post) {
			if (postEntry.owner !== walletAddress) continue;
			const info = mintLookup.get(postEntry.mint);
			if (!info) continue;
			const preEntry = pre.find((entry) => entry.mint === postEntry.mint && entry.owner === postEntry.owner);
			const preAmount = preEntry ? BigInt(preEntry.uiTokenAmount.amount) : 0n;
			const postAmount = BigInt(postEntry.uiTokenAmount.amount);
			if (postAmount !== preAmount) return info.symbol;
		}
		return null;
	}

	private svmDetectBridge(tx: ParsedTransactionWithMeta): BridgeKind | null {
		if (this.svmInvokesProgram(tx, cctpSvmTokenMessengerProgramId)) return BridgeKind.CCTP;
		if (this.svmInvokesProgram(tx, svmOftProgramId)) return BridgeKind.OFT;
		return null;
	}

	private svmInvokesProgram(tx: ParsedTransactionWithMeta, programId: string): boolean {
		for (const instruction of tx.transaction.message.instructions) {
			if (instruction.programId.toBase58() === programId) return true;
		}
		for (const inner of tx.meta?.innerInstructions ?? []) {
			for (const instruction of inner.instructions) {
				if (instruction.programId.toBase58() === programId) return true;
			}
		}
		return false;
	}

	private svmSumSystemTransfersFromWallet(tx: ParsedTransactionWithMeta, walletAddress: string): bigint {
		const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
		let total = 0n;
		const accumulate = (instructions: ReadonlyArray<unknown>): void => {
			for (const raw of instructions) {
				const ix = raw as ParsedInstruction;
				if (!ix.programId) continue;
				if (ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) continue;
				if (!ix.parsed || ix.parsed.type !== "transfer") continue;
				const info = ix.parsed.info as { source?: string; lamports?: number | string } | undefined;
				if (!info || info.source !== walletAddress || info.lamports === undefined) continue;
				total += BigInt(info.lamports);
			}
		};
		accumulate(tx.transaction.message.instructions);
		for (const inner of tx.meta?.innerInstructions ?? []) {
			accumulate(inner.instructions);
		}
		return total;
	}

	// CCTP burn (DepositForBurn) funds the MessageSent PDA at accounts[11] of the
	// TokenMessenger instruction. That rent is refunded when the reclaim service
	// closes the account ~5 days later, so it isn't a real spend. CCTP receive
	// has a different account layout (no freshly-created PDA at index 11), so
	// `preBalances[idx] !== 0n` filters those out and we return 0n.
	private svmFindReclaimableEventAccountRent(tx: ParsedTransactionWithMeta): bigint {
		if (!tx.meta) return 0n;
		const allInstructions: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
			...tx.transaction.message.instructions,
			...(tx.meta.innerInstructions?.flatMap((inner) => inner.instructions) ?? [])
		];
		for (const instruction of allInstructions) {
			if (instruction.programId.toBase58() !== cctpSvmTokenMessengerProgramId) continue;
			if (!("accounts" in instruction) || instruction.accounts.length < 12) continue;
			const eventAccount = instruction.accounts[11];
			const accountIndex = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.equals(eventAccount));
			if (accountIndex === -1) continue;
			const preLamports = BigInt(tx.meta.preBalances[accountIndex] ?? 0);
			if (preLamports !== 0n) continue;
			return BigInt(tx.meta.postBalances[accountIndex] ?? 0);
		}
		return 0n;
	}
}

export { NativeSpendCalculatorService };
