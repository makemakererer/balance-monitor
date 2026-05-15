// Retry knobs for the cron driver. The cron expression + timezone live in
// `daily-report.config.ts` since they describe HOW the daily pipeline fires;
// these settings cover what to do when a fire fails (back-off + cap).

interface SchedulerConfig {
	retryDelayMs: number;
	maxRetryAttempts: number;
}

const schedulerConfig: SchedulerConfig = {
	retryDelayMs: 5 * 60 * 1000,
	maxRetryAttempts: 6
};

export { schedulerConfig, SchedulerConfig };
