import { cctpAttestationApiUrl, cctpRateLimits } from "../config";
import { ApiCctpMessage, ApiCctpResponse } from "../types";
import { log } from "./logger";
import { sleep } from "./retry";

async function retrieveAttestation(transactionHash: string, sourceDomain: number): Promise<ApiCctpMessage> {
	const url = `${cctpAttestationApiUrl}${sourceDomain}?transactionHash=${transactionHash}`;
	await sleep(cctpRateLimits.attestationInitialDelayMs);
	for (let attempt = 1; attempt <= cctpRateLimits.attestationMaxPollAttempts; attempt++) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				const body = (await response.json()) as ApiCctpResponse;
				const message = body.messages?.[0];
				if (message && message.status === "complete") {
					return message;
				}
			} else {
				log.warning(`attestation HTTP ${response.status} for ${transactionHash.slice(0, 10)}… (poll ${attempt})`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.warning(`attestation fetch error for ${transactionHash.slice(0, 10)}…: ${message}`);
		}
		await sleep(cctpRateLimits.attestationPollIntervalMs);
	}
	throw new Error(
		`attestation not ready for ${transactionHash} after ${cctpRateLimits.attestationMaxPollAttempts} polls`
	);
}

export { retrieveAttestation };
