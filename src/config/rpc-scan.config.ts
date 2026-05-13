// Shared scan resources for remint + profit-calc: chunk/batch knobs and SVM scan RPC URLs.
// Any batched scan using rpcScanLimits MUST apply the two-pass retry guarantee.

const svmScanPublicRpcUrl: string = "https://api.mainnet-beta.solana.com";
const svmScanPrivateRpcUrl: string = "http://fra.corvus-labs.io:8899";

const rpcScanLimits = {
	evmChunkSize: 5000,
	evmChunkRetries: 30,
	evmChunkRetryDelayMs: 1000,
	evmChunkMaxPasses: 2,

	svmSignaturesPerCall: 1000,
	svmSignatureCallDelayMs: 1000,
	svmRateLimitBackoffMs: 5000,
	svmGenericErrorBackoffMs: 2000,
	// ~1 min sustained-failure tolerance before abort (paginated stream can't restart).
	svmSignatureMaxConsecutiveErrors: 30,

	svmTransactionsBatchSize: 15,
	svmTransactionsBatchRetries: 5,
	svmTransactionsBatchRetryDelayMs: 3000,
	svmTransactionsBatchInterDelayMs: 2000,
	svmTransactionsBatchMaxPasses: 2
} as const;

export { svmScanPublicRpcUrl, svmScanPrivateRpcUrl, rpcScanLimits };
