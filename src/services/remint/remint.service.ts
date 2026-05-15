import { dailyReportConfig } from "../../config";
import {
	AttestationEntry,
	BurnTx,
	Network,
	ReclaimPendingEntry,
	ReclaimPendingFile,
	RemintChainStats,
	RemintFailedRoute,
	RemintReport,
	RemintWindow
} from "../../types";
import { errorMessage, log, reclaimPendingExists, writeReclaimPending } from "../../utils";
import { TelegramService } from "../telegram/telegram.service";
import { AttestationFetcherService } from "./attestation-fetcher.service";
import { BurnFetcherService } from "./burn-fetcher.service";
import { MinterService, ProcessedMint } from "./minter.service";

class RemintService {
	private readonly telegram = new TelegramService();
	private readonly burnFetcher = new BurnFetcherService();
	private readonly attestationFetcher = new AttestationFetcherService();
	private readonly minter = new MinterService();

	public async remint(date: string): Promise<void> {
		if (reclaimPendingExists(date)) {
			log.info(`remint: reclaim-pending/${date}.json already exists — skipping`);
			return;
		}

		const window = this.buildWindow(date);
		const start = Date.now();
		log.important(`REMINT: window ${window.fromIso} → ${window.toIso}`);

		try {
			await this.telegram.sendRemintStart(date, window);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`telegram remint start failed: ${message}`);
		}

		let burnsByNetwork: Map<Network, BurnTx[]> = new Map();
		let attestedByNetwork: Map<Network, AttestationEntry[]> = new Map();
		let mintedByNetwork: Map<Network, ProcessedMint[]> = new Map();

		try {
			burnsByNetwork = await this.burnFetcher.fetchBurns(window);
			attestedByNetwork = await this.attestationFetcher.fetchAttestations(burnsByNetwork);
			mintedByNetwork = await this.minter.executeMints(attestedByNetwork);
		} finally {
			// Always write reclaim-pending so Solana event accounts aren't stranded
			// when a later phase throws unexpectedly.
			const reclaimEntries = this.buildReclaimEntries(burnsByNetwork, attestedByNetwork, mintedByNetwork);
			const payload: ReclaimPendingFile = {
				date,
				generatedAt: new Date().toISOString(),
				windowStart: window.fromIso,
				windowEnd: window.toIso,
				burns: reclaimEntries
			};
			const filePath = writeReclaimPending(payload);
			log.success(`remint: reclaim-pending saved → ${filePath} (${reclaimEntries.length} entry/ies)`);
		}

		const report = this.buildReport(date, window, mintedByNetwork, Date.now() - start);
		try {
			await this.telegram.sendRemintFinish(report);
		} catch (error) {
			const message = errorMessage(error);
			log.error(`telegram remint finish failed: ${message}`);
		}
		log.important(`REMINT: done in ${this.elapsed(start)}s`);
	}

	private buildReport(
		date: string,
		window: RemintWindow,
		mintedByNetwork: Map<Network, ProcessedMint[]>,
		durationMs: number
	): RemintReport {
		const perChain: RemintChainStats[] = [];
		const routeFailureCounts = new Map<string, RemintFailedRoute>();
		let totalMintedRaw = 0n;
		let totalFailedCount = 0;

		for (const [network, entries] of mintedByNetwork) {
			let newMintedRaw = 0n;
			for (const entry of entries) {
				if (entry.mint) {
					newMintedRaw += BigInt(entry.attestationData.decodedMessage.decodedMessageBody.amount);
				} else if (!entry.alreadyMinted) {
					const routeKey = `${network}->${entry.destinationNetwork}`;
					const existing = routeFailureCounts.get(routeKey);
					if (existing) {
						existing.count++;
					} else {
						routeFailureCounts.set(routeKey, { source: network, destination: entry.destinationNetwork, count: 1 });
					}
					totalFailedCount++;
				}
			}
			if (newMintedRaw > 0n) {
				perChain.push({ network, newMintedRaw });
			}
			totalMintedRaw += newMintedRaw;
		}

		return {
			date,
			windowFromIso: window.fromIso,
			windowToIso: window.toIso,
			durationMs,
			perChain,
			failedRoutes: Array.from(routeFailureCounts.values()),
			totalMintedRaw,
			totalFailedCount
		};
	}

	// Window anchored to today's UTC midnight: previous full UTC day. Cron fires
	// at 00:00 UTC → covers exactly yesterday. Anchoring to `date` (not now) keeps
	// retries idempotent.
	private buildWindow(date: string): RemintWindow {
		const toTimestampSeconds = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
		const fromTimestampSeconds = toTimestampSeconds - dailyReportConfig.windowLengthSeconds;
		return {
			fromTimestampSeconds,
			toTimestampSeconds,
			fromIso: new Date(fromTimestampSeconds * 1000).toISOString(),
			toIso: new Date(toTimestampSeconds * 1000).toISOString()
		};
	}

	private buildReclaimEntries(
		burnsByNetwork: Map<Network, BurnTx[]>,
		attestedByNetwork: Map<Network, AttestationEntry[]>,
		mintedByNetwork: Map<Network, ProcessedMint[]>
	): ReclaimPendingEntry[] {
		const solanaBurns = burnsByNetwork.get(Network.SOLANA) ?? [];
		if (solanaBurns.length === 0) return [];

		const solanaAttested = new Map(
			(attestedByNetwork.get(Network.SOLANA) ?? []).map((entry) => [entry.transactionHash, entry])
		);
		const solanaMinted = new Map(
			(mintedByNetwork.get(Network.SOLANA) ?? []).map((entry) => [entry.transactionHash, entry])
		);

		const reclaimEntries: ReclaimPendingEntry[] = [];
		for (const burn of solanaBurns) {
			const shortHash = burn.transactionHash.slice(0, 10);
			if (!burn.eventAccount) {
				log.warning(`reclaim-pending: ${shortHash}… has no eventAccount — saving with null`);
			}
			if (burn.blockTime === undefined) {
				log.warning(`reclaim-pending: ${shortHash}… has no blockTime — saving with null`);
			}

			const attested = solanaAttested.get(burn.transactionHash);
			const minted = solanaMinted.get(burn.transactionHash);

			reclaimEntries.push({
				network: Network.SOLANA,
				signature: burn.transactionHash,
				slot: burn.blockNumber,
				blockTime: burn.blockTime ?? null,
				eventAccount: burn.eventAccount ?? null,
				sourceDomain: attested ? Number(attested.attestationData.decodedMessage.sourceDomain) : null,
				destinationDomain: attested ? Number(attested.attestationData.decodedMessage.destinationDomain) : null,
				attestation: attested
					? {
							message: attested.attestationData.message,
							attestation: attested.attestationData.attestation
						}
					: null,
				mint: minted?.mint ?? null,
				alreadyMinted: minted?.alreadyMinted ?? false
			});
		}
		return reclaimEntries;
	}

	private elapsed(startMillis: number): string {
		return ((Date.now() - startMillis) / 1000).toFixed(1);
	}
}

export { RemintService };
