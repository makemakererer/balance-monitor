interface FailedTx {
	hash: string;
	blockNumber: number;
	timeStamp: number;
	from: string;
	to: string;
	input: string;
	isError: boolean;
	gasUsed: bigint;
	gasPrice: bigint;
}

interface EtherscanCompatibleRawTx {
	hash: string;
	blockNumber: string;
	timeStamp: string;
	from: string;
	to: string;
	input: string;
	isError: string;
	gasUsed: string;
	gasPrice: string;
}

interface EtherscanCompatibleResponse {
	status: string;
	message: string;
	result: EtherscanCompatibleRawTx[] | string;
}

interface ProviderLimits {
	minRequestSpacingMs: number;
	pageSize: number;
	maxPages: number;
	retries: number;
	retryDelayMs: number;
	maxPasses: number;
}

interface MoralisRawTx {
	hash: string;
	block_number: string;
	block_timestamp: string;
	from_address: string;
	to_address: string | null;
	input: string;
	receipt_gas_used: string;
	gas_price: string;
	receipt_status: string;
}

interface MoralisResponse {
	cursor: string | null;
	page_size: number;
	result: MoralisRawTx[];
}

export {
	FailedTx,
	EtherscanCompatibleRawTx,
	EtherscanCompatibleResponse,
	ProviderLimits,
	MoralisRawTx,
	MoralisResponse
};
