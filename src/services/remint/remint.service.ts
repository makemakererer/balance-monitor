import {
	AttestationEntry,
	BurnTx,
	Network,
	ReclaimPendingEntry,
	ReclaimPendingFile,
	RemintChainStats,
	RemintReport,
	RemintWindow
} from "../../types";
import { log, reclaimPendingExists, writeReclaimPending } from "../../utils";
import { TelegramService } from "../telegram/telegram.service";
import { AttestationFetcherService } from "./attestation-fetcher.service";
import { BurnFetcherService } from "./burn-fetcher.service";
import { MinterService, ProcessedMint } from "./minter.service";

// remint window length: last 24h before the scheduler tick
const REMINT_WINDOW_SECONDS = 24 * 60 * 60;

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
			const message = error instanceof Error ? error.message : String(error);
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
			const message = error instanceof Error ? error.message : String(error);
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
		let totalMintedRaw = 0n;
		let totalFailedCount = 0;

		for (const [network, entries] of mintedByNetwork) {
			let newMintedRaw = 0n;
			let failedCount = 0;
			for (const entry of entries) {
				if (entry.mint) {
					newMintedRaw += BigInt(entry.attestationData.decodedMessage.decodedMessageBody.amount);
				} else if (!entry.alreadyMinted) {
					failedCount++;
				}
			}
			if (newMintedRaw > 0n || failedCount > 0) {
				perChain.push({ network, newMintedRaw, failedCount });
			}
			totalMintedRaw += newMintedRaw;
			totalFailedCount += failedCount;
		}

		return {
			date,
			windowFromIso: window.fromIso,
			windowToIso: window.toIso,
			durationMs,
			perChain,
			totalMintedRaw,
			totalFailedCount
		};
	}

	private buildWindow(date: string): RemintWindow {
		const dayStartMs = Date.parse(`${date}T00:00:00Z`);
		if (Number.isNaN(dayStartMs)) throw new Error(`[remint] invalid date: ${date}`);
		const toTimestampSeconds = Math.floor(dayStartMs / 1000);
		const fromTimestampSeconds = toTimestampSeconds - REMINT_WINDOW_SECONDS;
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
