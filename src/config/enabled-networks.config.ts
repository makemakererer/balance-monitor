import { Network } from "../types";

// Single source of truth for what gets collected into the daily snapshot.
// Flip a value to false to exclude that network without touching any other config.
const enabledNetworks: Record<Network, boolean> = {
	// EVM
	[Network.ETH]: true,
	[Network.BSC]: true,
	[Network.BASE]: true,
	[Network.ARB]: true,
	[Network.AVAX]: true,
	[Network.SONIC]: true,
	[Network.SONEIUM]: true,
	[Network.OP]: false,
	[Network.ABSTRACT]: false,
	[Network.INK]: false,
	[Network.CRONOS_ZKEVM]: false,
	[Network.FLARE]: false,
	[Network.ZORA]: false,
	[Network.KAVA]: false,
	[Network.METIS]: false,
	// SVM
	[Network.SOLANA]: true,
	// CEX
	[Network.MEXC]: true,
	[Network.KRAKEN]: true,
	[Network.GATE]: true
};

export { enabledNetworks };
