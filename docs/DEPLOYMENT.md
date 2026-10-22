# POT Watch — Portaldot V3 Testnet Deployment

**Date:** 2026-10-21 · **Chain:** `PortaldotV3 Test` (specName `portaldot-v3`, specVersion 3002, tx version 2, ss58 42)
**Endpoints:** `wss://test-node-v3.portaldot.dev` (Substrate) · `https://test-evm-rpc-v3.portaldot.dev` (EVM, chainId 420420777) · explorer `https://node-console.portaldot.dev`

## 1. Evidence summary

| Item | Value |
|---|---|
| **Contract** | `AlertRegistry` (Solidity 0.8.24, `evmVersion: london`, optimizer 200) |
| **Address** | `0xeae1fb99ac651fd8a8bc23fb65dc51acb925429d` |
| **Deploy tx** | `0xcbf48e01dd166a0fd73b08942718049c87444652c82ad4cc11b7899f020fd8d3` |
| **Block** | 133258 (finalized) — [explorer](https://node-console.portaldot.dev/#/explorer/query/0x83d9687785f9ebc481bf713d0d52d6c4b5e9d957871bae5a7fd8b1f58fba25a3) |
| **Method** | `Revive.instantiate_with_code` (native extrinsic, EVM bytecode — runtime has `allowEVMBytecode = true`) |
| **Code visible via EVM RPC** | `eth_getCode` → 3,429 bytes ✅ |
| **Deploy fee** | 0.3597 tPOT + refundable deposit holds (code 209.94 + storage ≈ 74.5) |
| **Machine-readable evidence** | [`contracts/deployment.json`](../contracts/deployment.json) |

### Wallets & roles
| Wallet | Address | Role |
|---|---|---|
| Native deployer (sr25519) | `5FWLjJ3tX3FYHaj3AX1BvwfivBchcrPJiigFy1vfmqRU26Jb` | signs `map_account`, `instantiate_with_code`, `call` |
| ↳ mapped Revive H160 | `0x6920eceF4a2eDbC6be94f0572b19bCcf0f13Cfe5` | contract owner / alert owner (auto-derivation verified: `keccak256(pubkey)[12:]`) |
| EVM wallet (secp256k1) | `0x8D2988e34CB0Ad222435d9992d35f39F9144d6fC` (native `5FFn…HsEe`) | EVM-surface reads; first project tx `0xc3cb4558…` (block 132459) |

### Finalized interaction txs (all via native `Revive.call`, ~0.02–0.4 tPOT each)
| # | Call | Tx | Block | Decoded Solidity event |
|---|---|---|---|---|
| 1 | `registerAlert(ValidatorUptime, validator 0x849a…, 9000 bps, Discord)` | `0x0fedf0f6994f333df8040da567d865a2f835ee638a2b5bca3f53f54505060814` | 133316 | `AlertRegistered(id=1, …)` |
| 2 | `registerAlert(EraRotation, network-wide, Telegram)` | `0x38b85ab440ce8c7942ddd0c77b8874037c1cd91c8f9215c49c9aca504ba42c39` | 133319 | `AlertRegistered(id=2, …)` |
| 3 | `recordFire(1)` | `0x39b60c92f4fe2566e7d58771da48af7f73b4a19625dabe72977695b3531e84ad` | 133322 | `AlertFired(id=1, blockNumber=133322)` |

Alert target `0x849a279f…` is the live session validator `5F4ZyJJ8R3QHZKRLAfDXdUuVE4w3Q7uq7tCNfAtvf2XEBfYY` — AccountId32 maps into `bytes32` 1:1.

## 2. The dual fee model (measured — this is the part nobody documents)

Spec 3002 runs **pallet-revive behind a Frontier-style EVM RPC**, and the two
surfaces price identical work ~10,000× apart:

| Fact | Value (measured) |
|---|---|
| Native token scale | 14 decimals (explorer, `system.account`) |
| EVM balance scale | 18 decimals; `eth_getBalance(H160) = (native_free − ED) × 10,000` (verified against two independent account pairs) |
| EVM base fee | ~35,890 wei per *weight-scale* gas unit (`gasScale = 5`, `nativeToEthRatio = 10000`, `maxEthExtrinsicWeight = 9e17`) |
| 0-value EVM transfer | est. 3.43e11 gas → 3.15e11 used → **0.0113 tPOT** |
| AlertRegistry deploy via EVM | est. 8.06e15 gas → **~289 tPOT** — pool rejects any `gasLimit` that fits a faucet wallet; below the estimate the interpreter traps (`ContractTrapped`) |
| Minimal 8-byte contract via EVM | est. 3.89e14 gas → **~140 tPOT** (EVM deploy floor) |
| Same deploy via `Revive.instantiate_with_code` | weightRequired `refTime 1.73e8 / proofSize 10,673` → **0.36 tPOT fee** + 284.4 tPOT *refundable* deposit hold |
| Native `Revive.call` (registerAlert) | ~1.25e9 refTime → ~0.1–0.4 tPOT + item deposits (`depositPerItem = 0.15 tPOT`) |
| Existential deposit | 0.1 tPOT |

**Consequence:** faucet-scale teams must deploy natively (sr25519 + `map_account`
or autoMap), while the deployed contract remains fully usable from standard
Ethereum tooling for **reads** (`eth_call`, `eth_getCode`) — POT Watch's dashboard
exploits exactly this split: cheap native writes, universal EVM reads.

### Tx-format rules we reverse-engineered for the EVM surface
- Legacy (type-0) txs only — EIP-1559 type-2 → `{code: 1010, "Invalid Transaction"}`
- `gasLimit` is weight-scale: use `eth_estimateGas × 1.2–2` (Ethereum-scale limits are rejected)
- `gasPrice ≥ base fee` (~35,890); lower values are rejected by the pool
- Pool pre-checks `gasLimit × gasPrice ≤ balance`

### Event/log surface behaviour
- Native writes emit `revive.ContractEmitted(contract, data, topics)` — decodes
  1:1 to standard Solidity events via `ethers.Interface.parseLog` (see
  `contracts/scripts/decode-emitted.cjs` and `deployment.json →
  solidityEventsDecodedFromNative`).
- `eth_getLogs` / `eth_getTransactionReceipt` do **not** index native-surface
  writes on spec 3002 → the POT Watch watcher ingests contract events over
  Substrate WS (which it already speaks for chain monitoring).

## 3. Reproduce

```bash
cd contracts && npm install
npm test                                     # 6/6 unit tests
npm run build                                # london-targeted bytecode

# native deploy (funded sr25519 wallet in native-wallet.json — gitignored)
node scripts/native-deploy.cjs               # map_account → ReviveApi dry-run → instantiate → deployment.json
node scripts/native-interact.cjs             # registerAlert ×2 + recordFire + eth_call verification
node scripts/decode-emitted.cjs              # ContractEmitted → AlertRegistered/AlertFired
```

The deploy script dry-runs everything (`ReviveApi.instantiate` + signed
`system_dryRun`) before submitting, sizes `weightLimit` and
`storageDepositLimit` from the runtime's own `weightRequired` /
`maxStorageDeposit` (a `null` deposit limit is **not** "unlimited" on this
chain — it fails with `StorageDepositLimitExceeded`), and verifies the result
through the EVM RPC afterwards.

## 4. Accounting (native deployer, real tPOT)

| Step | Amount |
|---|---|
| Faucet → `5FWL…26Jb` | +400.0000 |
| `map_account` (tx `0x04969e16…`) | −0.0109 |
| `instantiate_with_code` fee | −0.3597 |
| Code-upload deposit hold (`CodeUploadDepositReserve`) | −209.94 (held, refundable in principle) |
| Contract storage deposit hold | ≈ −74.5 (held) |
| 3 × `Revive.call` (fees + item deposits) | ≈ −0.6 |
| **Free balance after** | **≈ 114 tPOT** (sufficient for dozens more demo interactions) |
