# Architecture

## Directory layout

```
src/
├── config/
│   ├── network.config              # EVM/SVM RPC URLs + chain metadata (chainId, native symbol, failed-tx source)
│   ├── tokens.config               # ERC20/SPL addresses + decimals per network
│   ├── addresses.config            # Vault/Extractor + monitored wallet addresses
│   ├── cex.config                  # CEX accounts (ccxt id + env-var keys) + cexMarkets per-token
│   ├── enabled.config              # enabledNetworks + tradingTokens (on/off flags)
│   ├── rpc-scan.config             # shared scan knobs (EVM/SVM chunk sizes, retries, max-passes) + SVM scan RPC URLs
│   ├── cctp.config                 # CCTP V2 addresses + attestation polling + SVM mint compute
│   ├── profit-calculator.config    # profit window + executor program ID + CEX paging + matcher heuristics
│   ├── native-spend.config         # native↔stable V3 pools + Solana fallback + rebalance bridge map + failed-tx provider limits
│   ├── scheduler.config            # cron expression, retry policy
│   ├── retry.config                # defaults for the generic retry() helper
│   └── index.ts
├── services/
│   ├── balance-collector/          # snapshot pipeline (EVM/SVM/CEX fetchers + reporter)
│   ├── remint/
│   │   ├── remint.service          # facade: window → phase1 → phase2 → phase3 → reclaim
│   │   ├── burn-fetcher.service    # PHASE 1: scan DepositForBurn on all enabled chains
│   │   ├── attestation-fetcher.service  # PHASE 2: pull Circle attestations per burn
│   │   └── minter.service          # PHASE 3: usedNonces check + send receiveMessage/mint
│   ├── profit-calculator/
│   │   ├── profit-calculator.service    # facade: per-token loop, incremental write, telegram per-token + grand totals
│   │   ├── arbitrage-matcher.service    # pair SELL↔BUY legs (pure logic)
│   │   ├── stats-calculator.service     # totals + profit + best/worst + byRoute + byNetwork + unmatched
│   │   └── fetchers/
│   │       ├── evm-arbitrage.fetcher    # vault InputArbitrage/OutputArbitrage events
│   │       ├── svm-arbitrage.fetcher    # signatures → parsed-txs filtered by executor program
│   │       └── cex-arbitrage.fetcher    # ccxt fetchMyTrades grouped by orderId
│   ├── native-spend-calculator/
│   │   ├── native-spend-calculator.service  # facade: per-token arb loop, then rebalance pass, then grand totals
│   │   ├── price-resolver.service           # native↔stable V3 pool reads at the spend's block; SOL via Base fallback
│   │   ├── stats-calculator.service         # arb/rebalance/failed split + by token + by native token
│   │   ├── failed-tx-scanner/
│   │   │   ├── failed-tx-scanner.service        # dispatch by chain → etherscan / blockscout / routescan / moralis
│   │   │   └── clients/                          # one HTTP client per provider, all share request throttle + paging
│   │   └── fetchers/
│   │       ├── evm-arb-spend.fetcher        # vault arb events + failed-tx merged into reverted/unattributed records
│   │       ├── evm-rebalance-spend.fetcher  # Transfer(from=vault) logs + rebalanceCCTPV2/LZV2/Bungee selectors + failed-tx
│   │       ├── svm-arb-spend.fetcher        # signatures → executor invocations touching target mint
│   │       └── svm-rebalance-spend.fetcher  # signatures → CCTP/OFT invocations (executor excluded)
│   ├── scheduler/                  # node-cron 00:00 UTC + startup catch-up + retry policy
│   └── telegram/                   # send-only
├── abis/                           # TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, EXTRACTOR, VAULT
├── solana-instructions/            # CCTP mint instruction encoder for SVM
├── types/
├── utils/                          # logger, retry, retrieve-attestation, timestamp-to-block,
│                                   # json-helper (all data/* I/O), report-utils, decimals, request-throttle
└── start.ts                        # Entry: new SchedulerService().start()
```

## What's monitored

Verified against v3Pools-Arb source (`src/services/arbitrage/state/managers/balance-manager.ts`):

- **EVM (active: ETH/SONIC/BASE/AVAX/BSC/ARB/SONEIUM)**: native + ERC20 on:
  - `ARB_WALLET_ADDRESS` — main arbitrage wallet (every chain). All arb txs are signed by this wallet.
  - `REBALANCER_WALLET_ADDRESS` — holds native only (every chain), used for cross-chain rebalancing. All rebalance txs are signed by this wallet.
  - **Vault Executors** (`vaultExecutorAddresses`) — HOLD per-token balances (token + USDC pair per balance-manager.ts:219-242).
- **Extractor** (`extractorAddresses`) — pass-through, skipped from balance snapshot.
- **SVM (Solana)**: native SOL + SPL on `SOLANA_WALLET_ADDRESS` (ATAs of operator wallet).
- **CEX (ccxt)**: MEXC (main), MEXC anon, MEXC river, Kraken, Gate. All non-zero balances per account.

CCTP-active chains (`cctp.config.ts:cctpDomainIds`): ETH, SONIC, BASE, AVAX, ARB, SOLANA.

## Failed-tx provider routing

Per-chain via `evmChainMetadata[network].failedTxSource`:

- `etherscan` — ETH, SONIC (single API key, chainId in query)
- `blockscout` — BASE, ARB, OP, SONEIUM (no key, per-chain instance URL in `blockscoutBaseUrl`)
- `routescan` — AVAX (no key, chainId in path)
- `moralis` — BSC (single API key, hex chainId in query)
- `null` — ABSTRACT, INK, CRONOS_ZKEVM, FLARE, ZORA, KAVA, METIS (no failed-tx scanning; arb/rebalance fetchers report it as a scan-failure per intent)

Adding a new chain: pick a provider that covers it, add `failedTxSource` (+ `blockscoutBaseUrl` if blockscout) in `network.config.ts`. The dispatcher in `failed-tx-scanner.service.ts` already routes by source.

## Tech stack

- TypeScript 5.8, ES2021, CommonJS
- EVM: ethers v6
- SVM: @solana/web3.js 1.95.8, @solana/spl-token
- CEX: ccxt
- Scheduling: node-cron
- Telegram: node-telegram-bot-api
- Logging: chalk 4 (CommonJS-compatible)
