import { Network } from "./config.types";

interface ApiCctpMessageBody {
	burnToken: string;
	mintRecipient: string;
	amount: string;
	messageSender: string;
	maxFee: string;
	feeExecuted: string;
	expirationBlock: string;
	hookData: string | null;
}

interface ApiCctpDecodedMessage {
	sourceDomain: string;
	destinationDomain: string;
	nonce: string;
	sender: string;
	recipient: string;
	destinationCaller: string;
	minFinalityThreshold: string;
	finalityThresholdExecuted: string;
	messageBody: string;
	decodedMessageBody: ApiCctpMessageBody;
}

interface ApiCctpMessage {
	message: string;
	eventNonce: string;
	attestation: string;
	decodedMessage: ApiCctpDecodedMessage;
	cctpVersion: number;
	status: string;
	delayReason?: string;
}

interface ApiCctpResponse {
	messages: ApiCctpMessage[];
}

interface BurnTx {
	transactionHash: string;
	blockNumber: number;
	// Solana-only: PDA holding rent that the reclaim service will later close.
	eventAccount?: string;
	// Solana-only: chain timestamp of the burn (seconds since unix epoch), needed for reclaim age check.
	blockTime?: number;
}

interface AttestationEntry extends BurnTx {
	attestationData: ApiCctpMessage;
}

interface MintOutcome {
	destinationNetwork: Network;
	txHash: string;
	mintedAt: string;
}

// Persisted to data/reclaim-pending/YYYY-MM-DD.json so a future reclaim service
// can close event accounts ~5 days after the burn. Solana burns only — EVM burns
// have no on-chain event account to reclaim.
//
// Fields are nullable because the file is written even when phase 2 (attestation)
// or phase 3 (mint) didn't run for an entry — we still save the burn so the
// reclaim service can re-fetch attestation later and close the account.
interface ReclaimPendingEntry {
	network: Network;
	signature: string;
	slot: number;
	blockTime: number | null;
	eventAccount: string | null;
	sourceDomain: number | null;
	destinationDomain: number | null;
	attestation: {
		message: string;
		attestation: string;
	} | null;
	mint: MintOutcome | null;
	alreadyMinted: boolean;
}

interface ReclaimPendingFile {
	date: string;
	generatedAt: string;
	windowStart: string;
	windowEnd: string;
	burns: ReclaimPendingEntry[];
}

interface RemintWindow {
	fromTimestampSeconds: number;
	toTimestampSeconds: number;
	fromIso: string;
	toIso: string;
}

// Per-source-chain breakdown of successful mints (network = source chain of the burn).
// newMintedRaw = USDC actually minted in THIS run; already-minted entries are excluded.
interface RemintChainStats {
	network: Network;
	newMintedRaw: bigint;
}

// Failure attribution is route-based — the operator needs to know where the mint
// actually failed (destination), not just where the burn originated.
interface RemintFailedRoute {
	source: Network;
	destination: Network;
	count: number;
}

interface RemintReport {
	date: string;
	windowFromIso: string;
	windowToIso: string;
	durationMs: number;
	perChain: RemintChainStats[];
	failedRoutes: RemintFailedRoute[];
	totalMintedRaw: bigint;
	totalFailedCount: number;
}

export {
	ApiCctpMessage,
	ApiCctpMessageBody,
	ApiCctpDecodedMessage,
	ApiCctpResponse,
	BurnTx,
	AttestationEntry,
	MintOutcome,
	ReclaimPendingEntry,
	ReclaimPendingFile,
	RemintWindow,
	RemintChainStats,
	RemintFailedRoute,
	RemintReport
};
