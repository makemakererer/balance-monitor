import { AccountMeta, PublicKey } from "@solana/web3.js";
import { cctpSvmMessageTransmitterProgramId, cctpSvmTokenMessengerProgramId } from "../config";
import { SPL_TOKEN_PROGRAM, SYSTEM_PROGRAM } from "./main-programs-ids";

interface CctpMintDataParams {
	message: Buffer;
	attestation: Buffer;
}

interface PreparedInstruction<T> {
	accountMetas: AccountMeta[];
	programId: PublicKey;
	dataBuilder: (params: T) => Buffer;
}

const TOKEN_MESSENGER = new PublicKey(cctpSvmTokenMessengerProgramId);
const MESSAGE_TRANSMITTER = new PublicKey(cctpSvmMessageTransmitterProgramId);

const CCTP_MINT_STATIC_KEYS = {
	messageTransmitter: new PublicKey("W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU"),
	msgTransmitterEventAuthority: new PublicKey("2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV"),
	tokenMessenger: new PublicKey("AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W"),
	tokenMinter: new PublicKey("E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux"),
	localToken: new PublicKey("CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1"),
	feeRecipientTokenAccount: new PublicKey("6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3"),
	custodyTokenAccount: new PublicKey("6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L"),
	tokenMessengerEventAuthority: new PublicKey("6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd")
};

function buildCctpMintData(params: CctpMintDataParams): Buffer {
	const discriminator = Buffer.from([38, 144, 127, 225, 31, 225, 238, 25]);
	const messageLen = Buffer.alloc(4);
	messageLen.writeUInt32LE(params.message.length, 0);
	const attestationLen = Buffer.alloc(4);
	attestationLen.writeUInt32LE(params.attestation.length, 0);
	return Buffer.concat([discriminator, messageLen, params.message, attestationLen, params.attestation]);
}

function getCctpMintInstruction(
	payer: PublicKey,
	userUsdcAta: PublicKey,
	sourceDomain: number,
	nonce: Buffer,
	sourceTokenHex: string
): PreparedInstruction<CctpMintDataParams> {
	const [authorityPda] = PublicKey.findProgramAddressSync(
		[Buffer.from("message_transmitter_authority"), TOKEN_MESSENGER.toBuffer()],
		MESSAGE_TRANSMITTER
	);

	const [usedNonce] = PublicKey.findProgramAddressSync([Buffer.from("used_nonce"), nonce], MESSAGE_TRANSMITTER);

	const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
		[Buffer.from("remote_token_messenger"), Buffer.from(sourceDomain.toString())],
		TOKEN_MESSENGER
	);

	const [tokenPair] = PublicKey.findProgramAddressSync(
		[
			Buffer.from("token_pair"),
			Buffer.from(sourceDomain.toString()),
			Buffer.from(sourceTokenHex.replace("0x", ""), "hex")
		],
		TOKEN_MESSENGER
	);

	const accountMetas: AccountMeta[] = [
		{ pubkey: payer, isSigner: true, isWritable: true },
		{ pubkey: payer, isSigner: true, isWritable: true },
		{ pubkey: authorityPda, isSigner: false, isWritable: false },
		{ pubkey: CCTP_MINT_STATIC_KEYS.messageTransmitter, isSigner: false, isWritable: false },
		{ pubkey: usedNonce, isSigner: false, isWritable: true },
		{ pubkey: TOKEN_MESSENGER, isSigner: false, isWritable: false },
		{ pubkey: new PublicKey(SYSTEM_PROGRAM), isSigner: false, isWritable: false },
		{ pubkey: CCTP_MINT_STATIC_KEYS.msgTransmitterEventAuthority, isSigner: false, isWritable: false },
		{ pubkey: MESSAGE_TRANSMITTER, isSigner: false, isWritable: false },
		{ pubkey: CCTP_MINT_STATIC_KEYS.tokenMessenger, isSigner: false, isWritable: false },
		{ pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
		{ pubkey: CCTP_MINT_STATIC_KEYS.tokenMinter, isSigner: false, isWritable: true },
		{ pubkey: CCTP_MINT_STATIC_KEYS.localToken, isSigner: false, isWritable: true },
		{ pubkey: tokenPair, isSigner: false, isWritable: false },
		{ pubkey: CCTP_MINT_STATIC_KEYS.feeRecipientTokenAccount, isSigner: false, isWritable: true },
		{ pubkey: userUsdcAta, isSigner: false, isWritable: true },
		{ pubkey: CCTP_MINT_STATIC_KEYS.custodyTokenAccount, isSigner: false, isWritable: true },
		{ pubkey: new PublicKey(SPL_TOKEN_PROGRAM), isSigner: false, isWritable: false },
		{ pubkey: CCTP_MINT_STATIC_KEYS.tokenMessengerEventAuthority, isSigner: false, isWritable: false },
		{ pubkey: TOKEN_MESSENGER, isSigner: false, isWritable: false }
	];

	return {
		accountMetas,
		programId: MESSAGE_TRANSMITTER,
		dataBuilder: buildCctpMintData
	};
}

export { getCctpMintInstruction, CctpMintDataParams, PreparedInstruction };
