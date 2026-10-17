# POT Watch — Roadmap

## Phase 1 — Foundation (Oct 14–17)
- [x] Repo scaffold, architecture, roadmap
- [ ] `watcher` core: RPC client, block subscription, era/session tracker
- [ ] Local testnet node running, dev accounts funded
- [ ] SQLite store: blocks, eras, validator stats
- [ ] Validator metrics engine (uptime, blocks authored, misses)

## Phase 2 — Dashboard MVP (Oct 18–23) — check-in by Oct 24
- [ ] React + Vite dashboard: network pulse, validator table, staking panel
- [ ] WebSocket live updates
- [ ] Public deployment (demo URL)
- [ ] Check-in submission with live demo

## Phase 3 — Smart contract + alerts (Oct 25 – Nov 3)
- [ ] `AlertRegistry` Solidity contract: compile, unit-test
- [ ] Deploy on Portaldot testnet → record address + tx hash
- [ ] Alert watcher: condition matching → Discord/Telegram delivery
- [ ] Alert management UI

## Phase 4 — Security analytics & polish (Nov 3–5)
- [ ] Slashing/churn/HHI analytics, network health score
- [ ] Docs, README finalization, screenshots
- [ ] Pitch deck + demo video (≤3 min)

## Final submission — Nov 6
