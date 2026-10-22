/**
 * POT Watch — post-deploy interactions on Portaldot V3 testnet.
 *
 * Writes go through the NATIVE surface (Revive.call, ~0.015 tPOT each);
 * reads + event logs are verified through the EVM surface (eth_call /
 * eth_getLogs — free), which is exactly what the POT Watch dashboard consumes.
 *
 * Run after native-deploy.cjs:
 *   NODE_PATH=/home/user/pjstmp/node_modules node scripts/native-interact.cjs
 */
const path = require("path");
const fs = require("fs");

const WS = "wss://test-node-v3.portaldot.dev";
const EVM_RPC = "https://test-evm-rpc-v3.portaldot.dev";
const ROOT = path.resolve(__dirname, "..");

const tPOT = (raw) => Number(raw) / 1e14;

async function evm(method, params) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(EVM_RPC, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      });
      const t = await r.text();
      const j = JSON.parse(t);
      if (!j.error || i === 3) return j;
    } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { error: { message: "RPC unreachable" } };
}

(async () => {
  const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
  const { Interface } = require(path.join(ROOT, "node_modules/ethers"));

  const wallet = JSON.parse(fs.readFileSync(path.join(ROOT, "native-wallet.json"), "utf8"));
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts/AlertRegistry.sol/AlertRegistry.json"), "utf8"));
  const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.json"), "utf8"));
  const CONTRACT = deployment.contract.address;
  if (!CONTRACT) throw new Error("deployment.json has no contract address — run native-deploy.cjs first");

  const iface = new Interface(artifact.abi);
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  const kp = keyring.addFromMnemonic(wallet.mnemonic);

  deployment.interactions = deployment.interactions || [];

  // dry-run a call through ReviveApi to size its weight, then submit it natively
  async function reviveCall(label, dataHex) {
    let weight = { refTime: 200_000_000_000n, proofSize: 1_000_000n };
    let sdepCap = 5n * 10n ** 14n; // 5 tPOT cap (writes are ~0.15 tPOT/item)
    try {
      const dry = await api.call.reviveApi.call("0x" + Buffer.from(kp.publicKey).toString("hex"), CONTRACT, 0, weight, 50n * 10n ** 14n, dataHex);
      const j = dry.toJSON();
      console.log(`[${label}] dry-run:`, JSON.stringify(j).slice(0, 380));
      if (j.weightRequired) {
        weight = {
          refTime: BigInt(Math.ceil(Number(j.weightRequired.refTime) * 1.5)) + 10n ** 9n,
          proofSize: BigInt(Math.ceil(Number(j.weightRequired.proofSize) * 1.5)) + 10n ** 4n,
        };
      }
      const maxSD = j.maxStorageDeposit && j.maxStorageDeposit.charge !== undefined ? BigInt(j.maxStorageDeposit.charge) : 0n;
      const actSD = j.storageDeposit && j.storageDeposit.charge !== undefined ? BigInt(j.storageDeposit.charge) : 0n;
      const basis = maxSD > actSD ? maxSD : actSD;
      if (basis > 0n) sdepCap = (basis * 130n) / 100n + 10n ** 13n;
    } catch (e) { console.log(`[${label}] dry-run err (using defaults):`, e.message?.slice(0, 140)); }

    const tx = api.tx.revive.call(CONTRACT, 0, weight, sdepCap, dataHex);
    let out = { label, when: new Date().toISOString(), data: dataHex };
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timeout")), 120000);
      tx.signAndSend(kp, ({ status, events, txHash }) => {
        if (status.isFinalized) {
          clearTimeout(to);
          out.txHash = txHash.toHex();
          out.blockHash = status.asFinalized.toHex();
          out.events = events.map(({ event }) => ({
            event: `${event.section}.${event.method}`,
            data: event.data.toHuman ? event.data.toHuman() : event.data.toString(),
          }));
          resolve();
        }
      }).catch(reject);
    });
    const header = await api.rpc.chain.getHeader(out.blockHash);
    out.blockNumber = header.number.toNumber();
    const ok = out.events.some((e) => e.event === "system.ExtrinsicSuccess");
    out.success = ok;
    console.log(`[${label}] tx ${out.txHash} block ${out.blockNumber} ${ok ? "✅" : "❌ " + JSON.stringify(out.events).slice(0, 200)}`);
    deployment.interactions.push(out);
    return out;
  }

  // ---------- writes (native surface) ----------
  // live validator as bytes32 target (AccountId32 is exactly 32 bytes — fits bytes32 natively)
  let validatorTarget = "0x" + "00".repeat(32);
  try {
    const vals = await api.query.session.validators();
    if (vals && vals.length) validatorTarget = vals[0].toHex ? vals[0].toHex() : vals[0].toString();
  } catch (e) { console.log("session.validators unavailable, using zero target:", e.message?.slice(0, 80)); }
  console.log("validator target:", validatorTarget);

  // registerAlert(Kind kind, bytes32 target, uint64 threshold, Channel channel)
  const d1 = iface.encodeFunctionData("registerAlert", [0, validatorTarget, 9000, 0]); // ValidatorUptime 90.00% (bps) -> Discord
  await reviveCall("registerAlert #1 (ValidatorUptime→Discord, 9000 bps)", d1);

  const d2 = iface.encodeFunctionData("registerAlert", [1, "0x" + "00".repeat(32), 0, 1]); // EraRotation, network-wide -> Telegram
  await reviveCall("registerAlert #2 (EraRotation→Telegram)", d2);

  // recordFire(uint256 id)
  const d3 = iface.encodeFunctionData("recordFire", [1]);
  await reviveCall("recordFire #1", d3);

  // ---------- reads (EVM surface — the dashboard's data path) ----------
  const reads = {};
  const count = await evm("eth_call", [{ to: CONTRACT, data: iface.encodeFunctionData("activeAlertCount") }, "latest"]);
  reads.activeAlertCount = count.result ? BigInt(count.result).toString() : "ERR " + JSON.stringify(count.error).slice(0, 100);

  const a1 = await evm("eth_call", [{ to: CONTRACT, data: iface.encodeFunctionData("getAlert", [1]) }, "latest"]);
  if (a1.result && a1.result !== "0x") {
    const dec = iface.decodeFunctionResult("getAlert", a1.result);
    reads.alert1 = dec[0].toJSON ? JSON.stringify(dec[0].toJSON()) : String(dec[0]);
  } else reads.alert1 = "ERR " + JSON.stringify(a1.error).slice(0, 100);

  const latest = await evm("eth_blockNumber", []);
  const fromBlock = "0x" + Math.max(0, parseInt(latest.result, 16) - 500).toString(16);
  const logs = await evm("eth_getLogs", [{ address: CONTRACT, fromBlock, toBlock: "latest" }]);
  reads.logs = (logs.result || []).map((l) => {
    try {
      const p = iface.parseLog({ topics: l.topics, data: l.data });
      return { event: p.name, args: JSON.stringify(p.args.toJSON ? p.args.toJSON() : p.args), txHash: l.transactionHash, blockNumber: parseInt(l.blockNumber, 16) };
    } catch { return { raw: l.topics[0], txHash: l.transactionHash }; }
  });
  console.log("\nEVM-side reads:", JSON.stringify(reads, null, 1).slice(0, 1600));

  deployment.evmSurfaceCheck = { when: new Date().toISOString(), ...reads };
  fs.writeFileSync(path.join(ROOT, "deployment.json"), JSON.stringify(deployment, null, 2));
  console.log("\ndeployment.json updated with", deployment.interactions.length, "interactions + evmSurfaceCheck");
  await api.disconnect();
})().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
