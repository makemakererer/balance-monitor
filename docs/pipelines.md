# Pipelines

Four daily jobs, run sequentially at 00:00 UTC: **remint → profit-calculator → native-spend → balance snapshot**. Each is wrapped in a `try/catch` so an earlier failure never blocks a later step (`runRemintSafely`, `runProfitCalculatorSafely`, `runNativeSpendSafely`).

## Schedule + idempotency

- Cron fires daily at 00:00 **UTC** (`schedulerConfig.cronExpression`).
- On startup: if today's snapshot is missing, run immediately (catch-up). Otherwise wait for the next tick.
- If today's balance snapshot already exists → skip the whole tick. Restarts never duplicate work or messages.
- **Snapshot atomicity**: write JSON first → send Telegram → if send fails, log but keep the snapshot (next tick won't retry the message; resend manually).
- **Remint idempotency**: writes `data/reclaim-pending/YYYY-MM-DD.json` in a `finally` block so Solana event accounts aren't stranded even if a later phase throws. If `reclaim-pending/YYYY-MM-DD.json` already exists at run start, remint is skipped.
- **Profit-calc idempotency**: completion marker is `grandTotals !== null` in `data/profits/YYYY-MM-DD.json`. `profitSnapshotComplete(date)` short-circuits when fully done. Partial snapshots are **resumed** on retry: tokens already in `perToken` are skipped (no duplicate Telegram), the loop continues from where it stopped, then `grandTotals` is written and the final Telegram fires once.
- **Native-spend idempotency**: completion marker is `grandTotals !== null` in `data/native-spend/YYYY-MM-DD.json`. Same resume contract as profit-calc — per-token entries in `arbSpend.perToken` are skipped, then the rebalance pass runs once, then grand totals. `unattributedSpend.records` are deduped by `txHash` because on resume the arb fetcher may re-claim a chain it already processed in the previous run.

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

## Native-spend pipeline

Daily USD cost of being live — per trading token (arb leg) and globally (rebalance leg), plus a "Failed" tier that captures reverted txs and unattributable wallet activity.

```
FACADE (per enabled trading token, sequentially)
  Telegram: 💸 Native spend started — window + arb token list + "scanning all vaults"
  Per token (i/N):
    Promise.all([
      evm-arb-spend  → for each enabled chain with vaultExecutorAddresses[net][token]:
                       scan Input/OutputArbitrageExecuted, fetch receipts (gas) + blocks (timestamp,
                       tx.value bribe on ETH/BSC), THEN failed-tx via per-chain provider →
                       reverted-arb records (to == vault) + unattributed records (to != any vault,
                       claimed only by the FIRST token-pass per chain to avoid duplicates)
      svm-arb-spend  → SOL wallet signatures → parsed-txs invoking executor program AND touching the
                       target mint → fee + SystemProgram.Transfer-from-wallet (validator tips);
                       reverted txs pay only fee
    ])
    → priceResolver.priceAll: dedup unique blocks, fetch slot0()/globalState() on the source chain at
                               that block, convert sqrtPriceX96 → stable_per_native (18-dec bigint
                               math, Number cast once at the end), cache per (network, block)
    → write data/native-spend/<date>.json (arbSpend.perToken[<TOKEN>] entry appended)
    → Telegram: 💸 Arbitrage native spend — TOKEN (Total / Arb / Failed split + by-network block + scan failures)

AFTER PER-TOKEN LOOP — rebalance pass
  Promise.all([
    evm-rebalance-spend → for each enabled chain with any vault: scan Transfer(from=vault) logs (address-
                          filtered by `tokensToChain[network]` to satisfy BlockPi range caps), THEN
                          fetch receipts + blocks-with-txs, identify rebalances by selector
                          (rebalanceCCTPV2 / rebalanceLZV2 / rebalanceBungee) on the rebalancer wallet's
                          tx.data, attribute the bridged token via Transfer-from-vault log inside the
                          receipt, then failed-tx scan for rebalancer wallet → reverted-rebalance
                          records (selector + vault `to` match) + unattributed (no match)
    svm-rebalance-spend → SOL wallet signatures → CCTP/OFT program invocations (executor invocations
                          are EXCLUDED — those are arb), nativeAmount = pre/post lamport delta on
                          the wallet. CCTP burns subtract event_account rent (refunded ~5 days later
                          by the reclaim service, so it isn't a real spend)
  ])
  → priceResolver.priceAll
  → Telegram: 🔄 Rebalance spend (Total / Rebalance / Failed split + by-network + by-bridge → chain → token + by-token → chain + scan failures)

GRAND TOTALS
  → stats-calculator: arb totals + rebalance totals + failed totals (by type: arb-reverted / rebalance-reverted / unattributed; by network); byToken (success usd by intent + failed usd per token); byNativeToken (sum across all records keyed by native symbol)
  → write data/native-spend/<date>.json with grandTotals filled
  → Telegram: 🏁 Native spend complete (Total / Arb / Rebalance / Failed + 💵 by token + 🪙 by native token + 🌐 arbitrage-by-network + 🌐 rebalance-by-network + 🚨 failed breakdown + scan failures)
  → Telegram: 📎 native-spend-<date>.json — attached via sendDocument
```

### Pricing

- Each enabled EVM chain has a native↔stable V3 pool (`nativeUsdPoolByNetwork`). The pool's `slot0()` (or `globalState()` for Algebra forks) is read at the **same block** where the spend occurred, so the price reflects on-the-day rates. Math is done in 18-dec bigint scale; conversion to Number happens once at the very end to avoid losing digits.
- **SOL has no archive RPC**. Pricing falls back to a Base wSOL/USDC pool (`solanaFallbackPool`), time-mapped via two binary-searched Base block anchors at window edges + linear interpolation between them. So a SOL spend at timestamp T is priced from the Base block whose timestamp matches T.

### Failed-tx attribution

- **Arb fetcher**: failed txs whose `to` matches the token's vault → REVERTED arb record (gas only, status rolled back). Other failed txs from the arb wallet (approval, manual, unknown contract) → unattributed. Unattributed is "claimed" by the FIRST token-pass per chain (`unattributedClaimed: Set<Network>` on the fetcher instance) to avoid duplicates when 5 tokens scan the same wallet on the same chain.
- **Rebalance fetcher**: failed txs whose `to` matches a vault **and** whose `tx.input` selector matches `rebalanceCCTPV2` / `rebalanceLZV2` / `rebalanceBungee` → REVERTED rebalance record (with bridge + token attributed via the vault map). All other failed txs from the rebalancer wallet → unattributed.
- **SVM rebalance fetcher**: failed txs from the SVM wallet that don't invoke executor / CCTP / OFT → unattributed (fee only). Failed txs that DO invoke a known bridge program but fail attribution → dropped with a warning.

### Bribe handling

- **EVM arb on ETH and BSC**: bribe paid via `arbTx.value` on the arb tx itself (vault forwards it to the bundler internally). Other EVM chains pay gas only. Captured by fetching blocks **with** transactions (`needFullBlocks = network === ETH || BSC`) so we can read `tx.value` per record.
- **EVM rebalance**: `tx.value > 0n` is treated as bribe on any chain (rebalances rarely have one, but the field is captured when present).
- **SVM arb**: validator tips encoded as `SystemProgram.Transfer(source=wallet, lamports=X)` instructions inside the tx; summed into `breakdown.tips`.

### Trading tokens vs rebalance scope

Trading tokens (`enabled.config.ts:tradingTokens`) drive the per-token arb loop. Rebalance scans **all vaults** on every enabled chain (it doesn't know in advance which token will move).

### Telegram report formatting (native-spend)

Same conventions as profit-calc: `<blockquote expandable>` sections; all USD via `formatUsd` (`$X.XX`, `<$0.01` for dust). Native amounts shown with their chain's native symbol via `formatAmount(bigint, decimals)`. Per-network rows show `Total / SuccessLabel / Failed` split when `revertedTxCount > 0`; single-line otherwise.

## Future ideas

- USD aggregation per snapshot (price source: ccxt tickers or v3Pools-Arb `token-prices.config`)
- Telegram inbound commands (`/balance now`, `/snapshot today`, `/diff yesterday`)
- Threshold alerts (low native balance) — explicitly out of scope for v0
- Automated reclaim of Solana event accounts (currently `reclaim-pending` is manual review)
- Multi-burn CCTP rebalance: `svm-rebalance-spend.fetcher.findReclaimableEventAccountRent` only subtracts the first event_account; sum across all TokenMessenger instructions if v3Pools-Arb ever batches burns.
