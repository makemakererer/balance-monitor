import * as cron from "node-cron";
import { schedulerConfig } from "../../config";
import { log, snapshotExists } from "../../utils";
import { BalanceCollectorService } from "../balance-collector/balance-collector.service";

class SchedulerService {
	private readonly collector = new BalanceCollectorService();
	private isRunning = false;
	private retryTimer: NodeJS.Timeout | null = null;

	public start(): void {
		log.info(`scheduler: cron "${schedulerConfig.cronExpression}" ${schedulerConfig.cronTimezone}`);
		cron.schedule(
			schedulerConfig.cronExpression,
			() => {
				void this.runIfNeeded(0);
			},
			{ timezone: schedulerConfig.cronTimezone }
		);
		void this.runIfNeeded(0);
	}

	private async runIfNeeded(attempt: number): Promise<void> {
		const targetDate = todayUtcDate();
		if (snapshotExists(targetDate)) {
			log.info(`scheduler: snapshot for ${targetDate} already exists, skipping`);
			return;
		}
		if (this.isRunning) {
			log.warning("scheduler: previous run still in progress, skipping");
			return;
		}
		this.isRunning = true;
		this.cancelPendingRetry();
		try {
			await this.collector.collectBalance(targetDate);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const total = schedulerConfig.maxRetryAttempts + 1;
			log.error(`scheduler: run failed (attempt ${attempt + 1}/${total}): ${message}`);
			this.schedulePendingRetry(attempt);
		} finally {
			this.isRunning = false;
		}
		if (todayUtcDate() !== targetDate) {
			log.info(`scheduler: day rolled over to ${todayUtcDate()} during run, re-evaluating`);
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
