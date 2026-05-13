import { Network } from "../types";

// CCTP V2 official addresses — identical across all EVM domains.
const cctpEvmTokenMessengerAddress: string = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const cctpEvmMessageTransmitterAddress: string = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

const cctpSvmTokenMessengerProgramId: string = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const cctpSvmMessageTransmitterProgramId: string = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

// LUT used to compile the CCTP mint v0 message on Solana.
const cctpSvmMasterLookupTable: string = "HJCw1s4nrjnYPN6x4HPGjw9sWixJ1aspJcXZ6dugWXQP";

const cctpAttestationApiUrl: string = "https://iris-api.circle.com/v2/messages/";

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

// CCTP-specific knobs (attestation polling + SVM-mint compute). Shared chunk/batch knobs
// and SVM scan RPC URLs live in `rpc-scan.config.ts`.
const cctpRateLimits = {
	attestationInitialDelayMs: 5000,
	attestationPollIntervalMs: 5000,
	attestationInterTxDelayMs: 100,
	// 60 polls × 5s ≈ 5 min hard cap per tx so one stuck attestation can't hang the daily run.
	attestationMaxPollAttempts: 60,
	// Heartbeat every N silent polls so a stuck tx is visible without spamming every 5s.
	attestationHeartbeatEveryNPolls: 6,
	attestationMaxPasses: 2,

	svmMintComputeUnitLimit: 400_000
} as const;

export {
	cctpEvmTokenMessengerAddress,
	cctpEvmMessageTransmitterAddress,
	cctpSvmTokenMessengerProgramId,
	cctpSvmMessageTransmitterProgramId,
	cctpSvmMasterLookupTable,
	cctpAttestationApiUrl,
	cctpDomainIds,
	cctpNetworkByDomainId,
	cctpRateLimits
};
