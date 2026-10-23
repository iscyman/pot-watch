# POT Watch — Hackathon Check-in (Oct 2026)

Portaldot Hacker House 2026 · Track: **Node Operations & Tooling** · Repo: https://github.com/iscyman/pot-watch

## Current project progress

- **Watcher engine — done & live.** TypeScript service streaming blocks/eras/sessions from Substrate RPC on **both mainnet and the V3 testnet**; BABE authorship decoding; per-validator uptime; composite health score (0–100); Discord alert delivery; JSONL persistence; self-check suite 9/9.
- **AlertRegistry smart contract — deployed & exercised on testnet.** Solidity 0.8.24 (london target). On-chain alert subscriptions with kinds, channels, thresholds, permissionless `recordFire` (per-block cooldown) and fire statistics. 6/6 unit tests. Three finalized on-chain interactions with Solidity events decoded from `revive.ContractEmitted`; EVM-side reads verified via `eth_call`.
- **Native deployment tooling — open-sourced.** `native-deploy.cjs` / `native-interact.cjs` / `decode-emitted.cjs` reproduce the full deploy→interact→decode pipeline on the V3 testnet.
- **Dual fee-model research — documented.** Same deploy costs ~289 tPOT via the EVM surface vs ~0.36 tPOT natively (~800×); full analysis with measured numbers in [`DEPLOYMENT.md`](DEPLOYMENT.md).
- **Live dashboard — shipped.** Backend-free, dependency-free static site (GitHub Pages) reading both RPCs directly from the browser: live block stream, era/session/validator state, health score, on-chain alert center, decoded event feed, deployment evidence panel → https://iscyman.github.io/pot-watch/

## Testnet deployment information

| Item | Value |
|---|---|
| Contract address | `0xeae1fb99ac651fd8a8bc23fb65dc51acb925429d` |
| Deploy tx hash | `0xcbf48e01dd166a0fd73b08942718049c87444652c82ad4cc11b7899f020fd8d3` |
| Deploy block | 133258 (finalized) |
| Explorer link | https://node-console.portaldot.dev/#/explorer/query/0x83d9687785f9ebc481bf713d0d52d6c4b5e9d957871bae5a7fd8b1f58fba25a3 |
| Identity mapping tx | `0x04969e168397f3486c2aa84dbe7e73fc263ae129085f30073599c0aad88fafdf` |
| Interaction txs | `0x0fedf0f6994f333df8040da567d865a2f835ee638a2b5bca3f53f54505060814` (registerAlert #1, block 133316) · `0x38b85ab440ce8c7942ddd0c77b8874037c1cd91c8f9215c49c9aca504ba42c39` (registerAlert #2, block 133319) · `0x39b60c92f4fe2566e7d58771da48af7f73b4a19625dabe72977695b3531e84ad` (recordFire #1, block 133322) |
| Machine-readable record | [`contracts/deployment.json`](../contracts/deployment.json) |

## Demo material

**Live DApp link:** https://iscyman.github.io/pot-watch/ — real-time data, no backend; contract panels read the deployed AlertRegistry live.

## Outstanding items (plan → Nov 6 freeze)

1. **Security analytics** (Oct 28–31): slash-event detection + large-transfer watcher feeding the on-chain `SlashEvent`/`LargeTransfer` alert kinds; Telegram delivery channel.
2. **Persistent uptime history**: watcher → dashboard export so validator uptime shows 24h/7d windows, not just the live session.
3. **Demo video** (≤3 min) and final pitch deck (Nov 1–3).
4. Dashboard polish: mobile layout, alert-registration UX explainer, mainnet/testnet switcher.

## Development record

Continuous commit history since Oct 17 (scaffold → watcher → contracts → deployment → dashboard); all code produced during the hackathon window (Oct 14 – Nov 6). See the repo's commit list and [`ROADMAP.md`](ROADMAP.md).
