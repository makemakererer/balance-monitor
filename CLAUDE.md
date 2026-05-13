# balance-monitor

Daily ops bot paired with `v3Pools-Arb`. Runs two jobs at 00:00 UTC each day:

1. **Remint** — for the previous 24h, scan all CCTP `DepositForBurn` events on monitored chains, pull Circle attestations, and execute any missing `receiveMessage` (EVM) / CCTP mint (SVM) on the destination chain. Whatever didn't complete is saved to `data/reclaim-pending/YYYY-MM-DD.json` for manual handling (esp. Solana event accounts that need reclaim).
2. **Balance snapshot** — collects balances from all monitored wallets, vault contracts, and CEX accounts; persists a JSON snapshot to `data/snapshots/YYYY-MM-DD.json` and posts a report to Telegram.

Remint runs first; if it throws, the snapshot still runs (`scheduler.service.ts:runRemintSafely`). Remint must never block the snapshot.

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
│   ├── cex.config                  # CEX accounts (ccxt id + env-var keys)
│   ├── cctp.config                 # CCTP V2 addresses + rate-limit/retry knobs
│   ├── enabled-networks.config
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
│   ├── scheduler/                  # node-cron 00:00 UTC + startup catch-up + retry policy
│   └── telegram/                   # send-only
├── abis/                           # TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2, EXTRACTOR
├── solana-instructions/            # CCTP mint instruction encoder for SVM
├── types/
├── utils/                          # logger, retry, retrieve-attestation, timestamp-to-block,
│                                   # reclaim-storage, json-helper, report-utils, decimals
└── start.ts                        # Entry: new SchedulerService().start()
```

## Schedule + Idempotency

- Cron fires daily at 00:00 **UTC** (`schedulerConfig.cronExpression`).
- On startup: if today's snapshot is missing, run immediately (catch-up). Otherwise wait for the next tick.
- If today's snapshot already exists → skip. Restarts never duplicate work or messages.
- **Snapshot atomicity**: write JSON first → send Telegram → if send fails, log but keep the snapshot (next tick won't retry the message; resend manually).
- **Remint idempotency**: writes `data/reclaim-pending/YYYY-MM-DD.json` in a `finally` block so Solana event accounts aren't stranded even if a later phase throws. If `reclaim-pending/YYYY-MM-DD.json` already exists at run start, remint is skipped.

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

## Retry strategy ("nothing is missed silently")

Every batched/chunked RPC scan in the remint pipeline follows the **two-pass guarantee**:

- **Pass 1**: iterate every chunk/batch; failures land in `stillFailing`, not silently dropped.
- **Pass 2**: re-run the still-failing items with a fresh retry budget.
- **Final**: if anything is still failing after the last pass, `log.error "permanently lost N/M ..."` with explicit count of lost block / signature ranges.

Applied to:

- `scanEvmInChunks` — per-chunk `evmChunkRetries` × `evmChunkMaxPasses`
- `parseSvmBurnsFromSignatures` — per-batch `svmTransactionsBatchRetries` × `svmTransactionsBatchMaxPasses`
- `fetchAttestations` — per-tx 60 polls × `attestationMaxPasses`

Other safety bounds:

- `collectSvmSignaturesInWindow` — paginated stream (can't restart from arbitrary cursor); aborts after `svmSignatureMaxConsecutiveErrors` consecutive failures (no forward progress) instead of spinning forever.
- `retrieveAttestation` — 60-poll hard cap per tx; heartbeat info log every `attestationHeartbeatEveryNPolls` so a hanging tx is visible in the stream.

All tunables live in `cctp.config.ts:cctpRateLimits`.

## Logging rules

- Failures: `log.warning` per retry, `log.error` on final give-up + a summary line per phase with the count of lost items.
- **No narration of happy-path steps** — no `log.info("submitting…"/"broadcast…"/"confirmed")` chains around sequential awaits. The success path is visible from the next phase's progress + the final success line.
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

- `data/snapshots/YYYY-MM-DD.json` — daily snapshot (git-tracked; history feeds day-over-day diff in TOTALS).
- `data/reclaim-pending/YYYY-MM-DD.json` — remint output: burns / attestations / mints with null entries for whatever didn't complete in the run (Solana event accounts that need manual reclaim).
- Logs in `src/logs/` (gitignored), chalk-coloured stdout.

## Code Standards

- TypeScript strict, kebab-case file names (`*.service.ts`, `*.config.ts`, `*.types.ts`)
- Tabs (4-wide), 120-char width, no trailing commas
- Token amounts as `bigint` — never `Number()` / `parseFloat()` on amounts in calculations
- Config indexed by `Network` enum: `Record<Network, T>` (or `Partial<Record<...>>` for sparse maps like CCTP domains)
- No `any` — use `unknown` with type guards
- No magic numbers (all knobs in `*.config.ts`), no TODO/FIXME, no dead code
- Self-documenting names; minimal diff per task
- Top-level facade owns its sub-services as `private readonly`; `start.ts` only instantiates the scheduler

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
