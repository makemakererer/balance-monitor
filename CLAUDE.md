# balance-monitor

Daily ops bot paired with `v3Pools-Arb`. Runs three jobs at 00:00 UTC each day:

1. **Remint** — for the previous 24h, scan all CCTP `DepositForBurn` events on monitored chains, pull Circle attestations, and execute any missing `receiveMessage` (EVM) / CCTP mint (SVM) on the destination chain. Whatever didn't complete is saved to `data/reclaim-pending/YYYY-MM-DD.json` for manual handling (esp. Solana event accounts that need reclaim).
2. **Profit-calculator** — for the previous 24h, scan vault `InputArbitrageExecuted` / `OutputArbitrageExecuted` events on all enabled chains + SVM executor-program trades + CEX fills, pair buy↔sell legs, aggregate per-token profits. Persists to `data/profits/YYYY-MM-DD.json` and posts per-token + grand-totals reports to Telegram.
3. **Balance snapshot** — collects balances from all monitored wallets, vault contracts, and CEX accounts; persists a JSON snapshot to `data/snapshots/YYYY-MM-DD.json` and posts a report to Telegram.

Order: remint → profit-calculator → snapshot. Each is wrapped in a safety try/catch so an earlier failure never blocks a later step (`runRemintSafely`, `runProfitCalculatorSafely`).

Sister project of `../v3Pools-Arb` — shares wallet identities, network list, and token map. Configs (network RPCs, token addresses, vault addresses) are **copied** from v3Pools-Arb on demand, not imported as a dependency. Re-sync manually if v3Pools-Arb adds a network or token.

## Verification

After code changes, always run:

- Type check: `npx tsc --noEmit`

(No prettier in this project.)

## Architecture

```
src/
├── config/
│   ├── network.config              # EVM RPC URLs + chain metadata
│   ├── tokens.config               # ERC20/SPL addresses + decimals per network
│   ├── addresses.config            # Vault/Extractor + monitored wallet addresses
│   ├── cex.config                  # CEX accounts (ccxt id + env-var keys) + cexMarkets per-token
│   ├── enabled.config              # enabledNetworks + tradingTokens (on/off flags)
│   ├── rpc-scan.config             # shared scan knobs (EVM/SVM chunk sizes, retries, max-passes) + SVM scan RPC URLs
│   ├── cctp.config                 # CCTP V2 addresses + attestation polling + SVM mint compute
│   ├── profit-calculator.config    # profit window + executor program ID + CEX paging + matcher heuristics
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
│   │   ├── stats-calculator.service     # totals + profit + best/worst + byRoute + byNetwork + unmatched (pure logic)
│   │   └── fetchers/
│   │       ├── evm-arbitrage.fetcher    # vault InputArbitrage/OutputArbitrage events
│   │       ├── svm-arbitrage.fetcher    # signatures → parsed-txs filtered by executor program
│   │       └── cex-arbitrage.fetcher    # ccxt fetchMyTrades grouped by orderId
│   ├── scheduler/                  # node-cron 00:00 UTC + startup catch-up + retry policy
│   └── telegram/                   # send-only
├── abis/                           # TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, EXTRACTOR, VAULT
├── solana-instructions/            # CCTP mint instruction encoder for SVM
├── types/
├── utils/                          # logger, retry, retrieve-attestation, timestamp-to-block,
│                                   # json-helper (all data/* I/O), report-utils, decimals
└── start.ts                        # Entry: new SchedulerService().start()
```

## Schedule + Idempotency

- Cron fires daily at 00:00 **UTC** (`schedulerConfig.cronExpression`).
- On startup: if today's snapshot is missing, run immediately (catch-up). Otherwise wait for the next tick.
- If today's balance snapshot already exists → skip the whole tick. Restarts never duplicate work or messages.
- **Snapshot atomicity**: write JSON first → send Telegram → if send fails, log but keep the snapshot (next tick won't retry the message; resend manually).
- **Remint idempotency**: writes `data/reclaim-pending/YYYY-MM-DD.json` in a `finally` block so Solana event accounts aren't stranded even if a later phase throws. If `reclaim-pending/YYYY-MM-DD.json` already exists at run start, remint is skipped.
- **Profit-calc idempotency**: completion marker is `grandTotals !== null` in `data/profits/YYYY-MM-DD.json`. `profitSnapshotComplete(date)` short-circuits when fully done. Partial snapshots are **resumed** on retry: tokens already in `perToken` are skipped (no duplicate Telegram), the loop continues from where it stopped, then `grandTotals` is written and the final Telegram fires once.

## Remint pipeline

```
PHASE 1 — burn-fetcher (per enabled CCTP chain)
  EVM: queryFilter(DepositForBurn) in evmChunkSize-block windows, per vault
  SVM: getSignaturesForAddress(public RPC) → getParsedTransactions(private RPC) → detect DepositForBurn

PHASE 2 — attestation-fetcher
  for each burn: poll Circle attestation API until status=complete (60 polls × 5s = 5 min per tx)

PHASE 3 — minter
  for each attestation:
    isNonceUsed(destination) → record as alreadyMinted
    else                     → receiveMessage (EVM) / sendRawTransaction (SVM)
```

CCTP-active chains (`cctp.config.ts:cctpDomainIds`): ETH, SONIC, BASE, AVAX, ARB, SOLANA.

## Profit-calculator pipeline

```
FACADE (per enabled trading token, sequentially)
  Telegram: 📈 Profit calculation started — window + vertical token list (─ TOKEN per line)
  Per token (i/N):
    Telegram: <b>Profit calculating #i TOKEN</b>
    Promise.all([
      evm-fetcher  → scan Input/OutputArbitrageExecuted on all enabled chains for vaultExecutorAddresses[net][token]
      svm-fetcher  → signatures of SOLANA_WALLET_ADDRESS → parsed-txs invoking executor program → pre/post token deltas
      cex-fetcher  → for each cexMarkets[token]: ccxt fetchMyTrades paged, group fills by orderId
    ])
    → ArbitrageMatcherService.match (SELL legs ↔ BUY legs, 1h time window, 0.5% tolerance when CEX involved)
    → StatsCalculatorService.calculate (totals, profit stats, best/worst, byRoute, byNetwork, unmatchedStats with signed netTarget + VWAP break-even)
    → write data/profits/<date>.json (perToken[<TOKEN>] entry appended)
    → Telegram: 💰 Profit — <TOKEN> · top-line "Profit: $X.XX" + expandable blocks (🧾 Stats, 🔀 Routes, ⚖️ Position imbalance, 🚨 Scan failures)

AFTER LOOP
  → compute grandTotals (profit-by-token, top routes, top networks, totals)
  → write data/profits/<date>.json with grandTotals filled
  → Telegram: 🏆 Profit calculation complete · top-line "Total profit: $X.XX" + expandable blocks (💵 Profit by token, ⚖️ Position imbalance, 🧾 Stats, 🔀 Top routes, 🌐 Activity by network, 🚨 Scan failures)
  → Telegram: 📎 profit-<date>.json — attached via sendDocument (separate message)
```

Trading tokens (`enabled.config.ts:tradingTokens`) and per-token CEX markets (`cex.config.ts:cexMarkets`) are independently configurable.

`profitToken` on `MatchedArbitrage` / `StatsProfit` is always a `TokenSymbol` enum member (never a free string). Same stable on both legs → that stable (e.g. USDC). Mixed stables → `TokenSymbol.USD` as the abstract marker. Default for no-matches aggregation → `TokenSymbol.USDC`.

**Telegram report formatting (per-token + grand totals):** sections rendered as `<blockquote expandable>` — same dropdown pattern as the balance snapshot. All monetary values are always `$X.XX` via `formatUsd` (2 decimals, `<$0.01` for sub-cent dust — HTML-encoded as `&lt;$0.01`); never mixed `USDC`/`USD` labels. Token quantities use `formatTokenAmount` (ticker stays implicit inside the per-token block; 2–5 decimals).

**Position imbalance block** (per-token + totals): shows leftover from unmatched legs only. Per-token has `Bought / Sold / Net / Avg price`; totals block has one line per token `TOKEN: ±N (avg $X.XX)`. `Net` is signed (`+` over-bought, `-` over-sold). `Avg price` is the volume-weighted cost basis computed from the real prices on the unmatched trades themselves — i.e. the price at which closing the leftover nets zero P&L. Block is hidden when `closing.action === "NONE"` (balanced position).

## Retry strategy ("nothing is missed silently")

Every batched/chunked RPC scan in remint + profit-calc follows the **two-pass guarantee**:

- **Pass 1**: iterate every chunk/batch; failures land in `stillFailing`, not silently dropped.
- **Pass 2**: re-run the still-failing items with a fresh retry budget.
- **Final**: if anything is still failing after the last pass, `log.error "permanently lost N/M ..."` with explicit count of lost block / signature ranges.

Applied to:

- `burn-fetcher.scanEvmInChunks` and `evm-arbitrage.scanEvmInChunks` — per-chunk `evmChunkRetries` × `evmChunkMaxPasses`
- `burn-fetcher.parseSvmBurnsFromSignatures` and `svm-arbitrage.parseSvmTradesFromSignatures` — per-batch `svmTransactionsBatchRetries` × `svmTransactionsBatchMaxPasses`
- `attestation-fetcher.fetchAttestations` — per-tx 60 polls × `attestationMaxPasses`

Other safety bounds:

- `collectSvmSignaturesInWindow` (both remint and profit-calc) — paginated stream (can't restart from arbitrary cursor); aborts after `svmSignatureMaxConsecutiveErrors` consecutive failures (no forward progress) instead of spinning forever.
- `retrieveAttestation` — 60-poll hard cap per tx; heartbeat info log every `attestationHeartbeatEveryNPolls` so a hanging tx is visible in the stream.

Shared scan knobs live in `rpc-scan.config.ts:rpcScanLimits`. CCTP-specific attestation knobs live in `cctp.config.ts:cctpRateLimits`. Profit-calc CEX paging + matcher heuristics live in `profit-calculator.config.ts`.

## Logging rules

- Failures: `log.warning` per retry, `log.error` on final give-up + a summary line per phase with the count of lost items.
- **No narration of happy-path steps** — no `log.info("submitting…"/"broadcast…"/"confirmed")` chains around sequential awaits.
- Long polling waits get heartbeat info logs so silence ≠ hang.
- Per-tx 429 has its own warning branch (distinct from generic HTTP errors).

## What's Monitored (snapshot)

Verified against v3Pools-Arb source (`src/services/arbitrage/state/managers/balance-manager.ts`):

- **EVM (active: ETH/SONIC/BASE/AVAX/BSC/ARB/SONEIUM)**: native + ERC20 on:
  - `ARB_WALLET_ADDRESS` — main arbitrage wallet (every chain)
  - `REBALANCER_WALLET_ADDRESS` — holds native only (every chain), used for cross-chain rebalancing
  - **Vault Executors** (`vaultExecutorAddresses`) — HOLD per-token balances (token + USDC pair per balance-manager.ts:219-242).
- **Extractor** (`extractorAddresses`) — pass-through, skipped.
- **SVM (Solana)**: native SOL + SPL on `SOLANA_WALLET_ADDRESS` (ATAs of operator wallet).
- **CEX (ccxt)**: MEXC (main), MEXC anon, MEXC river, Kraken, Gate. All non-zero balances per account.

## Storage

- `data/snapshots/YYYY-MM-DD.json` — daily balance snapshot (git-tracked; history feeds day-over-day diff in TOTALS).
- `data/reclaim-pending/YYYY-MM-DD.json` — remint output: burns / attestations / mints with null entries for whatever didn't complete in the run (Solana event accounts that need manual reclaim).
- `data/profits/YYYY-MM-DD.json` — profit-calc output: `perToken` entries (stats + matched + unmatched) + `grandTotals` (null until run completes).
- All storage helpers live in `src/utils/json-helper.ts`.
- Logs in `src/logs/` (gitignored), chalk-coloured stdout.

## Code Standards

- TypeScript strict, kebab-case file names (`*.service.ts`, `*.config.ts`, `*.types.ts`)
- Tabs (4-wide), 120-char width, no trailing commas
- Token amounts as `bigint` — never `Number()` / `parseFloat()` on amounts in calculations
- Config indexed by `Network` enum: `Record<Network, T>` (or `Partial<Record<...>>` for sparse maps)
- No `any` — use `unknown` with type guards
- No magic numbers (all knobs in `*.config.ts`), no TODO/FIXME, no dead code
- Self-documenting names; minimal diff per task
- Top-level facade owns its sub-services as `private readonly`; `start.ts` only instantiates the scheduler
- **Don't fragment per-domain configs/storages into tiny files** — consolidate into existing per-domain home (`json-helper.ts` for all data/* I/O; `cex.config.ts` for everything CEX; `enabled.config.ts` for all on/off flags; `rpc-scan.config.ts` for shared scan knobs)

## Tech Stack

- TypeScript 5.8, ES2021, CommonJS
- EVM: ethers v6
- SVM: @solana/web3.js 1.95.8, @solana/spl-token
- CEX: ccxt
- Scheduling: node-cron
- Telegram: node-telegram-bot-api
- Logging: chalk 4 (CommonJS-compatible)

## Future Ideas

- USD aggregation per snapshot (price source: ccxt tickers or v3Pools-Arb `token-prices.config`)
- Telegram inbound commands (`/balance now`, `/snapshot today`, `/diff yesterday`)
- Threshold alerts (low native balance) — explicitly out of scope for v0
- Automated reclaim of Solana event accounts (currently `reclaim-pending` is manual review)
