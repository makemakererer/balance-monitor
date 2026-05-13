import { Network } from "../types";

// CCTP V2 official addresses — identical across all EVM domains.
const cctpEvmTokenMessengerAddress: string = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const cctpEvmMessageTransmitterAddress: string = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

// Solana program IDs (CCTP V2).
const cctpSvmTokenMessengerProgramId: string = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const cctpSvmMessageTransmitterProgramId: string = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

// Master LUT used to compile the CCTP mint v0 message on Solana (from v3Pools).
const cctpSvmMasterLookupTable: string = "HJCw1s4nrjnYPN6x4HPGjw9sWixJ1aspJcXZ6dugWXQP";

// Circle attestation API.
const cctpAttestationApiUrl: string = "https://iris-api.circle.com/v2/messages/";

// CCTP domain → Network (and inverse). Authoritative networks the remint service handles.
const cctpDomainIds: Partial<Record<Network, number>> = {
	[Network.ETH]: 0,
	[Network.SONIC]: 13,
	[Network.BASE]: 6,
	[Network.AVAX]: 1,
	[Network.ARB]: 3,
	[Network.SOLANA]: 5
};

const cctpNetworkByDomainId: Record<number, Network> = {
	0: Network.ETH,
	13: Network.SONIC,
	6: Network.BASE,
	1: Network.AVAX,
	3: Network.ARB,
	5: Network.SOLANA
};

// Tuning copied verbatim from v3Pools — calibrated against current RPC limits.
const cctpRateLimits = {
	// EVM phase 1: blocks per queryFilter call.
	evmChunkSize: 5000,
	evmChunkRetries: 30,
	evmChunkRetryDelayMs: 1000,
	// Total passes over the chunk list (1 = no retry pass; 2 = main + one re-fetch
	// of chunks that exhausted evmChunkRetries on the first sweep). Guarantees we
	// don't silently drop a block range if the RPC has a transient glitch.
	evmChunkMaxPasses: 2,

	// SVM phase 1 (signature scan): public RPC.
	svmSignaturesPerCall: 1000,
	svmSignatureCallDelayMs: 1000,
	svmRateLimitBackoffMs: 5000,
	svmGenericErrorBackoffMs: 2000,
	// Hard cap on consecutive errors before we give up on signature collection.
	// Without this the loop can spin forever if the public RPC dies mid-scan.
	// 30 × ~30s backoff = ~15 min of sustained failure tolerated before abort.
	svmSignatureMaxConsecutiveErrors: 30,

	// SVM phase 1 (parsed tx fetch): private RPC.
	svmTransactionsBatchSize: 15,
	svmTransactionsBatchRetries: 5,
	svmTransactionsBatchRetryDelayMs: 3000,
	svmTransactionsBatchInterDelayMs: 2000,
	// Same two-pass guarantee as EVM chunks: batches that exhaust per-batch retries
	// on pass 1 get a fresh re-fetch on pass 2 instead of silently being skipped.
	svmTransactionsBatchMaxPasses: 2,

	// Attestation API polling cadence.
	attestationInitialDelayMs: 5000,
	attestationPollIntervalMs: 5000,
	attestationInterTxDelayMs: 100,
	// Hard cap so one stuck tx can't hang the daily run forever.
	// 60 polls × 5s = ~5 min per attestation before we give up and continue.
	attestationMaxPollAttempts: 60,
	// Heartbeat: every N silent polls (no HTTP error, just status != complete) emit
	// an info line so a stuck tx is visible in logs without spamming every 5s.
	attestationHeartbeatEveryNPolls: 6,
	// Outer retry passes over the burn list: a tx whose 60-poll inner loop ran out
	// on pass 1 gets a fresh 60-poll attempt on pass 2 (~10 min total worst case
	// per stubborn tx) before being declared unmintable for this run.
	attestationMaxPasses: 2,

	// Solana mint compute budget.
	svmMintComputeUnitLimit: 400_000
} as const;

// Solana RPCs scoped to the remint service so it doesn't compete with the balance
// snapshot's main RPC. Public RPC is used for cheap getSignaturesForAddress calls;
// private RPC handles the heavy getParsedTransactions sweep — currently the same
// URL string as svmRpcUrl in network.config.ts; swap in a dedicated endpoint here
// when load on the main RPC becomes an issue.
const cctpSolanaPublicRpcUrl: string = "https://api.mainnet-beta.solana.com";
const cctpSolanaPrivateRpcUrl: string = "http://fra.corvus-labs.io:8899";

export {
	cctpEvmTokenMessengerAddress,
	cctpEvmMessageTransmitterAddress,
	cctpSvmTokenMessengerProgramId,
	cctpSvmMessageTransmitterProgramId,
	cctpSvmMasterLookupTable,
	cctpAttestationApiUrl,
	cctpDomainIds,
	cctpNetworkByDomainId,
	cctpRateLimits,
	cctpSolanaPublicRpcUrl,
	cctpSolanaPrivateRpcUrl
};
