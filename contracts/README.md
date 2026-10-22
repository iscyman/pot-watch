# @pot-watch/contracts

`AlertRegistry` — on-chain alert subscriptions for POT Watch, **live on the
Portaldot V3 testnet** (EVM chain ID `420420777`, token `tPOT`, native 14 decimals).

Users register watch rules (validator uptime, era rotation, slash events, large
transfers) with a delivery channel. The POT Watch watcher mirrors the rules,
evaluates them against live chain state, delivers Discord/Telegram notifications,
and calls `recordFire()` so every alert leaves a verifiable on-chain trail.

## ✅ Live on Portaldot V3 testnet (2026-10-21)

| | |
|---|---|
| **Contract** | `0xeae1fb99ac651fd8a8bc23fb65dc51acb925429d` |
| **Deploy tx** | `0xcbf48e01dd166a0fd73b08942718049c87444652c82ad4cc11b7899f020fd8d3` (block 133258, finalized) |
| **Method** | `Revive.instantiate_with_code` (native surface — see *Why native?* below) |
| **Verified** | `eth_getCode` → 3,429 bytes via EVM RPC · `eth_call` reads (`activeAlertCount` = 2, `getAlert(1)`) · 3 finalized interactions with decoded `AlertRegistered`/`AlertFired` events |
| **Evidence** | [`deployment.json`](./deployment.json) · full analysis in [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) |

## Quick start
```bash
npm install
npm test                 # 6 unit tests (Hardhat network)
npm run build            # compile (solc 0.8.24, evmVersion: london)
```

## Deployment (two surfaces, one contract)

**Native surface (used for the live deploy — ~10,000× cheaper here):**
```bash
# requires native-wallet.json (sr25519, gitignored) funded with ~400 tPOT
node scripts/native-deploy.cjs     # map_account → dry-run → instantiate → deployment.json
node scripts/native-interact.cjs   # registerAlert ×2 + recordFire + EVM-side read checks
node scripts/decode-emitted.cjs    # decode native ContractEmitted → Solidity events
```

**EVM surface (standard Hardhat — see the cost caveat in docs/DEPLOYMENT.md):**
```bash
cp .env.example .env     # DEPLOYER_PK + PORTALDOT_TESTNET_RPC
npm run deploy:testnet
```

### Why native? (measured, not guessed)
On spec 3002 the EVM RPC prices gas in weight-scale units with a ~35,890 wei
base fee: deploying AlertRegistry through `eth_sendRawTransaction` estimates at
**~289 real tPOT** (and even an 8-byte contract ~140 tPOT), while the native
`Revive.instantiate_with_code` path charged a **0.36 tPOT fee** plus a
**refundable 284.4 tPOT deposit hold**. Faucet-scale wallets must deploy
natively — the contract is identical and fully visible to EVM tooling
(`eth_getCode`/`eth_call` verified).

## Verified status
- ✅ **LIVE on V3 testnet** — address, tx hash, block, explorer links in `deployment.json`
- ✅ Compiles with solc 0.8.24 (optimizer 200 runs, `evmVersion: london`)
- ✅ 6/6 unit tests passing (registration, ownership, cancellation, per-block
  fire cooldown, stats, error paths)
- ✅ Cross-surface proven: written via native Revive, read via standard `eth_call`
- ✅ Solidity event stream decoded from native `revive.ContractEmitted`
  (note: `eth_getLogs` does not index native-surface writes on spec 3002 —
  event ingestion uses Substrate WS; state reads work from any Ethereum tooling)

## Network facts (verified live)
| Item | Value |
|---|---|
| Substrate WS RPC | `wss://test-node-v3.portaldot.dev` (chain `PortaldotV3 Test`, specName `portaldot-v3`, specVersion 3002) |
| EVM JSON-RPC | `https://test-evm-rpc-v3.portaldot.dev` |
| Chain ID | `420420777` |
| Token | `tPOT` — **native 14 decimals**; EVM surface displays 18 decimals (`nativeToEthRatio = 10000`) |
| Explorer | https://node-console.portaldot.dev |
| Runtime revive config | `allowEVMBytecode = true`, `autoMap = true`, `depositPerByte = 0.06 tPOT`, ED = 0.1 tPOT |

Note: the downloadable `portaldot_dev` binary is a **V2 node without EVM RPC**
(verified: 93 RPC methods, zero `eth_*`) — EVM only exists on the V3 testnet above.
