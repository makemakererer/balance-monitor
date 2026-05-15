# balance-monitor

Daily ops bot paired with `v3Pools-Arb`. Runs four jobs at 00:00 UTC each day, sequentially:

1. **Remint** — replay any missing CCTP `receiveMessage` (EVM) / mint (SVM) for the prior 24h.
2. **Profit-calculator** — pair vault/CEX buy↔sell legs, aggregate per-token profits in USD.
3. **Native-spend** — daily USD cost of being live: gas + bribes + tips per trading token (arb leg) and per bridge (rebalance leg), plus a Failed tier for reverts/unattributed.
4. **Balance snapshot** — wallet + vault + CEX balances, persisted and posted to Telegram.

Each job is wrapped in a safety `try/catch` (`runRemintSafely`, `runProfitCalculatorSafely`, `runNativeSpendSafely`) so an earlier failure never blocks a later step.

Sister project of `../v3Pools-Arb` — shares wallet identities, network list, and token map. Configs (network RPCs, token addresses, vault addresses) are **copied** from v3Pools-Arb on demand, not imported as a dependency. Re-sync manually if v3Pools-Arb adds a network or token.

## Verification

After code changes, always run:

- `npx tsc --noEmit`

(No prettier in this project.)

## Architecture: calculators vs. orchestrators

- **Calculators + collectors are stateless** (`profit-calculator`, `native-spend-calculator`, `balance-collector`): input is a `Window` (or just `date` for balance-collector), output is data. No file I/O, no Telegram, no resume logic. A calculator runs the same way whether it's the daily 24h window or a 3h ad-hoc range.
- **`DailyReportService` is THE pipeline facade.** It owns: building the window (from `dailyReportConfig.windowLengthSeconds`), the per-phase safety wraps (`runRemintSafely` / `runReportingSafely`), per-token resume from partial snapshots, all JSON writes (`data/profits/*` + `data/native-spend/*` + `data/snapshots/*`), and all Telegram messaging (daily-run start/finish, per-token cards, daily total, JSON attachments, balance snapshot). Sub-services held as `private readonly`: `RemintService`, `ProfitCalculatorService`, `NativeSpendCalculatorService`, `BalanceCollectorService`, `TelegramService`.
- **`SchedulerService` is a thin cron driver.** Concurrency guard + retry + day-rollover re-eval. It reads the cron expression from `dailyReportConfig` (NOT `schedulerConfig`) and only calls `dailyReport.run(attempt)`.
- **Config split:** `daily-report.config.ts` = "how the daily fires" (cronExpression, cronTimezone, windowLengthSeconds — no concrete dates). `scheduler.config.ts` = "what to do on failure" (retry delay + max attempts).
- **JSON writes happen ONLY inside `DailyReportService`** — except `reclaim-pending/*.json`, which remint owns directly (it must persist even when a later phase throws).
- **Why this split**: future ad-hoc handlers (Telegram bot buttons that pass a custom `from`/`to`, CLI debug runs) will reuse the same calculators directly without writing daily snapshot files. If snapshot/date semantics leak into calculators, those handlers can't reuse them. Keep the calculator API window-only.

## Code standards

- TypeScript strict, kebab-case file names (`*.service.ts`, `*.config.ts`, `*.types.ts`)
- Tabs (4-wide), 120-char width, no trailing commas
- Token amounts as `bigint` — never `Number()` / `parseFloat()` on amounts in calculations
- Config indexed by `Network` enum: `Record<Network, T>` (or `Partial<Record<...>>` for sparse maps)
- No `any` — use `unknown` with type guards
- No magic numbers (all knobs in `*.config.ts`), no TODO/FIXME, no dead code
- Self-documenting names; minimal diff per task
- Top-level facade owns its sub-services as `private readonly`; `start.ts` only instantiates the scheduler
- **Don't fragment per-domain configs/storages into tiny files** — consolidate into existing per-domain home (`json-helper.ts` for all `data/*` I/O; `cex.config.ts` for everything CEX; `enabled.config.ts` for all on/off flags; `rpc-scan.config.ts` for shared scan knobs; `native-spend.config.ts` for native-spend pools + failed-tx provider limits)

## Deferred refactors (TODO)

- **Single window source, propagated top-down.** Right now `DailyReportService.buildWindow(date)` and `RemintService.buildWindow(date)` each independently rebuild `[date 00:00 UTC − dailyReportConfig.windowLengthSeconds, date 00:00 UTC]`. Two effects:
  - Duplicated date→window logic in two services (drift risk).
  - Window length is effectively hardcoded to "exactly 24h ending at midnight UTC of `date`" — `dailyReportConfig.windowLengthSeconds` is the only knob, and changing it doesn't help when the entry point is a Telegram bot button or CLI handler that wants `from`/`to` directly.
  - Goal: the entry point (scheduler today, bot/CLI tomorrow) builds the `Window` ONCE and passes it down. `DailyReportService.run(window)` accepts a window; it forwards the same window into `remint.remint(window)`. No service builds windows internally. Then `windowLengthSeconds` becomes "default for the cron path" only — ad-hoc callers pass arbitrary ranges (3h backfill, multi-day debug, custom from/to) without touching service code.
  - Don't ship until there's a concrete second caller (bot/CLI). Premature refactor otherwise.

## Detailed docs

Load the relevant file when you need details on a subsystem — these are intentionally NOT pre-loaded into context.

- [docs/architecture.md](docs/architecture.md) — directory layout, what's monitored, failed-tx provider routing, tech stack
- [docs/pipelines.md](docs/pipelines.md) — per-pipeline flow (remint, profit, native-spend), schedule + idempotency, Telegram report formatting, future ideas
- [docs/conventions.md](docs/conventions.md) — two-pass retry pattern, logging rules, `data/*` storage layout
