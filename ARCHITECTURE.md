# POT Watch — Architecture

## 1. System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PORTALDOT NETWORK                             │
│   mainnet: wss://mainnet.portaldot.io  ·  testnet: (kick-off)        │
│   local dev: portaldot_dev --dev  (v2.0.0, 6s blocks, BABE)          │
└───────────────┬──────────────────────────────────────────────────────┘
                │ Substrate JSON-RPC (WebSocket)
                ▼
┌──────────────────────────────┐
│  WATCHER SERVICE (core)      │   runs 24/7
│  ─ block subscription        │   chain_subscribeNewHeads
│  ─ event ingestion           │   state_subscribeStorage / getEvents
│  ─ era/session tracker       │
│  ─ validator metrics engine  │   uptime, blocks authored, misses
│  ─ alert evaluator           │   matches chain state vs alert rules
└──────┬───────────────┬───────┘
       │               │
       ▼               ▼
┌────────────┐  ┌─────────────────────────────┐
│ SQLite     │  │ ALERT DELIVERY              │
│ time-series│  │ Discord webhook · Telegram  │
│ + state DB │  │ (fired by alert evaluator)  │
└──────┬─────┘  └──────────────┬──────────────┘
       │                       │
       ▼                       ▲
┌────────────────────┐         │  reads alert rules
│ DASHBOARD (web)    │         │
│ Vite + React + TS  │─────────┘
│ WebSocket live UI  │
└────────────────────┘
                ▲
┌───────────────┴──────────────────────────────────────────┐
│ AlertRegistry SMART CONTRACT (Solidity on Portaldot EVM) │
│ deployed on testnet — stores user alert subscriptions    │
│ registerAlert() · cancelAlert() · listAlerts()           │
│ events: AlertRegistered / AlertCancelled                 │
└──────────────────────────────────────────────────────────┘
```

## 2. Verified chain facts

| Fact | Mainnet | V3 Testnet |
|---|---|---|
| Substrate WS RPC | `wss://mainnet.portaldot.io` ✅ | `wss://test-node-v3.portaldot.dev` ✅ |
| EVM JSON-RPC | — | `https://test-evm-rpc-v3.portaldot.dev` ✅ (chain ID 420420777) |
| Chain / spec | Portaldot Mainnet | PortaldotV3 Test · specName `portaldot-v3` · specVersion 3002 |
| Consensus | BABE, ~6s blocks | BABE |
| Token | POT, 14 decimals, ss58 42 | tPOT, 14 decimals, ss58 42 |
| Validators | 10 | 2 |
| Explorer | — | https://node-console.portaldot.dev |
| Local node | `portaldot_dev` v2.0.0 boots `--dev` (no EVM — V2 build) | — |

### Storage keys verified working
- `Session::Validators` → Vec<AccountId> (authoritative validator set)
- `Session::CurrentIndex` → u32
- `Staking::CurrentEra` → u32
- `Balances::TotalIssuance` → u128 (14 decimals)
- `Timestamp::Now` → u64 ms
- Note: `Staking::EraValidatorReward` is empty — rewards/APR are derived from
  era points + issuance delta (watcher module `rewards.ts`)

## 3. Components

| Component | Stack | Purpose |
|---|---|---|
| `watcher` | TypeScript + polkadot-js | ingest chain state, compute metrics |
| `store` | SQLite | blocks, eras, validator stats, alert log |
| `dashboard` | Vite + React + TS | live ops console UI |
| `contracts` | Solidity → Portaldot EVM | AlertRegistry (on-chain alert rules) |
| `alert-delivery` | Discord webhook + Telegram bot | notification fan-out |

## 4. Data model (SQLite)

```sql
blocks(id, number, hash, parent_hash, ts, extrinsic_count, author, weight_pct)
eras(id, era_index, started_at, session_start, session_end)
validator_stats(era_index, validator_ss58, blocks_authored, uptime_pct, stake_raw)
alerts(id, owner, watch_target, condition_json, channel, registered_tx, active)
alert_fires(id, alert_id, fired_at, payload_json, delivered)
health_snapshots(ts, finality_lag, availability, hhi, block_time_var, score)
```

## 5. AlertRegistry contract interface (draft)

```solidity
interface AlertRegistry {
  struct Alert { address owner; uint8 kind; bytes32 target; uint64 threshold; uint8 channel; bool active; }
  function registerAlert(uint8 kind, bytes32 target, uint64 threshold, uint8 channel) external returns (uint256);
  function cancelAlert(uint256 id) external;
  function listAlerts(address owner) external view returns (Alert[] memory);
  event AlertRegistered(uint256 indexed id, address indexed owner, uint8 kind);
  event AlertCancelled(uint256 indexed id);
}
// kinds: 0=validator uptime  1=era rotation  2=slash event  3=large transfer
// channels: 0=discord  1=telegram
```
