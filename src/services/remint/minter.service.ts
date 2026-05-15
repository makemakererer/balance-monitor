import bs58 from "bs58";
import { ethers } from "ethers";
import {
	ComputeBudgetProgram,
	Connection,
	Keypair,
	PublicKey,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction
} from "@solana/web3.js";
import { MESSAGE_TRANSMITTER_V2_ABI } from "../../abis";
import {
	cctpEvmMessageTransmitterAddress,
	cctpNetworkByDomainId,
	cctpRateLimits,
	svmScanPrivateRpcUrl,
	cctpSvmMasterLookupTable,
	cctpSvmMessageTransmitterProgramId,
	evmChainMetadata,
	networkRpcUrls
} from "../../config";
import { getCctpMintInstruction } from "../../solana-instructions";
import { ApiCctpMessage, AttestationEntry, MintOutcome, Network } from "../../types";
import { errorMessage, log, reportProgress, retry } from "../../utils";

interface ProcessedMint extends AttestationEntry {
	destinationNetwork: Network;
	mint: MintOutcome | null;
	alreadyMinted: boolean;
}

class MinterService {
	// EVM providers are cached per chain for the lifetime of one executeMints() call —
	// rebuilding a JsonRpcProvider on every nonce check / claim wastes the eth_chainId
	// init request and burns through RPC rate limits.
	private readonly evmProviders = new Map<Network, ethers.JsonRpcProvider>();

	public async executeMints(attestedByNetwork: Map<Network, AttestationEntry[]>): Promise<Map<Network, ProcessedMint[]>> {
		const mintedByNetwork = new Map<Network, ProcessedMint[]>();
		const totalAttestations = Array.from(attestedByNetwork.values()).reduce((sum, list) => sum + list.length, 0);

		log.important(`PHASE 3: mint check + execution — ${totalAttestations} attestation(s)`);
		if (totalAttestations === 0) return mintedByNetwork;

		try {
			for (const [sourceNetwork, attestations] of attestedByNetwork) {
				if (attestations.length === 0) {
					mintedByNetwork.set(sourceNetwork, []);
					continue;
				}
				log.important(`[${sourceNetwork}] processing ${attestations.length} mint check(s)`);
				const minted: ProcessedMint[] = [];
				let mintedRaw = 0n;
				let bucket = -1;

				for (let i = 0; i < attestations.length; i++) {
					const entry = attestations[i];
					const decoded = entry.attestationData.decodedMessage;
					const destinationNetwork = cctpNetworkByDomainId[Number(decoded.destinationDomain)];
					if (!destinationNetwork) {
						log.error(`[${sourceNetwork}] unknown destination domain ${decoded.destinationDomain}, skipping`);
						continue;
					}

					try {
						const amount = BigInt(decoded.decodedMessageBody.amount);
						const used = await this.isNonceUsed(destinationNetwork, decoded.nonce);
						if (used) {
							log.info(`[${sourceNetwork}] ${this.shortHash(entry.transactionHash)} already minted on ${destinationNetwork}`);
							minted.push({ ...entry, destinationNetwork, mint: null, alreadyMinted: true });
						} else {
							log.important(`[${sourceNetwork}] ${this.shortHash(entry.transactionHash)} minting on ${destinationNetwork} amount=${amount}`);
							const txHash = await this.claim(sourceNetwork, destinationNetwork, entry.attestationData);
							const outcome: MintOutcome = { destinationNetwork, txHash, mintedAt: new Date().toISOString() };
							minted.push({ ...entry, destinationNetwork, mint: outcome, alreadyMinted: false });
							mintedRaw += amount;
							log.success(`[${sourceNetwork}] mint success → ${destinationNetwork} amount=${amount} hash=${txHash}`);
						}
					} catch (error) {
						const message = errorMessage(error);
						log.error(`[${sourceNetwork}] mint failed for ${this.shortHash(entry.transactionHash)}: ${message}`);
						minted.push({ ...entry, destinationNetwork, mint: null, alreadyMinted: false });
					}
					bucket = reportProgress(`[${sourceNetwork}] phase 3`, i + 1, attestations.length, bucket);
				}

				mintedByNetwork.set(sourceNetwork, minted);
				log.success(`[${sourceNetwork}] minted=${Number(mintedRaw) / 1e6} USDC`);
			}
		} finally {
			this.disposeProviders();
		}

		return mintedByNetwork;
	}

	private async isNonceUsed(destinationNetwork: Network, nonce: string): Promise<boolean> {
		if (destinationNetwork === Network.SOLANA) return this.isSvmNonceUsed(nonce);
		return this.isEvmNonceUsed(destinationNetwork, nonce);
	}

	private async isEvmNonceUsed(network: Network, nonce: string): Promise<boolean> {
		const provider = this.getEvmProvider(network);
		const transmitter = new ethers.Contract(cctpEvmMessageTransmitterAddress, MESSAGE_TRANSMITTER_V2_ABI, provider);
		const value = await retry(() => transmitter.usedNonces(nonce) as Promise<bigint>, `${network} usedNonces`);
		return value !== 0n;
	}

	private async isSvmNonceUsed(nonce: string): Promise<boolean> {
		const connection = new Connection(svmScanPrivateRpcUrl, "confirmed");
		const messageTransmitter = new PublicKey(cctpSvmMessageTransmitterProgramId);
		const nonceBuffer = Buffer.from(nonce.slice(2), "hex");
		const [usedNoncePda] = PublicKey.findProgramAddressSync([Buffer.from("used_nonce"), nonceBuffer], messageTransmitter);
		const accountInfo = await retry(() => connection.getAccountInfo(usedNoncePda), "SOLANA used_nonce account");
		return accountInfo !== null;
	}

	private async claim(sourceNetwork: Network, destinationNetwork: Network, attestation: ApiCctpMessage): Promise<string> {
		if (destinationNetwork === Network.SOLANA) return this.claimSvm(sourceNetwork, attestation);
		return this.claimEvm(destinationNetwork, attestation);
	}

	private async claimEvm(destinationNetwork: Network, attestation: ApiCctpMessage): Promise<string> {
		const provider = this.getEvmProvider(destinationNetwork);
		const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY as string, provider);
		const transmitter = new ethers.Contract(cctpEvmMessageTransmitterAddress, MESSAGE_TRANSMITTER_V2_ABI, wallet);
		const tx = await transmitter.receiveMessage(attestation.message, attestation.attestation);
		const receipt = await tx.wait();
		return receipt.hash;
	}

	private async claimSvm(sourceNetwork: Network, attestation: ApiCctpMessage): Promise<string> {
		const connection = new Connection(svmScanPrivateRpcUrl, "confirmed");
		const payer = Keypair.fromSecretKey(bs58.decode(process.env.SVM_PRIVATE_KEY as string));

		// CCTP V2 checks the recipient ATA against the on-chain mintRecipient field — must use what
		// the burn declared, not payer's own ATA (payer is signer/fee-payer only, may differ from recipient).
		const userUsdcAta = this.decodeSvmMintRecipient(attestation.decodedMessage.decodedMessageBody.mintRecipient);
		const lookupTableAccount = (await connection.getAddressLookupTable(new PublicKey(cctpSvmMasterLookupTable))).value;

		const sourceDomain = Number(attestation.decodedMessage.sourceDomain);
		const nonce = Buffer.from(attestation.decodedMessage.nonce.slice(2), "hex");
		const sourceTokenHex = this.formatBurnTokenAsBytes32(
			attestation.decodedMessage.decodedMessageBody.burnToken,
			sourceNetwork
		);

		const messageBuffer = Buffer.from(attestation.message.slice(2), "hex");
		const attestationBuffer = Buffer.from(attestation.attestation.slice(2), "hex");

		const prepared = getCctpMintInstruction(payer.publicKey, userUsdcAta, sourceDomain, nonce, sourceTokenHex);
		const instruction = new TransactionInstruction({
			keys: prepared.accountMetas,
			programId: prepared.programId,
			data: prepared.dataBuilder({ message: messageBuffer, attestation: attestationBuffer })
		});
		const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: cctpRateLimits.svmMintComputeUnitLimit });

		const { blockhash } = await connection.getLatestBlockhash();
		const messageV0 = new TransactionMessage({
			payerKey: payer.publicKey,
			recentBlockhash: blockhash,
			instructions: [computeUnitLimitIx, instruction]
		}).compileToV0Message(lookupTableAccount ? [lookupTableAccount] : []);

		const transaction = new VersionedTransaction(messageV0);
		transaction.sign([payer]);

		const signature = await connection.sendRawTransaction(transaction.serialize());
		await connection.confirmTransaction(signature);
		return signature;
	}

	private getEvmProvider(network: Network): ethers.JsonRpcProvider {
		const cached = this.evmProviders.get(network);
		if (cached) return cached;
		const rpcUrl = networkRpcUrls[network];
		const meta = evmChainMetadata[network];
		if (!rpcUrl) throw new Error(`[minter] missing networkRpcUrls[${network}]`);
		if (!meta) throw new Error(`[minter] missing evmChainMetadata[${network}]`);
		const staticNetwork = ethers.Network.from(meta.chainId);
		const provider = new ethers.JsonRpcProvider(rpcUrl, staticNetwork, { staticNetwork });
		this.evmProviders.set(network, provider);
		return provider;
	}

	private disposeProviders(): void {
		for (const provider of this.evmProviders.values()) provider.destroy();
		this.evmProviders.clear();
	}

	// Circle API may return mintRecipient as 0x-hex bytes32 or as a base58 Solana pubkey;
	// both decode to the same 32-byte SPL token account.
	private decodeSvmMintRecipient(mintRecipient: string): PublicKey {
		if (mintRecipient.startsWith("0x")) {
			return new PublicKey(Buffer.from(mintRecipient.slice(2), "hex"));
		}
		return new PublicKey(mintRecipient);
	}

	private formatBurnTokenAsBytes32(burnToken: string, sourceNetwork: Network): `0x${string}` {
		if (sourceNetwork === Network.SOLANA) {
			const pubkey = new PublicKey(burnToken);
			return ethers.hexlify(pubkey.toBuffer()) as `0x${string}`;
		}
		return ethers.zeroPadValue(ethers.getAddress(burnToken), 32) as `0x${string}`;
	}

	private shortHash(hash: string): string {
		return `${hash.slice(0, 10)}…`;
	}
}

export { MinterService, ProcessedMint };
