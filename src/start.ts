import "dotenv/config";
import { SchedulerService } from "./services/scheduler/scheduler.service";
import { log } from "./utils";

function main(): void {
	const scheduler = new SchedulerService();
	scheduler.start();
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	log.error(`fatal: ${message}`);
	process.exit(1);
}
