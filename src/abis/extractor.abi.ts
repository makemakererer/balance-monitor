export const EXTRACTOR_ABI = [
	{
		inputs: [
			{
				internalType: "address[]",
				name: "_pools",
				type: "address[]"
			},
			{
				internalType: "uint256[]",
				name: "_maxTicksCounts",
				type: "uint256[]"
			},
			{
				internalType: "enum IExtractor.PoolType[]",
				name: "_types",
				type: "uint8[]"
			},
			{
				internalType: "address[][]",
				name: "_tokens",
				type: "address[][]"
			},
			{
				internalType: "address[]",
				name: "accounts",
				type: "address[]"
			},
			{
				internalType: "address[]",
				name: "nativeAccounts",
				type: "address[]"
			}
		],
		name: "extractState",
		outputs: [
			{
				components: [
					{
						components: [
							{
								internalType: "address",
								name: "pool",
								type: "address"
							},
							{
								internalType: "int24",
								name: "tick",
								type: "int24"
							},
							{
								internalType: "int128",
								name: "tickLiquidityNet",
								type: "int128"
							},
							{
								internalType: "int24",
								name: "tickSpacing",
								type: "int24"
							},
							{
								internalType: "uint24",
								name: "fee",
								type: "uint24"
							},
							{
								internalType: "uint160",
								name: "sqrtPriceX96",
								type: "uint160"
							},
							{
								internalType: "uint128",
								name: "liquidity",
								type: "uint128"
							}
						],
						internalType: "struct IExtractor.PoolInfo",
						name: "info",
						type: "tuple"
					},
					{
						internalType: "bytes32[]",
						name: "zeroForOneTicks",
						type: "bytes32[]"
					},
					{
						internalType: "bytes32[]",
						name: "oneForZeroTicks",
						type: "bytes32[]"
					}
				],
				internalType: "struct IExtractor.PoolDataV3[]",
				name: "poolDataV3",
				type: "tuple[]"
			},
			{
				components: [
					{
						internalType: "address",
						name: "pool",
						type: "address"
					},
					{
						internalType: "uint256",
						name: "reserve0",
						type: "uint256"
					},
					{
						internalType: "uint256",
						name: "reserve1",
						type: "uint256"
					}
				],
				internalType: "struct IExtractor.PoolDataV2[]",
				name: "poolDataV2",
				type: "tuple[]"
			},
			{
				internalType: "uint256[][]",
				name: "balances",
				type: "uint256[][]"
			},
			{
				internalType: "uint256[]",
				name: "nativeBalances",
				type: "uint256[]"
			},
			{
				internalType: "uint256",
				name: "blockNumber",
				type: "uint256"
			},
			{
				internalType: "uint256",
				name: "baseFee",
				type: "uint256"
			}
		],
		stateMutability: "view",
		type: "function"
	},
	{
		inputs: [
			{
				internalType: "address[][]",
				name: "_tokens",
				type: "address[][]"
			},
			{
				internalType: "address[]",
				name: "accounts",
				type: "address[]"
			},
			{
				internalType: "address[]",
				name: "nativeAccounts",
				type: "address[]"
			}
		],
		name: "getBalances",
		outputs: [
			{
				internalType: "uint256[][]",
				name: "balances",
				type: "uint256[][]"
			},
			{
				internalType: "uint256[]",
				name: "nativeBalances",
				type: "uint256[]"
			}
		],
		stateMutability: "view",
		type: "function"
	}
] as const;
