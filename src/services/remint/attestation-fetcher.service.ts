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

			let pending = burns;
			for (let pass = 1; pass <= cctpRateLimits.attestationMaxPasses; pass++) {
				if (pending.length === 0) break;
				if (pass > 1) {
					log.warning(
						`[${network}] phase 2 retry pass ${pass}/${cctpRateLimits.attestationMaxPasses}: re-fetching ${pending.length} attestation(s) that timed out earlier`
					);
				}

				const stillFailing: BurnTx[] = [];
				let bucket = -1;
				for (let i = 0; i < pending.length; i++) {
					const burn = pending[i];
					try {
						const attestationData = await retrieveAttestation(burn.transactionHash, sourceDomain);
						attested.push({ ...burn, attestationData });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						log.warning(`[${network}] attestation failed for ${burn.transactionHash.slice(0, 10)}…: ${message}`);
						stillFailing.push(burn);
					}
					await sleep(cctpRateLimits.attestationInterTxDelayMs);
					if (pass === 1) {
						bucket = reportProgress(`[${network}] phase 2`, i + 1, pending.length, bucket);
					}
				}

				if (pass > 1) {
					const recovered = pending.length - stillFailing.length;
					log.info(`[${network}] phase 2 retry pass ${pass}: recovered ${recovered}/${pending.length} attestation(s)`);
				}
				pending = stillFailing;
			}

			attestationsByNetwork.set(network, attested);
			if (pending.length > 0) {
				log.error(
					`[${network}] phase 2 permanently lost ${pending.length} attestation(s) after ${cctpRateLimits.attestationMaxPasses} pass(es); these burns won't be minted in this run (recorded in reclaim-pending for manual handling)`
				);
			}
			log.success(`[${network}] attestations: ${attested.length}/${burns.length}`);
		}

		return attestationsByNetwork;
	}
}

export { AttestationFetcherService };
