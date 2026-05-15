import * as cron from "node-cron";
import { dailyReportConfig, schedulerConfig } from "../../config";
import { errorMessage, log } from "../../utils";
import { DailyReportService } from "../daily-report/daily-report.service";

class SchedulerService {
	private readonly dailyReport = new DailyReportService();
	private isRunning = false;
	private retryTimer: NodeJS.Timeout | null = null;

	public start(): void {
		log.info(`scheduler: cron "${dailyReportConfig.cronExpression}" ${dailyReportConfig.cronTimezone}`);
		cron.schedule(
			dailyReportConfig.cronExpression,
			() => {
				void this.runIfNeeded(0);
			},
			{ timezone: dailyReportConfig.cronTimezone }
		);
		void this.runIfNeeded(0);
	}

	private async runIfNeeded(attempt: number): Promise<void> {
		if (this.isRunning) {
			log.warning("scheduler: previous run still in progress, skipping");
			return;
		}
		this.isRunning = true;
		this.cancelPendingRetry();
		const startDay = todayUtcDate();
		try {
			await this.dailyReport.run(attempt);
		} catch (error) {
			const message = errorMessage(error);
			const total = schedulerConfig.maxRetryAttempts + 1;
			log.error(`scheduler: run failed (attempt ${attempt + 1}/${total}): ${message}`);
			this.schedulePendingRetry(attempt);
		} finally {
			this.isRunning = false;
		}
		if (todayUtcDate() !== startDay) {
			log.info(`scheduler: day rolled over from ${startDay} to ${todayUtcDate()}, re-evaluating`);
			this.cancelPendingRetry();
			void this.runIfNeeded(0);
		}
	}

	private schedulePendingRetry(attempt: number): void {
		if (attempt >= schedulerConfig.maxRetryAttempts) {
			log.error("scheduler: max retries reached, waiting for next cron tick");
			return;
		}
		const minutes = schedulerConfig.retryDelayMs / 60_000;
		const total = schedulerConfig.maxRetryAttempts + 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.runIfNeeded(attempt + 1);
		}, schedulerConfig.retryDelayMs);
		log.info(`scheduler: retry scheduled in ${minutes} min (attempt ${attempt + 2}/${total})`);
	}

	private cancelPendingRetry(): void {
		if (this.retryTimer === null) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}

function todayUtcDate(): string {
	return new Date().toISOString().slice(0, 10);
}

export { SchedulerService };
