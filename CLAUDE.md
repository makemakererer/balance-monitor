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

## Detailed docs

Load the relevant file when you need details on a subsystem — these are intentionally NOT pre-loaded into context.

- [docs/architecture.md](docs/architecture.md) — directory layout, what's monitored, failed-tx provider routing, tech stack
- [docs/pipelines.md](docs/pipelines.md) — per-pipeline flow (remint, profit, native-spend), schedule + idempotency, Telegram report formatting, future ideas
- [docs/conventions.md](docs/conventions.md) — two-pass retry pattern, logging rules, `data/*` storage layout
