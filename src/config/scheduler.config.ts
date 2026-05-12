interface SchedulerConfig {
	cronExpression: string;
	cronTimezone: string;
	retryDelayMs: number;
	maxRetryAttempts: number;
}

const schedulerConfig: SchedulerConfig = {
	cronExpression: "0 0 * * *",
	cronTimezone: "UTC",
	retryDelayMs: 5 * 60 * 1000,
	maxRetryAttempts: 6
};

export { schedulerConfig, SchedulerConfig };
