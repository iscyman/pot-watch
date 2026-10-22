/**
 * POT Watch — native deployment to Portaldot V3 testnet.
 *
 * Why native and not plain `hardhat deploy` over the EVM RPC?
 *   On this chain, eth RPC "gas" is weight-scaled (nativeToEthRatio=10000, gasScale=5)
 *   and priced at a base fee of ~35,890 wei/gas-unit. Even an 8-byte contract
 *   estimates at ~3.9e14 gas-units (~140,000 tPOT) through the EVM surface, and
 *   maxEthExtrinsicWeight caps any EVM deploy below what AlertRegistry needs.
 *   The native Revive.instantiate_with_code path pays weightToFee instead:
 *   ~0.02 tPOT fee + ~220 tPOT of *refundable* code/storage deposits
 *   (depositPerByte = 0.06 tPOT). Same runtime, same contract — 10^7× cheaper.
 *
 * Flow (mirrors the officially demonstrated V3 pattern):
 *   1. Revive.map_account()            -> derive our H160 identity
 *   2. ReviveApi.call dry-run          -> weightRequired + storageDeposit
 *   3. Revive.instantiate_with_code    -> deploy EVM bytecode natively
 *   4. Instantiated event              -> contract address + tx hash + block
 *   5. eth_getCode over EVM RPC        -> prove EVM surface sees the contract
 *   6. deployment.json                 -> check-in evidence
 *
 * Requires: NODE_PATH pointing at a node_modules with @polkadot/api + @polkadot/keyring
 *           contracts/native-wallet.json  (gitignored — throwaway testnet wallet)
 *           contracts/artifacts/...       (hardhat compile)
 * Run:      NODE_PATH=/home/user/pjstmp/node_modules node scripts/native-deploy.cjs
 */
const path = require("path");
const fs = require("fs");

const WS = "wss://test-node-v3.portaldot.dev";
const EVM_RPC = "https://test-evm-rpc-v3.portaldot.dev";
const EXPLORER = "https://node-console.portaldot.dev";

const ROOT = path.resolve(__dirname, "..");
const walletFile = path.join(ROOT, "native-wallet.json");
const artifactFile = path.join(ROOT, "artifacts/contracts/AlertRegistry.sol/AlertRegistry.json");
const outFile = path.join(ROOT, "deployment.json");

const tPOT = (raw) => Number(raw) / 1e14;

async function evm(method, params) {
  const r = await fetch(EVM_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: { message: "NON-JSON (rate-limited?)" } }; }
}

(async () => {
  const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
  const wallet = JSON.parse(fs.readFileSync(walletFile, "utf8"));
  const artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
  const bytecode = artifact.bytecode; // full initcode; runtime has allowEVMBytecode=true

  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  const kp = keyring.addFromMnemonic(wallet.mnemonic);
  const A = kp.address;
  console.log(`native signer : ${A}`);
  console.log(`chain         : ${(await api.rpc.system.chain()).toString()} (spec ${api.runtimeVersion.specVersion})`);

  const { data: bal } = await api.query.system.account(A);
  console.log(`balance       : free ${tPOT(bal.free)} tPOT | reserved ${tPOT(bal.reserved)} tPOT`);
  if (bal.free.isZero()) {
    console.error("\nWallet not funded yet. Ask the Discord faucet to drip tPOT to the ss58 address above.");
    await api.disconnect();
    process.exit(2);
  }
  if (Number(bal.free) < 3e16) {
    console.error(`\nWARNING: free balance ${tPOT(bal.free)} tPOT may be below code+storage deposits (~250 tPOT for 3.4KB).`);
  }

  const results = {
    network: "portaldot_v3_testnet",
    chain: "PortaldotV3 Test",
    specVersion: Number(api.runtimeVersion.specVersion),
    wsEndpoint: WS,
    evmRpc: EVM_RPC,
    evmChainId: 420420777,
    explorer: EXPLORER,
    deployedAtUtc: new Date().toISOString(),
    deployer: {
      native: { address: A, type: "sr25519", role: "native deployer (Revive.instantiate_with_code)" },
      evm: { address: "0x8D2988e34CB0Ad222435d9992d35f39F9144d6fC", role: "EVM surface wallet (reads + optional EVM writes)" },
    },
    contract: { name: "AlertRegistry", solidity: "0.8.24", evmVersion: "london", optimizer: "200 runs" },
    steps: [],
  };

  // ---------- Step 1: map_account (idempotent) ----------
  let mappedH160 = null;
  {
    const tx = api.tx.revive.mapAccount();
    const signed = await tx.signAsync(kp);
    const dry = await api.rpc.system.dryRun(signed.toHex());
    const dryStr = dry.toString();
    if (dry.isError || /"err"/.test(dryStr)) {
      // already mapped, or transient -> inspect
      if (/already/i.test(dryStr)) {
        console.log("map_account   : already mapped (skipping)");
      } else {
        console.log("map_account   : dry-run said", dryStr.slice(0, 200), "— attempting submit anyway");
      }
    }
    if (!/already/i.test(dryStr)) {
      try {
        const hash = await tx.signAndSend(kp);
        await new Promise((res) => setTimeout(res, 8000));
        console.log(`map_account   : submitted ${hash.toHex()}`);
        results.steps.push({ step: "map_account", txHash: hash.toHex() });
      } catch (e) {
        console.log("map_account   : submit note:", e.message?.slice(0, 160));
      }
    }
    // find our derived H160 by scanning OriginalAccount (H160 -> AccountId32)
    const pubHex = "0x" + Buffer.from(kp.publicKey).toString("hex");
    const entries = await api.query.revive.originalAccount.entries();
    for (const [key, val] of entries) {
      const v = val.toString().toLowerCase();
      if (v === pubHex || v.includes(pubHex.slice(2, 42))) {
        mappedH160 = key.args[0].toString();
        break;
      }
    }
    console.log("mapped H160   :", mappedH160 || "(not found via OriginalAccount scan — will read from Instantiated event)");
  }

  // ---------- Step 2: dry-run the deployment for weight + deposit ----------
  let weightLimit = { refTime: 2_000_000_000_000n, proofSize: 5_000_000n };
  let sdep = 5n * 10n ** 16n; // 500 tPOT cap default
  try {
    const originHex = "0x" + Buffer.from(kp.publicKey).toString("hex");
    const EE32 = "0x8D2988e34CB0Ad222435d9992d35f39F9144d6fC" + "ee".repeat(12);
    // dedicated instantiate dry-run: (origin, value, gasLimit, storageDepositLimit, code{upload|existing}, data, salt)
    let dry = await api.call.reviveApi.instantiate(originHex, 0, weightLimit, null, { upload: bytecode }, "0x", null);
    let j = dry.toJSON ? dry.toJSON() : dry;
    // if our signer can't cover the dry-run (unfunded/fresh), size from the funded EVM-derived origin instead
    const unusable = !j.weightRequired || (BigInt(j.weightRequired.refTime || 0) === 0n && j.result && j.result.err);
    if (unusable) {
      console.log("dry-run from native signer unusable — re-running from funded EE origin");
      dry = await api.call.reviveApi.instantiate(EE32, 0, weightLimit, null, { upload: bytecode }, "0x", null);
      j = dry.toJSON ? dry.toJSON() : dry;
    }
    console.log("revive dry-run:", JSON.stringify(j).slice(0, 600));
    if (j && j.weightRequired) {
      const wr = j.weightRequired;
      weightLimit = {
        refTime: BigInt(Math.ceil(Number(wr.refTime) * 3)) + 10n ** 9n,
        proofSize: BigInt(Math.ceil(Number(wr.proofSize) * 3)) + 10n ** 4n,
      };
    }
    // storage_deposit_limit MUST cover maxStorageDeposit (null is NOT "unlimited" here — it errors 23)
    const maxSD = j && j.maxStorageDeposit && j.maxStorageDeposit.charge !== undefined ? BigInt(j.maxStorageDeposit.charge) : 0n;
    const actSD = j && j.storageDeposit && j.storageDeposit.charge !== undefined ? BigInt(j.storageDeposit.charge) : 0n;
    const basis = maxSD > actSD ? maxSD : actSD;
    if (basis > 0n) sdep = (basis * 101n) / 100n + 5n * 10n ** 13n; // +1% and 0.5 tPOT margin (actual ≤ max is runtime-guaranteed)
    if (j && j.result && j.result.err !== undefined) {
      console.log("NOTE: dry-run result Err —", JSON.stringify(j.result.err).slice(0, 160),
        "(err 23 = StorageDepositLimitExceeded → our computed cap fixes it; any other error: inspect before submitting)");
    }
  } catch (e) {
    console.log("dry-run failed (using defaults):", e.message?.slice(0, 200));
  }
  console.log(`weightLimit   : refTime ${weightLimit.refTime} | proofSize ${weightLimit.proofSize}`);
  console.log(`storageDepositLimit: ${tPOT(sdep)} tPOT cap`);

  // ---------- Step 3: instantiate ----------
  const tx = api.tx.revive.instantiateWithCode(0, weightLimit, sdep, bytecode, "0x", null);
  const signed = await tx.signAsync(kp);
  const dryRes = await api.rpc.system.dryRun(signed.toHex());
  console.log("instantiate signed dry-run:", dryRes.toString().slice(0, 300));
  const info = await tx.paymentInfo(A);
  console.log(`est. fee      : ${tPOT(info.partialFee)} tPOT`);
  if (/"err"/.test(dryRes.toString())) {
    console.error("Dry-run failed — NOT submitting. Inspect the error above.");
    await api.disconnect();
    process.exit(3);
  }

  let txHash = null, blockHash = null, blockNum = null, contractAddress = null, deployEvents = [];
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("timeout waiting for finality")), 180000);
    tx.signAndSend(kp, ({ status, events, txHash: h }) => {
      txHash = h.toHex();
      if (status.isInBlock) blockHash = status.asInBlock.toHex();
      if (status.isFinalized) {
        clearTimeout(to);
        blockHash = status.asFinalized.toHex();
        for (const { event } of events) {
          const s = `${event.section}.${event.method}`;
          deployEvents.push({ event: s, data: event.data.toHuman ? event.data.toHuman() : event.data.toString() });
          if (event.section === "revive" && event.method === "Instantiated") {
            contractAddress = event.data[1].toString();
          }
        }
        resolve();
      }
    }).catch(reject);
  });

  const header = await api.rpc.chain.getHeader(blockHash);
  blockNum = header.number.toNumber();
  console.log("\n================ DEPLOYED ================");
  console.log("contract :", contractAddress);
  console.log("tx hash  :", txHash);
  console.log("block    :", blockNum, blockHash);
  console.log("events   :", JSON.stringify(deployEvents, null, 1).slice(0, 800));

  results.contract.address = contractAddress;
  results.contract.deployTxHash = txHash;
  results.contract.blockNumber = blockNum;
  results.contract.blockHash = blockHash;
  results.contract.events = deployEvents;
  results.contract.feeTPot = tPOT(info.partialFee);
  results.contract.weightLimit = { refTime: weightLimit.refTime.toString(), proofSize: weightLimit.proofSize.toString() };
  results.contract.storageDepositLimitTPot = tPOT(sdep);
  results.mappedH160 = mappedH160;
  results.explorer = {
    block: `${EXPLORER}/#/explorer/query/${blockHash}`,
  };

  // ---------- Step 5: EVM-side visibility ----------
  if (contractAddress) {
    for (let i = 0; i < 3; i++) {
      const code = await evm("eth_getCode", [contractAddress, "latest"]);
      if (code.result && code.result !== "0x") {
        console.log(`eth_getCode   : ${(code.result.length - 2) / 2} bytes visible via EVM RPC ✅`);
        results.contract.evmVisible = { eth_getCodeBytes: (code.result.length - 2) / 2 };
        break;
      }
      console.log("eth_getCode   : empty/err, retrying…", JSON.stringify(code).slice(0, 120));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  const balAfter = await api.query.system.account(A);
  results.balances = {
    beforeTPot: tPOT(bal.free),
    afterTPot: { free: tPOT(balAfter.data.free), reserved: tPOT(balAfter.data.reserved) },
  };
  console.log("balance after :", `free ${tPOT(balAfter.data.free)} | reserved ${tPOT(balAfter.data.reserved)} tPOT`);

  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log("\nwrote", outFile);
  await api.disconnect();
})().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
