import { cctpDomainIds, cctpRateLimits } from "../../config";
import { AttestationEntry, BurnTx, Network } from "../../types";
import { log, reportProgress, retrieveAttestation, sleep } from "../../utils";

class AttestationFetcherService {
	public async fetchAttestations(burnsByNetwork: Map<Network, BurnTx[]>): Promise<Map<Network, AttestationEntry[]>> {
		const attestationsByNetwork = new Map<Network, AttestationEntry[]>();
		const totalBurns = Array.from(burnsByNetwork.values()).reduce((sum, list) => sum + list.length, 0);

		log.important(`PHASE 2: fetch attestations — ${totalBurns} burn tx(s) across ${burnsByNetwork.size} chain(s)`);
		if (totalBurns === 0) return attestationsByNetwork;

		for (const [network, burns] of burnsByNetwork) {
			if (burns.length === 0) {
				attestationsByNetwork.set(network, []);
				continue;
			}
			const sourceDomain = cctpDomainIds[network];
			if (sourceDomain === undefined) {
				log.error(`[${network}] no CCTP domain id; skipping attestations`);
				attestationsByNetwork.set(network, []);
				continue;
			}

			log.important(`[${network}] fetching ${burns.length} attestation(s)`);
			const attested: AttestationEntry[] = [];
			let bucket = -1;

			for (let i = 0; i < burns.length; i++) {
				const burn = burns[i];
				try {
					const attestationData = await retrieveAttestation(burn.transactionHash, sourceDomain);
					attested.push({ ...burn, attestationData });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error(`[${network}] attestation failed for ${burn.transactionHash.slice(0, 10)}…: ${message}`);
				}
				await sleep(cctpRateLimits.attestationInterTxDelayMs);
				bucket = reportProgress(`[${network}] phase 2`, i + 1, burns.length, bucket);
			}

			attestationsByNetwork.set(network, attested);
			log.success(`[${network}] attestations: ${attested.length}/${burns.length}`);
		}

		return attestationsByNetwork;
	}
}

export { AttestationFetcherService };
