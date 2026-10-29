/**
 * walker.ts — zero-dependency FRAME metadata (v14) parser + generic SCALE
 * value decoder.
 *
 * Why: security analytics need real chain events (slashes, transfers,
 * session rotations) and real stake figures (Staking.Ledger). Both live
 * behind metadata-typed SCALE blobs. This module parses the portable
 * registry once and then decodes ANY storage value by TypeId — the same
 * trick the dashboard uses for its backend-free chain reads, extended from
 * hand-picked keys to the full type system.
 *
 * Scope (deliberate): decode-only, no encoding; BitSequence unsupported
 * (unused by the pallets we read).
 */
import { decCompact, hexToBytes } from "./twox.js";

// ---------- tiny cursor ----------
export class Cur {
  constructor(public b: Uint8Array, public off = 0) {}
  u8(): number {
    return this.b[this.off++];
  }
  u16(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  u64(): bigint {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }
  u128(): bigint {
    let v = 0n;
    for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.off + i]);
    this.off += 16;
    return v;
  }
  bytes(n: number): Uint8Array {
    const s = this.b.subarray(this.off, this.off + n);
    this.off += n;
    return s;
  }
  hex(n: number): string {
    return "0x" + Buffer.from(this.bytes(n)).toString("hex");
  }
  str(): string {
    const [len, o] = decCompact(this.b, this.off);
    this.off += o;
    const s = Buffer.from(this.bytes(Number(len))).toString("utf8");
    return s;
  }
  compact(): bigint {
    const [v, o] = decCompact(this.b, this.off);
    this.off += o;
    return v;
  }
  option(): boolean {
    return this.u8() === 1;
  }
}

// ---------- registry types ----------
export interface SiField {
  name: string | null;
  type: number;
}
export interface SiVariant {
  name: string;
  index: number;
  fields: SiField[];
}
export type SiDef =
  | { kind: "primitive"; prim: string }
  | { kind: "compact"; type: number }
  | { kind: "array"; len: number; type: number }
  | { kind: "sequence"; type: number }
  | { kind: "tuple"; types: number[] }
  | { kind: "composite"; fields: SiField[] }
  | { kind: "variant"; variants: SiVariant[] }
  | { kind: "bitseq" };

export interface SiType {
  path: string[];
  def: SiDef;
}

export interface StorageItemMeta {
  name: string;
  /** 0 = Default, 1 = Optional */
  modifier: number;
  kind: "plain" | "map";
  /** plain: value type; map: key/value types */
  type: number;
  key?: number;
  value?: number;
  hashers?: number[];
}

export interface Registry {
  version: number;
  types: SiType[];
}

function parseDef(c: Cur): SiDef {
  const tag = c.u8();
  switch (tag) {
    case 0: { // composite
      const n = Number(c.compact());
      const fields: SiField[] = [];
      for (let i = 0; i < n; i++) {
        const name = c.option() ? c.str() : null;
        const type = Number(c.compact());
        if (c.option()) c.str(); // typeName
        const dn = Number(c.compact());
        for (let d = 0; d < dn; d++) c.str();
        fields.push({ name, type });
      }
      return { kind: "composite", fields };
    }
    case 1: { // variant
      const n = Number(c.compact());
      const variants: SiVariant[] = [];
      for (let i = 0; i < n; i++) {
        const name = c.str();
        const fn = Number(c.compact());
        const fields: SiField[] = [];
        for (let f = 0; f < fn; f++) {
          const fname = c.option() ? c.str() : null;
          const ftype = Number(c.compact());
          if (c.option()) c.str();
          const dn = Number(c.compact());
          for (let d = 0; d < dn; d++) c.str();
          fields.push({ name: fname, type: ftype });
        }
        const index = c.u8();
        const dn = Number(c.compact());
        for (let d = 0; d < dn; d++) c.str();
        variants.push({ name, index, fields });
      }
      return { kind: "variant", variants };
    }
    case 2:
      return { kind: "sequence", type: Number(c.compact()) };
    case 3:
      return { kind: "array", len: c.u32(), type: Number(c.compact()) };
    case 4: {
      const n = Number(c.compact());
      const types: number[] = [];
      for (let i = 0; i < n; i++) types.push(Number(c.compact()));
      return { kind: "tuple", types };
    }
    case 5: {
      const prims = ["bool", "char", "str", "u8", "u16", "u32", "u64", "u128", "u256", "i8", "i16", "i32", "i64", "i128", "i256"];
      return { kind: "primitive", prim: prims[c.u8()] ?? "u8" };
    }
    case 6:
      return { kind: "compact", type: Number(c.compact()) };
    case 7:
      c.compact();
      c.compact();
      return { kind: "bitseq" };
    default:
      throw new Error(`unknown SiTypeDef tag ${tag}`);
  }
}

/** Parse state_getMetadata output (RuntimeMetadataPrefixed, v14). */
export function parseMetadata(hex: string): Registry {
  const c = new Cur(hexToBytes(hex));
  const magic = c.u32();
  if (magic !== 0x6174656d) throw new Error(`bad metadata magic 0x${magic.toString(16)}`);
  const version = c.u8();
  if (version !== 14) throw new Error(`unsupported metadata version ${version} (walker handles v14)`);

  // ---- portable registry ----
  const nTypes = Number(c.compact());
  const types: SiType[] = [];
  for (let i = 0; i < nTypes; i++) {
    c.compact(); // id (sequential)
    const np = Number(c.compact());
    const path: string[] = [];
    for (let p = 0; p < np; p++) path.push(c.str());
    const npar = Number(c.compact());
    for (let p = 0; p < npar; p++) {
      c.str();
      if (c.option()) c.compact();
    }
    const def = parseDef(c);
    const nd = Number(c.compact());
    for (let d = 0; d < nd; d++) c.str();
    types.push({ path, def });
  }

  return { version, types };
}

// ---------- shape discovery (no pallet-section parsing needed) ----------
/** TypeId of sp_core::crypto::AccountId32 ([u8;32]) */
export function findAccountId32(reg: Registry): number {
  const id = reg.types.findIndex((t) => t.path.join("::") === "sp_core::crypto::AccountId32");
  if (id < 0) throw new Error("AccountId32 not in registry");
  return id;
}

/** TypeId of Vec<EventRecord>: sequence of composite {phase,event,topics} */
export function findEventRecord(reg: Registry): number {
  for (let id = 0; id < reg.types.length; id++) {
    const t = reg.types[id];
    if (t.def.kind !== "sequence") continue;
    const el = reg.types[t.def.type];
    if (
      el?.def.kind === "composite" &&
      el.def.fields.some((f) => f.name === "phase") &&
      el.def.fields.some((f) => f.name === "event") &&
      el.def.fields.some((f) => f.name === "topics")
    ) {
      return t.def.type;
    }
  }
  throw new Error("EventRecord type not found in registry");
}

/** TypeId of the staking Ledger struct (composite with an `active` field) */
export function findStakingLedger(reg: Registry): number {
  for (let id = 0; id < reg.types.length; id++) {
    const t = reg.types[id];
    if (t.path.length && t.path[t.path.length - 1].endsWith("Ledger") && t.def.kind === "composite" && t.def.fields.some((f) => f.name === "active")) {
      return id;
    }
  }
  throw new Error("staking Ledger type not found in registry");
}

// ---------- generic value decoder ----------
export type Decoded = any;

export class Decoder {
  constructor(public reg: Registry) {}

  /** Decode one value of the given Si type from the cursor. */
  decode(typeId: number, c: Cur): Decoded {
    const t = this.reg.types[typeId];
    if (!t) throw new Error(`unknown type id ${typeId}`);
    const d = t.def;
    switch (d.kind) {
      case "primitive":
        switch (d.prim) {
          case "bool":
            return c.u8() === 1;
          case "u8":
            return c.u8();
          case "u16":
            return c.u16();
          case "u32":
            return c.u32();
          case "u64":
            return c.u64();
          case "u128":
          case "u256":
            return d.prim === "u128" ? c.u128() : c.hex(32);
          case "str":
            return c.str();
          default:
            throw new Error(`unsupported primitive ${d.prim}`);
        }
      case "compact": {
        const inner = this.reg.types[d.type];
        if (inner?.def.kind === "primitive" && ["u128", "u256"].includes(inner.def.prim)) return c.compact();
        const v = c.compact();
        return Number(v);
      }
      case "array": {
        if (this.isU8(d.type)) return c.hex(d.len);
        const out: Decoded[] = [];
        for (let i = 0; i < d.len; i++) out.push(this.decode(d.type, c));
        return out;
      }
      case "sequence": {
        const n = Number(c.compact());
        if (this.isU8(d.type)) return c.hex(n);
        const out: Decoded[] = [];
        for (let i = 0; i < n; i++) out.push(this.decode(d.type, c));
        return out;
      }
      case "tuple":
        return d.types.map((tt) => this.decode(tt, c));
      case "composite": {
        // transparent newtype wrapper (e.g. AccountId32([u8;32])) → unwrap
        if (d.fields.length === 1 && d.fields[0].name === null) {
          return this.decode(d.fields[0].type, c);
        }
        if (d.fields.every((f) => f.name)) {
          const obj: Record<string, Decoded> = {};
          for (const f of d.fields) obj[f.name!] = this.decode(f.type, c);
          return obj;
        }
        return d.fields.map((f) => this.decode(f.type, c));
      }
      case "variant": {
        const tag = c.u8();
        const v = d.variants.find((x) => x.index === tag) ?? d.variants[tag];
        if (!v) throw new Error(`unknown variant tag ${tag}`);
        const obj: Record<string, Decoded> = { _variant: v.name };
        v.fields.forEach((f, i) => {
          obj[f.name ?? `f${i}`] = this.decode(f.type, c);
        });
        return obj;
      }
      default:
        throw new Error(`unsupported SiDef ${d.kind}`);
    }
  }

  isU8(typeId: number): boolean {
    const t = this.reg.types[typeId];
    return !!t && t.def.kind === "primitive" && t.def.prim === "u8";
  }

  /** Decode a storage value given the item metadata (handles Option modifier). */
  decodeStorage(item: StorageItemMeta, hex: string | null): Decoded {
    if (hex === null || hex === "0x") {
      if (item.modifier === 0) return null; // Optional
      throw new Error(`missing value for Default-modifier item ${item.name}`);
    }
    const c = new Cur(hexToBytes(hex));
    return this.decode(item.type, c);
  }


}
