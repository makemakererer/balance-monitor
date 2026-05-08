import "dotenv/config";

async function main(): Promise<void> {
	console.log("[balance-monitor] starting...");
	console.log("[balance-monitor] skeleton ready — scheduler and services not yet implemented");
}

main().catch((err) => {
	console.error("[balance-monitor] fatal:", err);
	process.exit(1);
});
