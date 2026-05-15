// Schedule format for the daily-report run. Defines WHEN and HOW OFTEN the daily
// pipeline (remint → profit/native per-token → balance snapshot) fires — NOT a
// specific calendar date. Change here to shift the trigger (e.g. switch to
// "every day at 12:00 Kyiv" by editing cronExpression + cronTimezone).
//
// `windowLengthSeconds` is the data range each run scans (1 day by default).
// The daily-report orchestrator derives `fromIso`/`toIso` from this at run start;
// the target date is always today's UTC date.

const ONE_DAY_SECONDS = 24 * 60 * 60;

interface DailyReportConfig {
	cronExpression: string;
	cronTimezone: string;
	windowLengthSeconds: number;
}

const dailyReportConfig: DailyReportConfig = {
	cronExpression: "0 0 * * *",
	cronTimezone: "UTC",
	windowLengthSeconds: ONE_DAY_SECONDS
};

export { dailyReportConfig, DailyReportConfig };
