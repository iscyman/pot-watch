# @pot-watch/watcher

Chain-data ingestion & metrics engine for Portaldot Network, **with an
autonomous on-chain alert loop**: the watcher reads its own alert
subscriptions from the deployed `AlertRegistry`, evaluates them against live
chain state, records every fire back on-chain (`recordFire`, native surface,
~0.015 tPOT), and delivers the receipt to Discord/Telegram. Detection →
on-chain proof → delivery, with no human in the circuit.

Streams blocks over WebSocket RPC, tracks eras/sessions, computes validator
metrics + a composite health score, evaluates alerts, and persists everything
to `data/` (JSONL — SQLite migration lands with the dashboard API).

## Requirements
- Node.js **18+** (https://nodejs.org)

## Run
```bash
npm install
npm run selfcheck      # verifies xxhash/SCALE/ss58 primitives against ground truth
npm test               # 63 unit tests (node:test via tsx)
npm start              # streams live from mainnet (wss://mainnet.portaldot.io)
npm start -- --testnet # streams from the official V3 testnet + runs the alert loop
```

## Security analytics (Package 08)
`src/walker.ts` parses the chain's FRAME metadata (v14 portable registry) with
zero dependencies and decodes ANY storage value or event by TypeId. On top:
- `src/events.ts` — `System.Events` per block → named events; slash /
  transfer / session extraction (feeds loop kinds 2 & 3 with real data)
- `src/security.ts` — stake concentration (Staking.Ledger walk → HHI),
  validator churn per session, slash feed, health-score history
  (`data/security.json` + `security.jsonl`)
- dashboard mirrors all of it live in the browser (`docs/walk.js`,
  `docs/security.js`) — same algorithms, no backend

Verified live on V3 testnet (block ~231.4k): 911-type registry parsed,
5 bonded accounts decoded, stake HHI 0.4986 (two validators ≈ 49.93% each).

## The autonomous alert loop
```
live chain state ──► evaluateAlert() ──► recordFire(id) ──► AlertFired event
   (Substrate WS)     pure, 43 tests      (native surface)   + Discord/Telegram
                          ▲                                        receipt
                          └── getAlert(id) ◄── EVM eth_call ◄──────┘
                              (reads our own subscriptions, free)
```
- Subscriptions live **on-chain** in `AlertRegistry` (`0xeae1…429d`, V3 testnet);
  the loop ABI-decodes them (`getAlert`, 9-word struct) every
  `loop.checkEveryBlocks` blocks.
- Kinds evaluated: `ValidatorUptime` (activity share vs fair share, bps),
  `EraRotation` (once per era), `SlashEvent`, `LargeTransfer` (slash/transfer
  scanners land in Package 08; the decision core already supports them).
- Every fire is a native `revive.call` → `recordFire(id)` (~0.015 tPOT), so the
  on-chain `fireCount`/`lastFiredAt` and the `AlertFired` event are a
  tamper-evident ledger of what the watcher detected. Local cooldown
  (`loop.cooldownBlocks`) plus the contract's one-fire-per-block rule prevent
  spam.
- `loop-state.json` (in `dataDir`) survives restarts: per-subscription last
  fired block/era + the append-only fire ledger (off-chain twin of `fireCount`).

### Enabling real (non-dry-run) firing
```bash
export POTWATCH_LOOP_MNEMONIC="<seed phrase of a funded loop wallet>"   # never commit
# config.json → loop.dryRun: false
npm start -- --testnet
```
Safety defaults: `loop.dryRun: true` (evaluate + log only) and the mnemonic is
read **only** from the environment (`loop.mnemonicEnv`), never from disk or
logs. `@polkadot/api` is imported lazily — detection and the dashboard data
path never load it.

### Alert management CLI (Package 09)
```bash
npm run alert -- list                                  # EVM read, free
POTWATCH_LOOP_MNEMONIC="…" npm run alert -- register 0 9000 0 [targetHex32]
POTWATCH_LOOP_MNEMONIC="…" npm run alert -- cancel 3
```
Writes use the native surface (~0.02 tPOT). The dashboard's 🧙 Alert Wizard
builds the same calldata in-browser and can either copy this command or send
via an EVM wallet (with a fee warning — EVM surface costs ~100× more).

### One-shot fire (demo / mechanism proof)
```bash
POTWATCH_LOOP_MNEMONIC="…" npm run fire -- 2        # recordFire(#2) on-chain
npm run fire -- 2 --dry                             # evaluate only, no tx
```
First loop receipt: tx `0x722b270c…99039ddf`, block **206608** (V3 testnet),
events `revive.ContractEmitted` + `system.ExtrinsicSuccess` — see
[`contracts/deployment.json`](../contracts/deployment.json) → `loopFires`.

## Networks
| Network | Substrate WS RPC |
|---|---|
| Mainnet | `wss://mainnet.portaldot.io` |
| **V3 Testnet (hackathon)** | `wss://test-node-v3.portaldot.dev` — run with `npm start -- --testnet` |

Testnet facts (verified live): chain `PortaldotV3 Test`, specName `portaldot-v3`,
specVersion 3002, token `tPOT` (14 decimals, ss58 42), 2 validators.

## Configuration (`config.json`)
| Key | Description |
|---|---|
| `rpcUrl` | Substrate WebSocket RPC (mainnet by default) |
| `testnetRpcUrl` | official V3 testnet WS endpoint (used with `--testnet`) |
| `dataDir` | where JSONL stores are written |
| `discordWebhook` | optional — alerts and loop receipts also POST here |
| `alerts` | active rules: `era_rotation`, `validator_inactive`, `finality_lag` |
| `loop.enabled` | master switch for the autonomous on-chain loop |
| `loop.evmRpcUrl` | EVM HTTP RPC used to read AlertRegistry subscriptions |
| `loop.contract` | AlertRegistry H160 address |
| `loop.checkEveryBlocks` | evaluation cadence (blocks) |
| `loop.cooldownBlocks` | local per-subscription cooldown |
| `loop.dryRun` | `true` = evaluate + log only; `false` = submit recordFire |
| `loop.mnemonicEnv` | env var name holding the loop wallet seed phrase |

## What it produces (in `data/`)
| File | Content |
|---|---|
| `blocks.jsonl` | every block: number, hash, parent, extrinsics, **author (decoded from BABE digest)**, finality |
| `eras.jsonl` | era/session rotations with block ranges |
| `issuance.jsonl` | POT total-issuance snapshots (reward derivation) |
| `validator-stats.json` | per-validator: blocks authored, share %, last seen, inactivity |
| `health.json` | composite score: finality, availability, block time, decentralization (HHI), security |
| `loop-state.json` | autonomous-loop memory + append-only fire ledger |
| `state.json` | last-run snapshot for restarts |

## Tests
```bash
npm test    # 59 tests: twox/SCALE/ss58 vectors, health math, validator metrics,
            # loop decisions (ABI decode, cooldowns, all four kinds), alert engine,
            # metadata walker (cursor, variants, newtypes, shape discovery),
            # event extraction, stake HHI + churn, register/cancel calldata
```
Plus `contracts/`: `npx hardhat test` → 6/6. **69 tests across the repo.**

## Module map
```
src/twox.ts       → pure-TS Substrate primitives (XXH64/twox128, SCALE, ss58) — zero deps
src/rpc.ts        → minimal WS JSON-RPC client (calls + subscriptions)
src/blocks.ts     → block ingestion + BABE PreRuntime author decoding
src/eras.ts       → era/session/issuance readers
src/validators.ts → uptime/activity metrics engine
src/health.ts     → 0–100 network health score
src/alerts.ts     → rule evaluator + Discord delivery (+ loop receipts)
src/walker.ts     → FRAME metadata v14 parser + generic SCALE value decoder
src/events.ts     → System.Events decoder + slash/transfer/session extraction
src/security.ts   → stake HHI, validator churn, slash feed, health history
src/evm.ts        → retry-hardened EVM JSON-RPC reader + subscription loader
src/loop.ts       → autonomous loop: ABI decode, pure fire decisions, durable state
src/firer.ts      → native-surface recordFire submitter (lazy @polkadot/api)
src/fire-once.ts  → one-shot on-chain fire CLI (demo / mechanism proof)
src/alert-cli.ts  → subscription management CLI (list/register/cancel, native)
src/store.ts      → JSONL persistence
src/index.ts      → orchestrator (24/7 loop + autonomous alert loop)
src/selfcheck.ts  → primitives test suite
```
