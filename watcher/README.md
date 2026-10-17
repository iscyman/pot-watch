# @pot-watch/watcher

Chain-data ingestion & metrics engine for Portaldot Network.
Streams blocks over WebSocket RPC, tracks eras/sessions, computes validator
metrics + a composite health score, evaluates alerts, and persists everything
to `data/` (JSONL — SQLite migration lands with the dashboard API).

## Requirements
- Node.js **18+** (https://nodejs.org)

## Run
```bash
npm install
npm run selfcheck      # verifies xxhash/SCALE/ss58 primitives against ground truth
npm start              # streams live from mainnet (wss://mainnet.portaldot.io)
npm start -- --testnet # streams from the official V3 testnet instead
```

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
| `discordWebhook` | optional — alerts also POST here |
| `alerts` | active rules: `era_rotation`, `validator_inactive`, `finality_lag` |

## What it produces (in `data/`)
| File | Content |
|---|---|
| `blocks.jsonl` | every block: number, hash, parent, extrinsics, **author (decoded from BABE digest)**, finality |
| `eras.jsonl` | era/session rotations with block ranges |
| `issuance.jsonl` | POT total-issuance snapshots (reward derivation) |
| `validator-stats.json` | per-validator: blocks authored, share %, last seen, inactivity |
| `health.json` | composite score: finality, availability, block time, decentralization (HHI), security |
| `state.json` | last-run snapshot for restarts |

## Module map
```
src/twox.ts       → pure-TS Substrate primitives (XXH64/twox128, SCALE, ss58) — zero deps
src/rpc.ts        → minimal WS JSON-RPC client (calls + subscriptions)
src/blocks.ts     → block ingestion + BABE PreRuntime author decoding
src/eras.ts       → era/session/issuance readers
src/validators.ts → uptime/activity metrics engine
src/health.ts     → 0–100 network health score
src/alerts.ts     → rule evaluator + Discord delivery
src/store.ts      → JSONL persistence
src/index.ts      → orchestrator (24/7 loop)
src/selfcheck.ts  → primitives test suite
```
