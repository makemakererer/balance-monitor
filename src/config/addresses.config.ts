import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { Network, TokenSymbol } from "../types";

const extractorAddresses: Partial<Record<Network, string>> = {
	[Network.ETH]: "0x5d13e0Cbb94F6C99ff052b43549948439041F18C",
	[Network.SONIC]: "0x7169EbDdc4aDB5066dC9500Ab3f1f6C42886f20f",
	[Network.BASE]: "0x0af10cE44cc70458Ac85A901Bdb0A87fCE57FDfc",
	[Network.AVAX]: "0x0a836f36Afd836525Eff42F82c524B0b57DF6560",
	[Network.BSC]: "0x88FE65CB8C7D3f9C1c29aA2F07d189E2EE13CDDf",
	[Network.ARB]: "0xa15C9Bb666245aa9592F791189B86F9e2F117FC0",
	[Network.OP]: "0xAB4db858DFC51c49ad6a515a45FEB76397BFbed7",
	[Network.ABSTRACT]: "0x4bF26Bd420f3cD1Aa51f24fB43986F231685dAaC",
	[Network.INK]: "0x04b6334fdF0Aa907e6627281a94F1cb849C5C7B9",
	[Network.SONEIUM]: "0x26C7aa46d7bf10F126Cb4b18A6de1fF31f67db3b",
	[Network.CRONOS_ZKEVM]: "0xc6A5b0cF9C5e1749C55642DE8e5F7ba44649a6c4",
	[Network.FLARE]: "0x42aEddffd67F441B622156921Bd0d126d6cE782D",
	[Network.ZORA]: "0x9cf4212eE5B4CF990bb05f8F27cCDC56b11D3Eb3",
	[Network.KAVA]: "0xE91Ac091Fc09C64910693B961F2c3C29FCf5fd42",
	[Network.METIS]: "0x04b6334fdF0Aa907e6627281a94F1cb849C5C7B9"
};

const vaultExecutorAddresses: Partial<Record<Network, Partial<Record<TokenSymbol, string>>>> = {
	[Network.ETH]: {
		[TokenSymbol.ANON]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381",
		[TokenSymbol.RIVER]: "0xA20BB22d9A71BF6e6CA37a72Fc350B97Fd658469"
	},
	[Network.SONIC]: {
		[TokenSymbol.ANON]: "0xAB4db858DFC51c49ad6a515a45FEB76397BFbed7"
	},
	[Network.BASE]: {
		[TokenSymbol.ANON]: "0x258E8E1CB3F4F5915671Fe9dA06bD8a4A63fE692",
		[TokenSymbol.RIVER]: "0xD7ba72C19a2A7446316aD094d7717716F68CeA8c",
		[TokenSymbol.ETH]: "0x47FF64ba9fA561013c7185167C9e44d4D17adDF8"
	},
	[Network.AVAX]: {
		[TokenSymbol.ANON]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.BSC]: {
		[TokenSymbol.ANON]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381",
		[TokenSymbol.RIVER]: "0x57b11C0e3DE936c48445d44cF6fe7054eC7d521a",
		[TokenSymbol.ETH]: "0x3954e63306D2EeAaB196CE903c4bc6A1B18d2C0F"
	},
	[Network.ARB]: {
		[TokenSymbol.ETH]: "0xD7ba72C19a2A7446316aD094d7717716F68CeA8c",
		[TokenSymbol.ANON]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.OP]: {
		[TokenSymbol.ZRO]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.ABSTRACT]: {
		[TokenSymbol.ETH]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.INK]: {
		[TokenSymbol.ETH]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.SONEIUM]: {
		[TokenSymbol.ETH]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.CRONOS_ZKEVM]: {
		[TokenSymbol.ZK_CRO]: "0x2C07214fda948E8a29A613070B3752e319Ad393d"
	},
	[Network.FLARE]: {
		[TokenSymbol.ETH]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.ZORA]: {
		[TokenSymbol.ETH]: "0x801888a5AF063aaE48761aAb12a83eCB07c1B381"
	},
	[Network.KAVA]: {
		[TokenSymbol.WAGMI]: "0xAB4db858DFC51c49ad6a515a45FEB76397BFbed7"
	},
	[Network.METIS]: {
		[TokenSymbol.WAGMI]: "0xd045AF32cF06AAa3d40B1583eB21D1645005A55C"
	}
};

interface MonitoredEvmWallets {
	arb: string;
	rebalancer: string;
}

function loadMonitoredEvmWallets(): MonitoredEvmWallets {
	const arb = process.env.ARB_WALLET_ADDRESS;
	const rebalancer = process.env.REBALANCER_WALLET_ADDRESS;
	if (!arb) throw new Error("[addresses.config] Missing env var: ARB_WALLET_ADDRESS");
	if (!rebalancer) throw new Error("[addresses.config] Missing env var: REBALANCER_WALLET_ADDRESS");
	if (!ethers.isAddress(arb)) {
		throw new Error(`[addresses.config] ARB_WALLET_ADDRESS is not a valid EVM address: ${arb}`);
	}
	if (!ethers.isAddress(rebalancer)) {
		throw new Error(`[addresses.config] REBALANCER_WALLET_ADDRESS is not a valid EVM address: ${rebalancer}`);
	}
	return { arb: ethers.getAddress(arb), rebalancer: ethers.getAddress(rebalancer) };
}

function loadMonitoredSvmWallet(): string {
	const address = process.env.SOLANA_WALLET_ADDRESS;
	if (!address) throw new Error("[addresses.config] Missing env var: SOLANA_WALLET_ADDRESS");
	try {
		new PublicKey(address);
	} catch {
		throw new Error(`[addresses.config] SOLANA_WALLET_ADDRESS is not a valid Solana pubkey: ${address}`);
	}
	return address;
}

export {
	extractorAddresses,
	vaultExecutorAddresses,
	loadMonitoredEvmWallets,
	loadMonitoredSvmWallet,
	MonitoredEvmWallets
};
