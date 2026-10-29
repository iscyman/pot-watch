/**
 * security.js — dashboard security analytics panel (Package 08).
 * Live, backend-free: stake concentration from Staking.Ledger, slash &
 * large-transfer scan over recent blocks via the metadata walker (walk.js),
 * session/validator-set context. Mirrors watcher/src/security.ts.
 */
import { Cur, Decoder, parseLookup, findEventRecord, findStakingLedger, hexToBytesLocal } from './walk.js';
import { storageKey, formatPot, abbreviate, twox128, ss58ToHex } from './twox.js';

export const SEC = {
  ready: false,
  error: null,
  stakes: [],          // { hex, active(bigint), sharePct, isValidator }
  stakeTotal: 0n,
  hhi: 0,
  slashes: [],         // { who, amount, source, block }
  maxTransfer: 0n,
  transferCount: 0,
  scanFrom: 0,
  scanTo: 0,
};

const EVENTS_KEY = storageKey('System', 'Events');
const LEDGER_PREFIX = '0x' + twox128('Staking') + twox128('Ledger');

let dec = null;
let recordTypeId = null;

export async function initSecurity(rpc, CFG) {
  try {
    const hex = await rpc(CFG.sub, 'state_getMetadata', []);
    const reg = parseLookup(hex);
    dec = new Decoder(reg);
    recordTypeId = findEventRecord(reg);
    SEC.ready = true;
  } catch (e) {
    SEC.error = e.message;
  }
}

function decodeEvents(raw) {
  if (!dec || !raw || raw === '0x') return [];
  const c = new Cur(hexToBytesLocal(raw));
  const n = Number(c.compact());
  const out = [];
  for (let i = 0; i < n; i++) {
    const rec = dec.decode(recordTypeId, c);
    const ev = rec.event ?? {};
    const inner = ev.f0 ?? {};
    const fields = {};
    for (const [k, v] of Object.entries(inner)) if (k !== '_variant') fields[k] = v;
    out.push({ pallet: ev._variant, name: inner._variant ?? '?', fields });
  }
  return out;
}

/** Stakes from the Staking.Ledger map (struct carries its own stash). */
export async function refreshStakes(rpc, CFG) {
  if (!dec) return;
  const ledgerType = findStakingLedger(dec.reg);
  const keys = await rpc(CFG.sub, 'state_getKeysPaged', [LEDGER_PREFIX, 100, LEDGER_PREFIX]);
  const rows = [];
  for (const key of keys) {
    const raw = await rpc(CFG.sub, 'state_getStorage', [key], 2).catch(() => null);
    if (!raw || raw === '0x') continue;
    const ledger = dec.decode(ledgerType, new Cur(hexToBytesLocal(raw)));
    const stash = typeof ledger.stash === 'string' ? ledger.stash : ledger.stash?.[0];
    if (!stash) continue;
    rows.push({ hex: stash, active: BigInt(ledger.active ?? 0), sharePct: 0, isValidator: false });
  }
  const total = rows.reduce((a, r) => a + r.active, 0n);
  for (const r of rows) r.sharePct = total ? Number((r.active * 10000n) / total) / 100 : 0;
  rows.sort((a, b) => (a.active > b.active ? -1 : 1));
  SEC.stakes = rows;
  SEC.stakeTotal = total;
  SEC.hhi = rows.reduce((a, r) => a + (r.sharePct / 100) ** 2, 0);
}

/** Scan blocks (from, to] for slash + transfer events. */
export async function scanBlocks(rpc, CFG, from, to) {
  if (!dec) return;
  for (let b = from + 1; b <= to; b++) {
    const hash = await rpc(CFG.sub, 'chain_getBlockHash', [b], 2).catch(() => null);
    if (!hash) continue;
    const raw = await rpc(CFG.sub, 'state_getStorage', [EVENTS_KEY, hash], 2).catch(() => null);
    for (const e of decodeEvents(raw)) {
      if (e.pallet === 'Staking' && e.name === 'Slashed') {
        SEC.slashes.push({ who: e.fields.staker, amount: BigInt(e.fields.amount ?? 0), source: 'Staking.Slashed', block: b });
      } else if (e.pallet === 'Balances' && e.name === 'Slashed') {
        SEC.slashes.push({ who: e.fields.who, amount: BigInt(e.fields.amount ?? 0), source: 'Balances.Slashed', block: b });
      } else if (e.pallet === 'Staking' && e.name === 'SlashReported') {
        SEC.slashes.push({ who: e.fields.validator, amount: 0n, source: 'Staking.SlashReported', block: b });
      } else if (e.pallet === 'Balances' && e.name === 'Transfer') {
        const amt = BigInt(e.fields.amount ?? 0);
        SEC.transferCount++;
        if (amt > SEC.maxTransfer) SEC.maxTransfer = amt;
      }
    }
  }
  SEC.scanFrom = from;
  SEC.scanTo = to;
  if (SEC.slashes.length > 100) SEC.slashes.splice(0, SEC.slashes.length - 100);
}

// ---------- render ----------
export function renderSecurity(S) {
  const $ = (id) => document.getElementById(id);
  const tag = $('secTag');
  if (tag) tag.textContent = SEC.ready ? 'metadata walker · live' : SEC.error ? 'walker offline' : 'loading…';
  if (!SEC.ready) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('secHhi', SEC.hhi ? SEC.hhi.toFixed(3) : '—');
  set('secBonded', String(SEC.stakes.length));
  set('secSlash', String(SEC.slashes.length));
  const sub = $('secSlashSub');
  if (sub) sub.textContent = `blocks ${SEC.scanFrom}→${SEC.scanTo}`;
  set('secXfer', SEC.transferCount ? formatPot(SEC.maxTransfer) : '0');
  const xsub = $('secXferSub');
  if (xsub) xsub.textContent = SEC.transferCount ? 'max transfer in window (POT)' : 'no transfers in window';

  const valHex = new Set((S.validators ?? []).map((v) => { try { return ss58ToHex(v); } catch { return null; } }).filter(Boolean));
  for (const r of SEC.stakes) r.isValidator = valHex.has(r.hex);

  const tbody = $('secRows');
  if (tbody) {
    tbody.innerHTML = SEC.stakes.length
      ? SEC.stakes.map((r) => `<tr><td class="mono" style="font-size:11px">${abbreviate(r.hex, 8)}</td><td class="mono">${formatPot(r.active)} POT</td><td class="mono">${r.sharePct.toFixed(2)}%</td><td>${r.isValidator ? '🟢 validator' : 'bonded'}</td></tr>`).join('')
      : '<tr><td colspan="4" style="color:var(--dim);padding:12px">no bonded stakes found</td></tr>';
  }
  const feed = $('secFeed');
  if (feed) {
    feed.innerHTML = SEC.slashes.length
      ? SEC.slashes.slice(-6).reverse().map((s) => `<div class="row"><span>🩸 ${s.source} · ${abbreviate(s.who, 6)} · block ${s.block}</span><span class="mono">${formatPot(s.amount)} POT</span></div>`).join('')
      : '<div class="row"><span>✅ no slash events in the scanned window</span><span></span></div>';
  }
}
