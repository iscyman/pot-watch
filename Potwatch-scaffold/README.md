# POT Watch ⬡

**Node operations & staking intelligence for Portaldot Network.**

POT Watch is the control tower for Portaldot: a live network dashboard, validator health
monitoring, staking analytics, and an on-chain alert registry that delivers notifications
to Discord and Telegram.

Built for the **Portaldot Hacker House 2026** — Node Operations & Tooling track.

## What it does

| Module | Description |
|---|---|
| 🌐 Network Pulse | Live block stream, era/session tracker, finality lag, TPS |
| 🛡️ Validator Health | Uptime tracking, blocks authored, missed-block detection |
| 💰 Staking Analytics | Stake distribution, estimated APR, concentration risk (HHI) |
| 🔔 Alert Engine | On-chain `AlertRegistry` contract + Discord/Telegram notifications |
| 💓 Health Score | Composite network score: availability, finality, slashes, variance |

## Chain facts (verified against live RPC)

- Mainnet WS: `wss://mainnet.portaldot.io` (BABE consensus, ~6s blocks)
- Token: `POT` — **14 decimals**, ss58 format 42
- Validator set: 10 validators (`Session::Validators`)
- Key state decoded: block height, active/current era, session index, total issuance

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design, data model and
the `AlertRegistry` contract interface.

## Roadmap

See [docs/ROADMAP.md](./docs/ROADMAP.md).

## Project structure (target)

```
watcher/        → chain-data ingestion & metrics service (TypeScript)
store/          → SQLite schema & persistence layer
dashboard/      → React + Vite web UI (WebSocket live updates)
contracts/      → AlertRegistry (Solidity, Portaldot EVM)
docs/           → roadmap, runbooks
```

## Status

🚧 Active development — day 1 of the Hacker House build period (Oct 14 – Nov 6, 2026).

## License

MIT
