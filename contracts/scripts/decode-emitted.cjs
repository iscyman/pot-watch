// Decode revive.ContractEmitted (topics+data captured from native txs) back into
// Solidity events with ethers — proves the same ABI-level event stream the
// dashboard/watcher will consume, regardless of which surface wrote it.
const path = require("path"); const fs = require("fs");
const ROOT = path.resolve(__dirname, "..");
const { Interface } = require(path.join(ROOT, "node_modules/ethers"));
const big = (k, v) => (typeof v === "bigint" ? v.toString() : v);
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts/AlertRegistry.sol/AlertRegistry.json"), "utf8"));
const iface = new Interface(artifact.abi);
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.json"), "utf8"));
const decoded = [];
for (const it of dep.interactions || []) {
  for (const ev of it.events || []) {
    if (ev.event === "revive.ContractEmitted" && ev.data && ev.data.topics) {
      try {
        const p = iface.parseLog({ topics: ev.data.topics, data: ev.data.data });
        const frag = iface.getEvent(p.name);
        const args = {};
        frag.inputs.forEach((inp, i) => { args[inp.name] = String(p.args[i]); });
        const rec = { source: "native revive.ContractEmitted -> ethers.Interface.parseLog", txHash: it.txHash, blockNumber: it.blockNumber, solidityEvent: p.name, args };
        decoded.push(rec);
        console.log(`✅ ${p.name} @ block ${it.blockNumber}:`, JSON.stringify(args, big).slice(0, 300));
      } catch (e) { console.log("decode fail:", e.message?.slice(0, 120), JSON.stringify(ev.data, big).slice(0, 150)); }
    }
  }
}
dep.solidityEventsDecodedFromNative = decoded;
dep.evmSurfaceNotes = "eth_call reads work from any Ethereum tooling (verified: activeAlertCount, getAlert). eth_getLogs/receipts do NOT index native-surface writes on spec 3002 — event ingestion uses Substrate WS revive.ContractEmitted (captured in interactions[].events), which decodes to standard Solidity events (see solidityEventsDecodedFromNative).";
fs.writeFileSync(path.join(ROOT, "deployment.json"), JSON.stringify(dep, null, 2, big));
console.log("\ndeployment.json enriched with", decoded.length, "decoded Solidity events");
