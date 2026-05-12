import * as fs from "fs";
import * as path from "path";
import { ReclaimPendingFile } from "../types";

const RECLAIM_PENDING_DIR = "./data/reclaim-pending";

function writeReclaimPending(file: ReclaimPendingFile): string {
	if (!fs.existsSync(RECLAIM_PENDING_DIR)) {
		fs.mkdirSync(RECLAIM_PENDING_DIR, { recursive: true });
	}
	const filePath = path.join(RECLAIM_PENDING_DIR, `${file.date}.json`);
	fs.writeFileSync(filePath, JSON.stringify(file, null, 2), "utf-8");
	return filePath;
}

function reclaimPendingExists(date: string): boolean {
	return fs.existsSync(path.join(RECLAIM_PENDING_DIR, `${date}.json`));
}

export { writeReclaimPending, reclaimPendingExists };
