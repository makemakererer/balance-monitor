import { cctpAttestationApiUrl, cctpRateLimits } from "../config";
import { ApiCctpMessage, ApiCctpResponse } from "../types";
import { errorMessage } from "./error";
import { log } from "./logger";
import { sleep } from "./retry";

async function retrieveAttestation(transactionHash: string, sourceDomain: number): Promise<ApiCctpMessage> {
	const url = `${cctpAttestationApiUrl}${sourceDomain}?transactionHash=${transactionHash}`;
	const shortHash = `${transactionHash.slice(0, 10)}…`;
	await sleep(cctpRateLimits.attestationInitialDelayMs);
	let lastStatus: string | undefined;
	for (let attempt = 1; attempt <= cctpRateLimits.attestationMaxPollAttempts; attempt++) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				const body = (await response.json()) as ApiCctpResponse;
				const message = body.messages?.[0];
				if (message && message.status === "complete") {
					return message;
				}
				lastStatus = message?.status ?? "no-message";
				if (attempt % cctpRateLimits.attestationHeartbeatEveryNPolls === 0) {
					log.info(`attestation ${shortHash} still waiting (poll ${attempt}/${cctpRateLimits.attestationMaxPollAttempts}, status=${lastStatus})`);
				}
			} else if (response.status === 429) {
				log.warning(`attestation rate-limited (429) for ${shortHash} (poll ${attempt})`);
			} else {
				log.warning(`attestation HTTP ${response.status} for ${shortHash} (poll ${attempt})`);
			}
		} catch (error) {
			const message = errorMessage(error);
			log.warning(`attestation fetch error for ${shortHash}: ${message}`);
		}
		await sleep(cctpRateLimits.attestationPollIntervalMs);
	}
	throw new Error(
		`attestation not ready for ${transactionHash} after ${cctpRateLimits.attestationMaxPollAttempts} polls (last status=${lastStatus ?? "unknown"})`
	);
}

export { retrieveAttestation };
