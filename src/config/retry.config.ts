interface RetryConfig {
	defaultMaxAttempts: number;
	defaultDelayMs: number;
}

const retryConfig: RetryConfig = {
	defaultMaxAttempts: 3,
	defaultDelayMs: 2000
};

export { retryConfig, RetryConfig };
