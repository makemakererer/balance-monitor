// Normalize unknown caught values to a readable string. Used at every catch
// boundary to feed log lines / Telegram detail / failure records.
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export { errorMessage };
