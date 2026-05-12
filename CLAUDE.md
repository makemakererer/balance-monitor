# balance-monitor

Daily balance snapshot bot paired with `v3Pools-Arb`. At 00:00 every day collects balances from all monitored wallets, vault contracts, and CEX accounts, persists a JSON snapshot, and posts a report to a dedicated Telegram chat.

Sister project of `../v3Pools-Arb` — shares wallet identities, network list, and token map. Configs (network RPCs, token addresses, vault addresses) are **copied** from v3Pools-Arb on demand, not imported as a dependency. Re-sync manually if v3Pools-Arb adds a network or token.

## Verification

After code changes, always run:

- Type check: `npx tsc --noEmit`
- Format changed files only: `npx prettier --write <file1> <file2> ...`

## Architecture (planned)

```
src/
├── config/                  # Static config — copy from v3Pools-Arb only what's needed
│   ├── network.config        #   Networks + RPC URL env-var mapping
│   ├── tokens.config         #   ERC20/SPL addresses + decimals per network
│   ├── addresses.config      #   Vault/Extractor + monitored wallet addresses
│   ├── cex.config            #   CEX accounts → ccxt id + env-var keys
│   └── index.ts
├── services/
│   ├── balance/              # Balance fetchers
│   │   ├── evm-balance       #   Native + ERC20 (multicall where possible)
│   │   ├── svm-balance       #   Native SOL + SPL token accounts
│   │   └── cex-balance       #   ccxt unified balance fetch per account
│   ├── reporter/             # Builds the daily report (text)
│   ├── telegram/             # Sender only (no inbound commands yet)
│   ├── storage/              # JSON snapshot read/write + idempotency check
│   └── scheduler/            # node-cron 00:00 + startup catch-up
├── types/
├── utils/                    # logger (chalk), helpers
└── start.ts                  # Entry point
```

## Schedule + Idempotency

- Cron fires daily at 00:00 **UTC**.
- Each run writes `data/snapshots/YYYY-MM-DD.json` (committed to git — historical data for debug and day-over-day diff).
- On startup: if today's snapshot is missing AND we are past 00:00, run immediately (catch-up). Otherwise wait for the next cron tick.
- If today's snapshot already exists → skip. Restarts must never duplicate work or messages.
- Telegram send must be atomic with snapshot write: write JSON first → send message → if send fails, log but do not delete the snapshot (next cron tick won't retry the message; manual resend if needed).

## What's Monitored

Verified against v3Pools-Arb source (`src/services/arbitrage/state/managers/balance-manager.ts`):

- **EVM (15 networks)**: native + ERC20 on:
  - `ARB_WALLET_ADDRESS` — main arbitrage wallet (every chain)
  - `REBALANCER_WALLET_ADDRESS` — holds native only (every chain), used for cross-chain rebalancing
  - **Vault Executors** (`vaultExecutorAddresses` from v3Pools `addresses.config.ts`) — HOLD per-token balances. Per-network/per-token map. Each vault holds: its own token + USDC pair (per `balance-manager.ts:219-242`). Some vaults are for ETH-pair arb (e.g. `[Network.BASE][TokenSymbol.ETH]`).
- **Extractor** (`extractorAddresses`) — **pass-through, no balances**. Skip. Only used as a multicall balance-reader contract for v3Pools itself.
- **SVM (Solana)**: native SOL + SPL on `SOLANA_WALLET_ADDRESS` (ATAs of operator wallet). The Anchor executor program is pass-through — no program-owned balance to monitor.
- **CEX (ccxt)**: MEXC (main), MEXC anon, MEXC river, Kraken, Gate. Output **all** non-zero balances per account — no whitelist.

## Storage

- One JSON file per day in `data/snapshots/` (committed to git).
- Logs in `src/logs/` (gitignored), chalk-coloured stdout + file.

## Code Standards

- TypeScript strict, kebab-case file names (`*.service.ts`, `*.config.ts`, `*.types.ts`)
- Tabs (4-wide), 120-char width, no trailing commas — match v3Pools-Arb prettier
- Token amounts as `bigint` — never `Number()` / `parseFloat()` on amounts in calculations
- Service classes exported as singletons
- Config indexed by `Network` enum: `Record<Network, T>`
- No `any` — use `unknown` with type guards
- No magic numbers, no TODO/FIXME, no dead code
- Self-documenting names; minimal diff per task

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
- Day-over-day deltas in the report (requires reading previous snapshot)
- Threshold alerts (low native balance) — explicitly out of scope for v0
