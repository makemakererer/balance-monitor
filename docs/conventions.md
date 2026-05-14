# Conventions

## Retry strategy ("nothing is missed silently")

Every batched/chunked RPC scan in remint + profit-calc + native-spend follows the **two-pass guarantee**:

- **Pass 1**: iterate every chunk/batch; failures land in `stillFailing`, not silently dropped.
- **Pass 2**: re-run the still-failing items with a fresh retry budget.
- **Final**: if anything is still failing after the last pass, `log.error "permanently lost N/M ..."` with explicit count of lost block / signature ranges, AND a `NativeSpendScanFailure` / equivalent surfaced into the snapshot so the Telegram report flags partial data.

Applied to:

- `burn-fetcher.scanEvmInChunks`, `evm-arbitrage.scanEvmInChunks`, `evm-arb-spend.scanEvmInChunks`, `evm-rebalance-spend.scanTransfersFromVault` — per-chunk `evmChunkRetries` × `evmChunkMaxPasses`
- `evm-*-spend.fetchReceipts` and `fetchBlocks` — per-call `receiptRetries` × `receiptMaxPasses`
- `burn-fetcher.parseSvmBurnsFromSignatures`, `svm-arbitrage.parseSvmTradesFromSignatures`, `svm-arb-spend.parseArbSpendFromSignatures`, `svm-rebalance-spend.parseRebalanceSpendFromSignatures` — per-batch `svmTransactionsBatchRetries` × `svmTransactionsBatchMaxPasses`
- `attestation-fetcher.fetchAttestations` — per-tx 60 polls × `attestationMaxPasses`
- `price-resolver.priceRecordsAgainstPool` — per-block `multicallRetries` × `multicallMaxPasses`
- `failed-tx-scanner` provider clients (Etherscan/Blockscout/Routescan/Moralis) — per-page `retries` × `maxPasses`, with `RequestThrottle` ensuring `minRequestSpacingMs` between starts to stay inside rate limits

Other safety bounds:

- `collectSvmSignaturesInWindow` (remint, profit-calc, native-spend) — paginated stream (can't restart from arbitrary cursor); aborts after `svmSignatureMaxConsecutiveErrors` consecutive failures (no forward progress) instead of spinning forever.
- `retrieveAttestation` — 60-poll hard cap per tx; heartbeat info log every `attestationHeartbeatEveryNPolls` so a hanging tx is visible in the stream.

Shared scan knobs live in `rpc-scan.config.ts:rpcScanLimits`. CCTP-specific attestation knobs live in `cctp.config.ts:cctpRateLimits`. Profit-calc CEX paging + matcher heuristics live in `profit-calculator.config.ts`. Native-spend scan + per-provider failed-tx knobs live in `native-spend.config.ts`.

## Logging rules

- Failures: `log.warning` per retry, `log.error` on final give-up + a summary line per phase with the count of lost items.
- **No narration of happy-path steps** — no `log.info("submitting…"/"broadcast…"/"confirmed")` chains around sequential awaits.
- Long polling waits get heartbeat info logs so silence ≠ hang.
- Per-tx 429 has its own warning branch (distinct from generic HTTP errors).

## Storage

- `data/snapshots/YYYY-MM-DD.json` — daily balance snapshot (git-tracked; history feeds day-over-day diff in TOTALS).
- `data/reclaim-pending/YYYY-MM-DD.json` — remint output: burns / attestations / mints with null entries for whatever didn't complete in the run (Solana event accounts that need manual reclaim).
- `data/profits/YYYY-MM-DD.json` — profit-calc output: `perToken` entries (stats + matched + unmatched) + `grandTotals` (null until run completes).
- `data/native-spend/YYYY-MM-DD.json` — native-spend output: `arbSpend.perToken` entries + `rebalanceSpend` + `unattributedSpend` + `grandTotals` (null until run completes).
- All storage helpers live in `src/utils/json-helper.ts`.
- Logs in `src/logs/` (gitignored), chalk-coloured stdout.
