# @pot-watch/contracts

`AlertRegistry` — on-chain alert subscriptions for POT Watch, targeting the
**Portaldot Network V3.0 EVM** (chain ID `420420777`, token `tPOTv3`, 14 decimals).

Users register watch rules (validator uptime, era rotation, slash events, large
transfers) with a delivery channel. The POT Watch watcher mirrors the rules,
evaluates them against live chain state, delivers Discord/Telegram notifications,
and calls `recordFire()` so every alert leaves a verifiable on-chain trail.

## Quick start
```bash
npm install
npm test                 # 6 unit tests (Hardhat network)
npm run build            # compile
```

## Deployment
```bash
cp .env.example .env     # fill in DEPLOYER_PK + PORTALDOT_TESTNET_RPC
npm run deploy:testnet   # → prints address + tx hashes, writes deployment.json
```
`deployment.json` (address, deployment tx hash, demo-interaction tx hash) is the
evidence file for the hackathon submission.

## Verified status
- ✅ Compiles with solc 0.8.24 (optimizer 200 runs)
- ✅ 6/6 unit tests passing (registration, ownership, cancellation, per-block
  fire cooldown, stats, error paths)
- ✅ Full deploy → interact → evidence pipeline rehearsed on local EVM
- ✅ Official V3 testnet EVM RPC verified live (chain ID `420420777`, 2026-10-17):
  `https://test-evm-rpc-v3.portaldot.dev`
- ⏳ Live deploy awaits funded deployer account (tPOT faucet via Discord ticket)

## Network facts (verified 2026-10-17)
| Item | Value |
|---|---|
| Substrate WS RPC | `wss://test-node-v3.portaldot.dev` (chain `PortaldotV3 Test`, specName `portaldot-v3`, specVersion 3002) |
| EVM JSON-RPC | `https://test-evm-rpc-v3.portaldot.dev` |
| Chain ID | `420420777` |
| Token | `tPOT` — 14 decimals, ss58 format 42 |
| Explorer | https://node-console.portaldot.dev |

Note: the downloadable `portaldot_dev` binary is a **V2 node without EVM RPC**
(verified: 93 RPC methods, zero `eth_*`) — EVM only exists on the V3 testnet above.
