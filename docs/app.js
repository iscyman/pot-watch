/**
 * app.js — POT Watch live dashboard (backend-free, zero-dependency).
 * Reads the Portaldot V3 testnet directly from the browser:
 *   · Substrate JSON-RPC (HTTPS)  — blocks, eras, sessions, validators, issuance
 *   · EVM JSON-RPC (HTTPS)        — AlertRegistry contract state (eth_call)
 *   · deployment.json (GitHub raw) — verified deployment evidence + decoded events
 * Same storage-key / SCALE / BABE logic as watcher/src (twox.js port).
 */
import {
  storageKey, hexToBytes, decU32, decU64, decU128, decVecAccountId, decCompact,
  abbreviate, formatPot,
} from './twox.js';
import { SEC, initSecurity, refreshStakes, scanBlocks, renderSecurity } from './security.js';

// ---------------- config ----------------
export const CFG = {
  sub: 'https://test-node-v3.portaldot.dev',
  evm: 'https://test-evm-rpc-v3.portaldot.dev',
  contract: '0xeae1fb99ac651fd8a8bc23fb65dc51acb925429d',
  deployerH160: '0x6920eceF4a2eDbC6be94f0572b19bCcf0f13Cfe5',
  chainId: 420420777,
  explorer: (h) => `https://node-console.portaldot.dev/#/explorer/query/${h}`,
  deployJson: 'https://raw.githubusercontent.com/iscyman/pot-watch/main/contracts/deployment.json',
  repo: 'https://github.com/iscyman/pot-watch',
  blockTimeTargetS: 6,
  historyBlocks: 30,   // bootstrap window for validator activity
  windowBlocks: 90,    // activity window (~9 min at 6s blocks)
};

// AlertRegistry selectors (keccak256, computed at build time)
const SEL = {
  activeAlertCount: '0x309969a1',
  getAlert: '0x85081886',       // getAlert(uint256)
  listAlertIds: '0xe790fd24',   // listAlertIds(address)
  nextId: '0x61b8ce8c',
  totalRegistered: '0x927416c0',
  totalCancelled: '0x2a5ff002',
};
const KINDS = ['ValidatorUptime', 'EraRotation', 'SlashEvent', 'LargeTransfer'];
const CHANNELS = ['Discord', 'Telegram'];

// Substrate storage keys (fixed twox128 pairs)
const K = {
  currentEra: storageKey('Staking', 'CurrentEra'),
  activeEra: storageKey('Staking', 'ActiveEra'),
  sessionIndex: storageKey('Session', 'CurrentIndex'),
  validators: storageKey('Session', 'Validators'),
  issuance: storageKey('Balances', 'TotalIssuance'),
  timestamp: storageKey('Timestamp', 'Now'),
};

// ---------------- rpc ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(url, method, params = [], tries = 4) {
  let lastErr;
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !ct.includes('json')) {
        // Cloudflare rate-limit / challenge pages come back as HTML — back off and retry
        lastErr = new Error(`${method}: HTTP ${res.status} (${ct.split(';')[0] || 'no content-type'})`);
      } else {
        const j = await res.json();
        if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
        return j.result;
      }
    } catch (e) {
      lastErr = e;
    }
    if (t < tries) await sleep(350 * t * (1 + Math.random()));
  }
  throw lastErr;
}
const sub = (m, p = []) => rpc(CFG.sub, m, p);
const evm = (m, p = []) => rpc(CFG.evm, m, p);

// ---------------- evm helpers ----------------
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const decWords = (hex) => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const w = [];
  for (let i = 0; i + 64 <= h.length; i += 64) w.push(h.slice(i, i + 64));
  return w;
};
const ethCall = (data) => evm('eth_call', [{ to: CFG.contract, data }, 'latest']);

export async function readContract() {
  const [active, nextId, totalReg, totalCan, code] = await Promise.all([
    ethCall(SEL.activeAlertCount), ethCall(SEL.nextId),
    ethCall(SEL.totalRegistered), ethCall(SEL.totalCancelled),
    evm('eth_getCode', [CFG.contract, 'latest']),
  ]);
  const n = Number(BigInt(nextId));
  const ids = [];
  for (let i = 1; i < n && ids.length < 20; i++) ids.push(i);
  const rows = await Promise.all(ids.map((i) => ethCall(SEL.getAlert + word(i))));
  const alerts = [];
  rows.forEach((r, idx) => {
    const w = decWords(r);
    if (w.length < 9) return;
    alerts.push({
      id: ids[idx],
      owner: '0x' + w[0].slice(24),
      kind: parseInt(w[1].slice(62), 16),
      target: '0x' + w[2],
      threshold: BigInt('0x' + w[3]),
      channel: parseInt(w[4].slice(62), 16),
      active: parseInt(w[5].slice(62), 16) === 1,
      createdAt: Number(BigInt('0x' + w[6])),
      lastFiredAt: Number(BigInt('0x' + w[7])),
      fireCount: Number(BigInt('0x' + w[8])),
    });
  });
  return {
    activeCount: Number(BigInt(active)), nextId: n,
    totalRegistered: Number(BigInt(totalReg)), totalCancelled: Number(BigInt(totalCan)),
    codeBytes: (code.length - 2) / 2, alerts,
  };
}

// ---------------- substrate reads ----------------
export async function readChainState() {
  const rs = await Promise.allSettled([
    sub('state_getStorage', [K.currentEra]),
    sub('state_getStorage', [K.activeEra]),
    sub('state_getStorage', [K.sessionIndex]),
    sub('state_getStorage', [K.validators]),
    sub('state_getStorage', [K.issuance]),
    sub('state_getStorage', [K.timestamp]),
    sub('chain_getFinalizedHead'),
    sub('system_health'),
    sub('state_getRuntimeVersion'),
  ]);
  const ok = (i, d = null) => (rs[i].status === 'fulfilled' ? rs[i].value : d);
  const ce = ok(0), ae = ok(1), si = ok(2), vals = ok(3), iss = ok(4), ts = ok(5);
  let activeEra = null, eraStartedMs = null;
  if (ae) {
    const b = hexToBytes(ae);
    if (b[0] === 1) {
      activeEra = decU32(b, 1);
      if (b.length > 13 && b[5] === 1) eraStartedMs = Number(decU64(b, 6));
    }
  }
  let finalizedNumber = null;
  const fh = ok(6);
  if (fh) {
    try {
      const finHeader = await sub('chain_getHeader', [fh]);
      finalizedNumber = parseInt(finHeader.number, 16);
    } catch { /* keep null */ }
  }
  const hl = ok(7), rtv = ok(8);
  return {
    currentEra: ce ? decU32(hexToBytes(ce)) : null,
    activeEra, eraStartedMs,
    sessionIndex: si ? decU32(hexToBytes(si)) : null,
    validators: vals ? decVecAccountId(vals) : [],
    issuance: iss ? decU128(hexToBytes(iss)) : null,
    chainTimeMs: ts ? Number(decU64(hexToBytes(ts))) : null,
    finalizedNumber,
    peers: hl ? hl.peers : null, isSyncing: hl ? hl.isSyncing : null,
    specVersion: rtv ? rtv.specVersion : null, chainName: rtv ? rtv.chain : null,
  };
}

/** BABE PreRuntime digest → authority index (port of watcher blocks.ts) */
export function decodePreRuntime(logs) {
  for (const log of logs || []) {
    const b = hexToBytes(log);
    if (b.length < 10 || b[0] !== 0x06) continue; // DigestItem::PreRuntime
    const engine = new TextDecoder().decode(b.subarray(1, 5));
    if (engine !== 'BABE') continue;
    const [, off] = decCompact(b, 5);
    const base = 5 + off;
    const variant = b[base];
    if (variant < 1 || variant > 3) continue;
    return { authorIndex: decU32(b, base + 1), slot: decU64(b, base + 5) };
  }
  return { authorIndex: null, slot: null };
}

async function fetchBlockByNumber(num) {
  const hash = await sub('chain_getBlockHash', [num]);
  if (!hash) return null;
  const b = await sub('chain_getBlock', [hash]);
  const h = b.block.header;
  const { authorIndex } = decodePreRuntime(h.digest?.logs);
  return {
    number: parseInt(h.number, 16), hash, parent: h.parentHash,
    extrinsics: (b.block.extrinsics || []).length, authorIndex,
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  }));
  return out;
}

// ---------------- live state ----------------
export const S = {
  best: null, bestHash: null, finalized: null, headers: [],   // newest first
  authors: new Map(), totalAuthored: 0,
  era: null, session: null, activeEra: null, eraStartedMs: null,
  validators: [], issuance: null, peers: null, spec: null, chainName: null,
  blockTimeAvgS: null, tsAnchor: null, blockAnchor: null,
  contract: null, evidence: null, events: [],
  subOk: true, evmOk: true, startedAt: Date.now(),
};

function recordBlock(info) {
  if (!info || S.headers.some((h) => h.number === info.number)) return;
  S.headers.unshift(info);
  while (S.headers.length > 200) S.headers.pop();
  if (info.authorIndex !== null && info.authorIndex >= 0 &&
      (!S.validators.length || info.authorIndex < S.validators.length)) {
    S.authors.set(info.authorIndex, (S.authors.get(info.authorIndex) || 0) + 1);
    S.totalAuthored++;
  }
  S.best = info.number; S.bestHash = info.hash;
}

export async function bootstrap() {
  const header = await sub('chain_getHeader');
  const bestNum = parseInt(header.number, 16);
  S.best = bestNum;
  const nums = [];
  for (let i = 0; i < CFG.historyBlocks; i++) nums.push(bestNum - i);
  const blocks = await pool(nums, 3, fetchBlockByNumber);
  for (const b of blocks.reverse()) recordBlock(b);
  // anchor for chain-time block interval
  const st = await readChainState();
  Object.assign(S, {
    finalized: st.finalizedNumber, era: st.currentEra, session: st.sessionIndex,
    activeEra: st.activeEra, eraStartedMs: st.eraStartedMs, validators: st.validators,
    issuance: st.issuance, peers: st.peers, spec: st.specVersion, chainName: st.chainName,
  });
  S.tsAnchor = st.chainTimeMs; S.blockAnchor = bestNum;
  // re-record authors against the now-known validator count
  S.authors.clear(); S.totalAuthored = 0;
  for (const b of S.headers) {
    if (b.authorIndex !== null && b.authorIndex < S.validators.length) {
      S.authors.set(b.authorIndex, (S.authors.get(b.authorIndex) || 0) + 1);
      S.totalAuthored++;
    }
  }
}

export async function tickBlocks() {
  try {
    const header = await sub('chain_getHeader');
    const num = parseInt(header.number, 16);
    if (S.best === null) S.best = num;
    while (num > S.best) {
      const info = await fetchBlockByNumber(S.best + 1);
      if (!info) break;
      recordBlock(info);
      if (typeof onBlock === 'function') onBlock(info);
    }
    S.subOk = true;
  } catch (e) { S.subOk = false; }
}

let secTick = 0;
export async function tickSecurityNow() {
  if (!SEC.ready) return;
  try {
    secTick++;
    if (secTick % 4 === 1) await refreshStakes(rpc, CFG);
    const to = S.best;
    const from = SEC.scanTo || Math.max(0, to - 20);
    if (to > from) await scanBlocks(rpc, CFG, from, Math.min(to, from + 4));
  } catch (e) { /* security panel must never kill the dashboard */ }
}

export async function tickSlow() {
  try {
    const st = await readChainState();
    S.finalized = st.finalizedNumber; S.era = st.currentEra; S.session = st.sessionIndex;
    S.activeEra = st.activeEra; S.eraStartedMs = st.eraStartedMs;
    if (st.validators.length) S.validators = st.validators;
    S.issuance = st.issuance; S.peers = st.peers; S.spec = st.specVersion;
    if (S.tsAnchor !== null && st.chainTimeMs !== null && st.chainTimeMs > S.tsAnchor) {
      const dtS = (st.chainTimeMs - S.tsAnchor) / 1000;
      const db = S.best - S.blockAnchor;
      if (db > 0) S.blockTimeAvgS = dtS / db;
      S.tsAnchor = st.chainTimeMs; S.blockAnchor = S.best;
    }
    S.subOk = true;
  } catch (e) { S.subOk = false; }
  try { S.contract = await readContract(); S.evmOk = true; } catch (e) { S.evmOk = false; }
  await tickSecurityNow();
}

export async function loadEvidence() {
  try {
    const r = await fetch(CFG.deployJson + '?t=' + Date.now());
    S.evidence = await r.json();
    S.events = (S.evidence.solidityEventsDecodedFromNative || []).slice().reverse();
  } catch { S.evidence = null; }
}

// ---------------- health score (port of watcher health.ts) ----------------
export function validatorStats() {
  const latest = S.best || 0;
  return S.validators.map((address, index) => {
    const blocks = S.authors.get(index) || 0;
    const last = S.headers.find((h) => h.authorIndex === index);
    const lastSeenAgo = last ? latest - last.number : null;
    return {
      address, index, blocks,
      lastBlock: last ? last.number : null, lastSeenAgo,
      sharePct: S.totalAuthored ? (blocks / S.totalAuthored) * 100 : 0,
      inactive: lastSeenAgo === null || lastSeenAgo > CFG.windowBlocks,
    };
  });
}

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function health() {
  const stats = validatorStats();
  const availability = stats.length ? stats.filter((s) => !s.inactive).length / stats.length : 0;
  const hhi = stats.reduce((a, s) => a + (s.sharePct / 100) ** 2, 0);
  const finalityLag = (S.best !== null && S.finalized !== null) ? Math.max(0, S.best - S.finalized) : 0;
  const bt = S.blockTimeAvgS ?? CFG.blockTimeTargetS;
  const components = {
    finality: { score: clamp(100 - finalityLag * 15), weight: 0.25 },
    availability: { score: clamp(availability * 100), weight: 0.3 },
    blockTime: { score: clamp(100 - Math.abs(bt - CFG.blockTimeTargetS) * 40), weight: 0.2 },
    decentralization: { score: clamp((1 - hhi) * 130), weight: 0.15 },
    security: { score: clamp(100 - 0 * 25), weight: 0.1 }, // slash feed ships with security update
  };
  let score = 0;
  for (const c of Object.values(components)) score += c.score * c.weight;
  score = Math.round(score);
  const grade = score >= 90 ? 'EXCELLENT' : score >= 75 ? 'GOOD' : score >= 60 ? 'FAIR' : 'DEGRADED';
  return { score, grade, components, finalityLag, availability, hhi, blockTimeAvgS: bt };
}

/** everything in one call — used by the UI loop and by node-side tests */
export async function probe() {
  await bootstrap();
  await tickSlow();
  await loadEvidence();
  const h = health();
  return {
    best: S.best, finalized: S.finalized, era: S.activeEra ?? S.era, session: S.session,
    validators: S.validators.length, peers: S.peers, spec: S.spec, chain: S.chainName,
    issuancePOT: S.issuance !== null ? formatPot(S.issuance) : null,
    blockTimeAvgS: S.blockTimeAvgS, health: h.score, grade: h.grade,
    contract: S.contract && {
      active: S.contract.activeCount, nextId: S.contract.nextId,
      totalRegistered: S.contract.totalRegistered, codeBytes: S.contract.codeBytes,
      alerts: S.contract.alerts.map((a) => ({
        id: a.id, kind: KINDS[a.kind], channel: CHANNELS[a.channel],
        threshold: a.threshold.toString(), fireCount: a.fireCount, active: a.active,
        target: abbreviate(a.target, 8, 6),
      })),
    },
    events: S.events.map((e) => ({ ev: e.solidityEvent, block: e.blockNumber, id: e.args?.id })),
    sampleBlocks: S.headers.slice(0, 3).map((b) => ({
      n: b.number, ext: b.extrinsics,
      author: b.authorIndex !== null ? abbreviate(S.validators[b.authorIndex] || '?') : null,
    })),
  };
}

// ---------------- UI ----------------
export let onBlock = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sevFor(name) {
  return name === 'AlertFired' ? 'crit' : name === 'AlertRegistered' ? 'inf' : 'wrn';
}

function renderKpis(h) {
  if (!S.headers.length) return;
  $('blk').textContent = (S.best || 0).toLocaleString();
  const age = Math.round((Date.now() - S.startedAt) / 1000) % 60;
  $('blkt').textContent = `finalized #${(S.finalized || 0).toLocaleString()} · lag ${Math.max(0, (S.best || 0) - (S.finalized || 0))}`;
  const era = S.activeEra ?? S.era;
  $('era').textContent = era !== null ? era.toLocaleString() : '—';
  let eraSub = `session ${(S.session || 0).toLocaleString()}`;
  if (S.eraStartedMs) {
    const mins = Math.max(0, Math.round((Date.now() - S.eraStartedMs) / 60000));
    eraSub += ` · active ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }
  $('erasub').textContent = eraSub;
  const stats = validatorStats();
  const active = stats.filter((s) => !s.inactive).length;
  $('vals').textContent = `${active} / ${stats.length}`;
  $('valsub').innerHTML = active === stats.length
    ? '<span style="color:var(--acc2)">●</span> all producing blocks'
    : `<span style="color:var(--warn)">●</span> ${stats.length - active} idle in window`;
  $('btime').textContent = (h.blockTimeAvgS ?? 0) ? h.blockTimeAvgS.toFixed(2) + 's' : '…';
  $('healthk').textContent = h.score;
  $('healthsub').textContent = h.grade;
  $('iss').textContent = S.issuance !== null ? bigPot(S.issuance) : '—';
  $('issub').textContent = S.issuance !== null ? `${formatPot(S.issuance)} POT · 14 dec` : '';
  const net = $('netstat');
  net.innerHTML = `<span class="dot" style="${S.subOk && S.evmOk ? '' : 'background:var(--bad);box-shadow:0 0 8px var(--bad)'}"></span>` +
    ` Portaldot V3 Testnet · chainId ${CFG.chainId} · spec ${S.spec || '…'} · ${S.subOk && S.evmOk ? 'RPC connected' : 'reconnecting…'}`;
}

function bigPot(raw) {
  const n = Number(raw / 10n ** 12n) / 100;
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n.toFixed(0);
}

function renderBlocks() {
  const tb = $('blocks');
  tb.innerHTML = S.headers.slice(0, 8).map((b, i) => {
    const author = b.authorIndex !== null ? S.validators[b.authorIndex] : null;
    return `<tr${i === 0 ? ' class="flash"' : ''}>
      <td class="mono" style="color:var(--blue)">#${b.number.toLocaleString()}</td>
      <td class="mono" style="color:var(--dim)">${(S.best - b.number) * (S.blockTimeAvgS || 6) | 0}s</td>
      <td class="mono" style="color:var(--faint)"><a class="hx" href="${CFG.explorer(b.hash)}" target="_blank" rel="noopener">${b.hash.slice(0, 10)}…${b.hash.slice(-8)}</a></td>
      <td class="mono">${b.extrinsics}</td>
      <td class="addr mono" title="${esc(author || '')}">${author ? esc(abbreviate(author)) : '—'}</td>
    </tr>`;
  }).join('');
}

function renderValidators(h) {
  const tb = $('valrows');
  const stats = validatorStats();
  tb.innerHTML = stats.map((s) => {
    const pct = Math.min(100, (s.blocks / Math.max(1, S.totalAuthored / Math.max(1, stats.length))) * 100);
    return `<tr>
      <td class="addr mono" title="${esc(s.address)}">${esc(abbreviate(s.address))}</td>
      <td><div class="uptime"><div class="bar"><i style="width:${s.sharePct > 0 ? Math.max(8, s.sharePct * (100 / Math.max(1, h.hhi ? 1 : 1))) : 0}%"></i></div><span class="mono">${s.sharePct.toFixed(1)}%</span></div></td>
      <td class="mono">${s.blocks}</td>
      <td class="mono" style="color:var(--dim)">${s.lastSeenAgo === null ? '—' : s.lastSeenAgo + ' blk ago'}</td>
      <td>${s.inactive ? '<span class="pill warn">idle</span>' : '<span class="pill ok">active</span>'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" style="color:var(--dim)">loading validators…</td></tr>';
  $('valcount').textContent = `${stats.filter((s) => !s.inactive).length} active`;
}

function renderContract() {
  const c = S.contract;
  if (!c) return;
  $('cstats').innerHTML = `
    <div class="row"><span>Active alerts</span><span class="mono" style="color:var(--acc2)">${c.activeCount}</span></div>
    <div class="row"><span>Total registered</span><span class="mono">${c.totalRegistered}</span></div>
    <div class="row"><span>Total cancelled</span><span class="mono">${c.totalCancelled}</span></div>
    <div class="row"><span>Bytecode on chain</span><span class="mono">${c.codeBytes.toLocaleString()} B</span></div>`;
  $('alertrows').innerHTML = c.alerts.map((a) => `
    <div class="alert"><span class="sev ${a.active ? 'inf' : 'wrn'}"></span><div>
      <b>#${a.id} ${KINDS[a.kind] || 'Alert'}</b> → ${CHANNELS[a.channel] || '?'}
      ${a.kind === 0 ? `· threshold ${(Number(a.threshold) / 100).toFixed(2)}% uptime` : ''}
      · fired <b class="mono">${a.fireCount}×</b> ${a.active ? '' : '· <span style="color:var(--warn)">cancelled</span>'}
      <div class="t mono">target ${esc(abbreviate(a.target, 8, 6))} · owner ${esc(abbreviate(a.owner, 6, 4))}</div>
    </div></div>`).join('') || '<div class="alert"><span class="sev inf"></span><div>No alerts registered yet.</div></div>';
}

function renderEvents() {
  if (!S.events.length) return;
  $('eventrows').innerHTML = S.events.map((e) => `
    <div class="alert"><span class="sev ${sevFor(e.solidityEvent)}"></span><div>
      <b>${esc(e.solidityEvent)}</b>${e.args?.id !== undefined ? ` · alert #${esc(e.args.id)}` : ''}
      ${e.solidityEvent === 'AlertFired' ? ` · by ${esc(abbreviate(e.args?.watcher || '', 6, 4))}` : ''}
      <div class="t mono">block ${esc(String(e.blockNumber))} · <a class="hx" href="${CFG.explorer(e.txHash)}" target="_blank" rel="noopener">${esc((e.txHash || '').slice(0, 10))}…</a> · decoded from revive.ContractEmitted</div>
    </div></div>`).join('');
}

function renderHealth(h) {
  const circ = 2 * Math.PI * 46;
  $('gaugeArc').setAttribute('stroke-dasharray', `${(h.score / 100) * circ} ${circ}`);
  $('gaugeNum').innerHTML = `<div><b>${h.score}</b><span>${h.grade}</span></div>`;
  const col = (v) => v >= 90 ? 'var(--acc2)' : v >= 60 ? 'var(--warn)' : 'var(--bad)';
  $('hmrows').innerHTML = `
    <div class="row"><span>Finality lag</span><span style="color:${col(100 - h.finalityLag * 15)}">${h.finalityLag} blocks</span></div>
    <div class="row"><span>Validator availability</span><span style="color:${col(h.availability * 100)}">${Math.round(h.availability * 100)}%</span></div>
    <div class="row"><span>Block time (avg, live)</span><span>${h.blockTimeAvgS ? h.blockTimeAvgS.toFixed(2) + 's' : '…'} <span style="color:var(--faint)">/ 6.00s</span></span></div>
    <div class="row"><span>Stake concentration (HHI)</span><span>${h.hhi.toFixed(3)}</span></div>
    <div class="row"><span>Peers</span><span style="color:var(--acc2)">${S.peers ?? '…'}</span></div>`;
}

function renderEvidence() {
  const d = S.evidence;
  if (!d) { $('evid').innerHTML = '<div style="padding:14px;color:var(--dim)">loading evidence…</div>'; return; }
  const c = d.contract || {};
  const tx = (label, hash, block) => `
    <div class="tx"><span>${esc(label)}</span>
      <a class="mono hx" href="${CFG.explorer(hash)}" target="_blank" rel="noopener">${esc((hash || '').slice(0, 14))}…${esc((hash || '').slice(-8))}</a>
      <span class="mono" style="color:var(--faint)">#${esc(String(block ?? ''))}</span></div>`;
  const inter = (d.interactions || []).map((it, i) =>
    tx(`interaction ${i + 1}: ${it.label || ''}`, it.txHash, it.blockNumber)).join('');
  const mapTx = (d.steps || []).find((s) => s.step === 'map_account');
  $('evid').innerHTML = `
    ${tx('map_account (native → EVM identity)', mapTx?.txHash, '')}
    ${tx('deploy · Revive.instantiate_with_code', c.deployTxHash, c.blockNumber)}
    ${inter}
    <div class="feecmp">
      <div class="feerow"><span class="fl">EVM surface (MetaMask route)</span><div class="fbar"><i style="width:100%;background:var(--bad)"></i></div><span class="fv mono">~289 tPOT</span></div>
      <div class="feerow"><span class="fl">Native surface (our tooling)</span><div class="fbar"><i style="width:${Math.max(1.5, (Number(c.feeTPot || 0.36) / 289) * 100)}%;background:var(--acc2)"></i></div><span class="fv mono">${Number(c.feeTPot || 0).toFixed(4)} tPOT</span></div>
      <div class="feenote">≈ <b>800× cheaper</b> — same contract, same chain. Full analysis: <a class="hx" href="https://github.com/iscyman/pot-watch/blob/main/docs/DEPLOYMENT.md" target="_blank" rel="noopener">docs/DEPLOYMENT.md</a></div>
    </div>`;
}

function renderAll() {
  const h = health();
  renderKpis(h); renderBlocks(); renderValidators(h);
  renderContract(); renderEvents(); renderHealth(h); renderEvidence();
  renderSecurity(S);
}

export function start() {
  onBlock = () => { /* live flash handled by render tick */ };
  (async () => {
    $('boot').textContent = 'connecting to testnet…';
    await Promise.all([bootstrap(), loadEvidence(), initSecurity(rpc, CFG)]);
    $('boot').textContent = '';
    await tickSlow();
    renderAll();
    setInterval(async () => { await tickBlocks(); }, 3000);
    setInterval(() => { tickSlow(); }, 15000);
    setInterval(renderAll, 2000);
  })().catch((e) => {
    $('boot').textContent = 'RPC error: ' + e.message;
    console.error(e);
  });
}

if (typeof window !== 'undefined') start();
