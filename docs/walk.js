/**
 * walk.js — browser port of watcher/src/walker.ts (zero-dependency FRAME
 * metadata walker). Parses the portable registry from state_getMetadata and
 * decodes ANY storage value / event by TypeId. Same algorithms as the
 * watcher; kept in sync manually (see watcher/test/walker.test.ts).
 */
export class Cur {
  constructor(b, off = 0) { this.b = b; this.off = off; }
  u8() { return this.b[this.off++]; }
  u16() { const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getUint16(this.off, true); this.off += 2; return v; }
  u32() { const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getUint32(this.off, true); this.off += 4; return v; }
  u64() { const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getBigUint64(this.off, true); this.off += 8; return v; }
  u128() { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.off + i]); this.off += 16; return v; }
  bytes(n) { const s = this.b.subarray(this.off, this.off + n); this.off += n; return s; }
  hex(n) { return '0x' + [...this.bytes(n)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  str() { const [len, o] = decCompactLocal(this.b, this.off); this.off += o; return new TextDecoder().decode(this.bytes(Number(len))); }
  compact() { const [v, o] = decCompactLocal(this.b, this.off); this.off += o; return v; }
  option() { return this.u8() === 1; }
}

function decCompactLocal(b, off = 0) {
  const mode = b[off] & 0b11;
  if (mode === 0) return [BigInt(b[off] >> 2), 1];
  if (mode === 1) return [BigInt(new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(off, true) >> 2), 2];
  if (mode === 2) return [BigInt(new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true) >>> 2), 4];
  const len = (b[off] >> 2) + 4;
  let v = 0n;
  for (let i = 0; i < len; i++) v |= BigInt(b[off + 1 + i]) << BigInt(8 * i);
  return [v, 1 + len];
}

export function hexToBytesLocal(hex) {
  const h = hex.replace(/^0x/, '');
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function parseDef(c) {
  const tag = c.u8();
  if (tag === 0) {
    const n = Number(c.compact()); const fields = [];
    for (let i = 0; i < n; i++) {
      const name = c.option() ? c.str() : null;
      const type = Number(c.compact());
      if (c.option()) c.str();
      const dn = Number(c.compact()); for (let d = 0; d < dn; d++) c.str();
      fields.push({ name, type });
    }
    return { kind: 'composite', fields };
  }
  if (tag === 1) {
    const n = Number(c.compact()); const variants = [];
    for (let i = 0; i < n; i++) {
      const name = c.str();
      const fn = Number(c.compact()); const fields = [];
      for (let f = 0; f < fn; f++) {
        const fname = c.option() ? c.str() : null;
        const ftype = Number(c.compact());
        if (c.option()) c.str();
        const dn = Number(c.compact()); for (let d = 0; d < dn; d++) c.str();
        fields.push({ name: fname, type: ftype });
      }
      const index = c.u8();
      const dn = Number(c.compact()); for (let d = 0; d < dn; d++) c.str();
      variants.push({ name, index, fields });
    }
    return { kind: 'variant', variants };
  }
  if (tag === 2) return { kind: 'sequence', type: Number(c.compact()) };
  if (tag === 3) return { kind: 'array', len: c.u32(), type: Number(c.compact()) };
  if (tag === 4) { const n = Number(c.compact()); const types = []; for (let i = 0; i < n; i++) types.push(Number(c.compact())); return { kind: 'tuple', types }; }
  if (tag === 5) { const P = ['bool', 'char', 'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'u256', 'i8', 'i16', 'i32', 'i64', 'i128', 'i256']; return { kind: 'primitive', prim: P[c.u8()] ?? 'u8' }; }
  if (tag === 6) return { kind: 'compact', type: Number(c.compact()) };
  if (tag === 7) { c.compact(); c.compact(); return { kind: 'bitseq' }; }
  throw new Error('unknown SiTypeDef tag ' + tag);
}

/** Parse only magic + version + portable registry (lookup). */
export function parseLookup(hex) {
  const c = new Cur(hexToBytesLocal(hex));
  if (c.u32() !== 0x6174656d) throw new Error('bad metadata magic');
  const version = c.u8();
  if (version !== 14) throw new Error('walker handles metadata v14, got ' + version);
  const n = Number(c.compact());
  const types = [];
  for (let i = 0; i < n; i++) {
    c.compact();
    const np = Number(c.compact()); const path = [];
    for (let p = 0; p < np; p++) path.push(c.str());
    const npar = Number(c.compact());
    for (let p = 0; p < npar; p++) { c.str(); if (c.option()) c.compact(); }
    const def = parseDef(c);
    const nd = Number(c.compact()); for (let d = 0; d < nd; d++) c.str();
    types.push({ path, def });
  }
  return { version, types };
}

export function findAccountId32(reg) {
  const id = reg.types.findIndex((t) => t.path.join('::') === 'sp_core::crypto::AccountId32');
  if (id < 0) throw new Error('AccountId32 not in registry');
  return id;
}

export function findEventRecord(reg) {
  for (let id = 0; id < reg.types.length; id++) {
    const t = reg.types[id];
    if (t.def.kind !== 'sequence') continue;
    const el = reg.types[t.def.type];
    if (el?.def.kind === 'composite' &&
      el.def.fields.some((f) => f.name === 'phase') &&
      el.def.fields.some((f) => f.name === 'event') &&
      el.def.fields.some((f) => f.name === 'topics')) return t.def.type;
  }
  throw new Error('EventRecord not found');
}

export function findStakingLedger(reg) {
  for (let id = 0; id < reg.types.length; id++) {
    const t = reg.types[id];
    if (t.path.length && t.path[t.path.length - 1].endsWith('Ledger') &&
      t.def.kind === 'composite' && t.def.fields.some((f) => f.name === 'active')) return id;
  }
  throw new Error('StakingLedger not found');
}

export class Decoder {
  constructor(reg) { this.reg = reg; }
  isU8(id) { const t = this.reg.types[id]; return !!t && t.def.kind === 'primitive' && t.def.prim === 'u8'; }
  decode(typeId, c) {
    const t = this.reg.types[typeId];
    if (!t) throw new Error('unknown type ' + typeId);
    const d = t.def;
    if (d.kind === 'primitive') {
      if (d.prim === 'bool') return c.u8() === 1;
      if (d.prim === 'u8') return c.u8();
      if (d.prim === 'u16') return c.u16();
      if (d.prim === 'u32') return c.u32();
      if (d.prim === 'u64') return c.u64();
      if (d.prim === 'u128') return c.u128();
      if (d.prim === 'str') return c.str();
      throw new Error('unsupported primitive ' + d.prim);
    }
    if (d.kind === 'compact') {
      const inner = this.reg.types[d.type];
      if (inner?.def.kind === 'primitive' && (inner.def.prim === 'u128' || inner.def.prim === 'u256')) return c.compact();
      return Number(c.compact());
    }
    if (d.kind === 'array') {
      if (this.isU8(d.type)) return c.hex(d.len);
      const out = []; for (let i = 0; i < d.len; i++) out.push(this.decode(d.type, c)); return out;
    }
    if (d.kind === 'sequence') {
      const n = Number(c.compact());
      if (this.isU8(d.type)) return c.hex(n);
      const out = []; for (let i = 0; i < n; i++) out.push(this.decode(d.type, c)); return out;
    }
    if (d.kind === 'tuple') return d.types.map((tt) => this.decode(tt, c));
    if (d.kind === 'composite') {
      if (d.fields.length === 1 && d.fields[0].name === null) return this.decode(d.fields[0].type, c);
      if (d.fields.every((f) => f.name)) { const o = {}; for (const f of d.fields) o[f.name] = this.decode(f.type, c); return o; }
      return d.fields.map((f) => this.decode(f.type, c));
    }
    if (d.kind === 'variant') {
      const tag = c.u8();
      const v = d.variants.find((x) => x.index === tag) ?? d.variants[tag];
      if (!v) throw new Error('unknown variant ' + tag);
      const o = { _variant: v.name };
      v.fields.forEach((f, i) => { o[f.name ?? `f${i}`] = this.decode(f.type, c); });
      return o;
    }
    throw new Error('unsupported def ' + d.kind);
  }
}
