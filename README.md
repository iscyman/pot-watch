<p align="center"><img src="docs/logo.png" alt="POT Watch mark" width="110" /></p>

# ⬡ POT Watch

**Node health monitoring & staking analytics for Portaldot** — a live watcher engine, an autonomous on-chain alert loop, and a zero-backend dashboard.

Built for the **Portaldot Hacker House 2026** · *Node Operations & Tooling* track.

| Live on Portaldot V3 Testnet | |
|---|---|
| 🖥️ **Dashboard** | https://iscyman.github.io/pot-watch/ |
| 📜 **AlertRegistry contract** | [`0xeae1fb99ac651fd8a8bc23fb65dc51acb925429d`](https://node-console.portaldot.dev/#/explorer/query/0x83d9687785f9ebc481bf713d0d52d6c4b5e9d957871bae5a7fd8b1f58fba25a3) |
| 🧾 Deploy tx | `0xcbf48e01dd166a0fd73b08942718049c87444652c82ad4cc11b7899f020fd8d3` (block 133258, finalized) |
| ⛓️ Chain | `wss://test-node-v3.portaldot.dev` · EVM RPC `https://test-evm-rpc-v3.portaldot.dev` · chainId 420420777 |
| 🗂️ Machine-readable evidence | [`contracts/deployment.json`](contracts/deployment.json) |

## What it does

- **Watcher engine** (`watcher/`) — TypeScript, zero heavy dependencies. Streams live blocks, tracks eras/sessions, decodes BABE authorship, computes per-validator uptime and a composite **network health score** (finality 25% · availability 30% · block time 20% · decentralization 15% · security 10%), and fires alerts to Discord/Telegram. Runs against **mainnet and testnet** (`npm start -- --testnet`).
- **Autonomous on-chain alert loop** (`watcher/src/loop.ts`, `evm.ts`, `firer.ts`) — the watcher reads its own subscriptions from the deployed AlertRegistry, evaluates them against live chain state, and records every fire back on-chain via `recordFire` on the **native surface (~0.015 tPOT)**. Detection → on-chain receipt → channel delivery with no human in the circuit; `fireCount`/`AlertFired` on-chain are the tamper-evident ledger. First receipt: block **206608**, tx `0x722b270c…99039ddf`.
- **AlertRegistry contract** (`contracts/`) — Solidity 0.8.24, deployed live on the Portaldot V3 testnet. On-chain alert subscriptions: kinds (validator uptime, era rotation, slash events, large transfers), channels, thresholds, permissionless `recordFire` with per-block cooldown, and per-alert fire statistics. 6/6 unit tests; verified interactions and decoded events on-chain.
- **Security analytics** (`watcher/src/walker.ts`, `events.ts`, `security.ts` + dashboard mirror) — a zero-dependency FRAME-metadata walker decodes **any** storage value or event by chain type: live stake concentration (Staking.Ledger → Herfindahl index), validator churn per session, slash-event feed, and large-transfer scan. The slash/transfer scanners feed the autonomous loop's `SlashEvent` / `LargeTransfer` kinds with real chain data.
- **Dashboard v1.1** (`docs/`) — the live site above. **Backend-free and dependency-free**: your browser talks directly to the Substrate JSON-RPC and the EVM JSON-RPC (raw `fetch`, hand-rolled SCALE/twox128/ss58/BABE decoding, one vendored MIT blake2b). Shows the live block stream, era/session state, validator activity, health score, the contract's on-chain alerts + decoded events, the **security analytics panel** (stake HHI, bonded table, slash/transfer scan), a **live on-chain fire feed** (decoded `revive.ContractEmitted` → `AlertFired`, the loop's receipts appearing in real time), **block-time & health sparklines**, an **🧙 Alert Wizard** that creates on-chain subscriptions (copy-command for the native surface, or MetaMask with an honest fee warning), and a mobile layout pass.

## Notable: Portaldot's dual fee model 🔎

Deploying the same contract costs **~289 tPOT via the EVM/MetaMask surface** but only **~0.36 tPOT via the native surface** (`Revive.instantiate_with_code`) — an ~800× difference that faucet-funded teams hit as a wall. We mapped the whole model (weight↔gas scaling, storage deposits, EVM visibility of native writes, event indexing gaps) and open-sourced working tooling so every team can deploy on a faucet budget:

- 📄 Full analysis: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- 🛠️ Tooling: [`contracts/scripts/native-deploy.cjs`](contracts/scripts/native-deploy.cjs), [`native-interact.cjs`](contracts/scripts/native-interact.cjs), [`decode-emitted.cjs`](contracts/scripts/decode-emitted.cjs)

## Quick start

```bash
# watcher — live network monitoring + autonomous on-chain alert loop
cd watcher && npm install && npm run selfcheck   # 9/9 primitive checks
npm test                                         # 63 unit tests (69 repo-wide)
npm start                                        # mainnet
npm start -- --testnet                           # V3 testnet + alert loop (dry-run by default)

# contracts — tests + testnet tooling
cd contracts && npm install
npx hardhat test                                 # 6/6 passing
npm run testnet:deploy                           # native deploy pipeline (see .env.example)

# dashboard — just open docs/index.html (or any static server)
```

## Business model

Freemium node-ops intelligence: free public dashboard → **Pro alert
subscriptions settled on-chain in POT** (the AlertRegistry already holds the
subscription ledger) → B2B validator SLA reports & white-label dashboards →
historical health/fee-model data API. Full revenue math and ecosystem
fit: [`BUSINESS.md`](BUSINESS.md).

## Project docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design & data flow
- [`BUSINESS.md`](BUSINESS.md) — business model, pricing & ecosystem economics
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phase plan
- [`docs/CHECKIN.md`](docs/CHECKIN.md) — hackathon check-in: progress, evidence, outstanding items
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — testnet deployment report & fee-model analysis

## License

MIT — see [LICENSE](LICENSE).
