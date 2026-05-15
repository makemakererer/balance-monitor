import "dotenv/config";
import { SchedulerService } from "./services/scheduler/scheduler.service";
import { errorMessage, log } from "./utils";

function main(): void {
	const scheduler = new SchedulerService();
	scheduler.start();
}

try {
	main();
} catch (error) {
	const message = errorMessage(error);
	log.error(`fatal: ${message}`);
	process.exit(1);
}
