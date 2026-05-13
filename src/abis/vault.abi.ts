export const VAULT_ABI = [
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: "address", name: "tokenIn", type: "address" },
			{ indexed: true, internalType: "address", name: "tokenOut", type: "address" },
			{ indexed: false, internalType: "uint256", name: "amountIn", type: "uint256" },
			{ indexed: false, internalType: "uint256", name: "amountOut", type: "uint256" }
		],
		name: "InputArbitrageExecuted",
		type: "event"
	},
	{
		anonymous: false,
		inputs: [
			{ indexed: true, internalType: "address", name: "tokenIn", type: "address" },
			{ indexed: true, internalType: "address", name: "tokenOut", type: "address" },
			{ indexed: false, internalType: "uint256", name: "amountIn", type: "uint256" },
			{ indexed: false, internalType: "uint256", name: "amountOut", type: "uint256" }
		],
		name: "OutputArbitrageExecuted",
		type: "event"
	}
] as const;
