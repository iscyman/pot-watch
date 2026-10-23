/**
 * twox.js — zero-dependency Substrate primitives, browser edition.
 * Ported verbatim from watcher/src/twox.ts (same BigInt XXH64 core).
 * blake2b vendored from @noble/hashes v1.3.3 (MIT) — used only for ss58 checksums.
 */
import { blake2b } from './vendor/blake2b.esm.js';

// ---------- byte helpers (Buffer-free) ----------
export function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}
export function bytesToHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ---------- XXH64 (pure BigInt implementation) ----------
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const M64 = 0xffffffffffffffffn;

const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & M64;
const mul = (a, b) => (a * b) & M64;

function xxRound(acc, lane) {
  acc = (acc + mul(lane, P2)) & M64;
  acc = rotl(acc, 31n);
  acc = mul(acc, P1);
  return acc;
}

export function xxh64(buf, seed = 0n) {
  const len = buf.length;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let h;
  let i = 0;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M64;
    let v2 = (seed + P2) & M64;
    let v3 = seed & M64;
    let v4 = (seed - P1) & M64;
    while (i + 32 <= len) {
      v1 = xxRound(v1, dv.getBigUint64(i, true));
      v2 = xxRound(v2, dv.getBigUint64(i + 8, true));
      v3 = xxRound(v3, dv.getBigUint64(i + 16, true));
      v4 = xxRound(v4, dv.getBigUint64(i + 24, true));
      i += 32;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    for (const v of [v1, v2, v3, v4]) {
      h ^= xxRound(0n, v);
      h = (mul(h, P1) + P4) & M64;
    }
  } else {
    h = (seed + P5) & M64;
  }
  h = (h + BigInt(len)) & M64;
  while (i + 8 <= len) {
    h ^= xxRound(0n, dv.getBigUint64(i, true));
    h = (mul(rotl(h, 27n), P1) + P4) & M64;
    i += 8;
  }
  if (i + 4 <= len) {
    h ^= mul(BigInt(dv.getUint32(i, true)), P1);
    h = (mul(rotl(h, 23n), P2) + P3) & M64;
    i += 4;
  }
  while (i < len) {
    h ^= mul(BigInt(buf[i]), P5);
    h = mul(rotl(h, 11n), P1);
    i += 1;
  }
  h ^= h >> 33n; h = mul(h, P2);
  h ^= h >> 29n; h = mul(h, P3);
  h ^= h >> 32n;
  return h & M64;
}

function toLEBytes64(v) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

/** Substrate twox128: xxh64(seed=0) || xxh64(seed=1), little-endian */
export function twox128(data) {
  const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(toLEBytes64(xxh64(b, 0n))) + bytesToHex(toLEBytes64(xxh64(b, 1n)));
}

/** Storage key for a pallet item: twox128(pallet) + twox128(item), 0x-prefixed */
export function storageKey(pallet, item) {
  return '0x' + twox128(pallet) + twox128(item);
}

// ---------- SCALE decoding ----------
export function decCompact(b, off = 0) {
  const mode = b[off] & 0b11;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mode === 0) return [BigInt(b[off] >> 2), 1];
  if (mode === 1) return [BigInt(dv.getUint16(off, true) >> 2), 2];
  if (mode === 2) return [BigInt(dv.getUint32(off, true) >>> 2), 4];
  const len = (b[off] >> 2) + 4;
  let v = 0n;
  for (let i = 0; i < len; i++) v |= BigInt(b[off + 1 + i]) << BigInt(8 * i);
  return [v, 1 + len];
}

export function decU32(b, off = 0) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
}
export function decU64(b, off = 0) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true);
}
export function decU128(b, off = 0) {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
}

// ---------- ss58 ----------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(b) {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}

export function ss58(pub, prefix = 42) {
  const payload = new Uint8Array(1 + pub.length);
  payload[0] = prefix;
  payload.set(pub, 1);
  const chk = blake2b(concatBytes(new TextEncoder().encode('SS58PRE'), payload), { dkLen: 64 }).slice(0, 2);
  return base58(concatBytes(payload, chk));
}

/** Vec<AccountId32>: compact length + 32-byte entries → ss58 list */
export function decVecAccountId(hex) {
  const b = hexToBytes(hex);
  const [cnt, off] = decCompact(b, 0);
  const out = [];
  for (let i = 0; i < Number(cnt); i++) out.push(ss58(b.subarray(off + i * 32, off + (i + 1) * 32)));
  return out;
}

// ---------- display utils ----------
export function abbreviate(addr, head = 6, tail = 4) {
  return addr.length > head + tail + 1 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

/** POT formatting: 14 decimals (native) */
export function formatPot(raw, dp = 2) {
  const whole = raw / 10n ** 14n;
  const frac = (raw % 10n ** 14n).toString().padStart(14, '0').slice(0, dp);
  return `${whole.toString()}.${frac}`;
}
