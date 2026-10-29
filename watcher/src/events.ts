/**
 * events.ts — decode `System.Events` for any block into named events, and
 * extract the security-relevant ones (slashes, large transfers, sessions).
 *
 * Uses the generic metadata walker (walker.ts): no hard-coded pallet indices,
 * everything resolved from the chain's own portable registry at runtime.
 */
import type { Rpc } from "./rpc.js";
import { Cur, Decoder, parseMetadata, findEventRecord, type Registry } from "./walker.js";
import { storageKey, hexToBytes } from "./twox.js";

export interface NamedEvent {
  pallet: string;
  name: string;
  fields: Record<string, any>;
  /** index of the extrinsic that emitted it, or null for inherent/finalization phase */
  extrinsicIndex: number | null;
}

const EVENTS_KEY = storageKey("System", "Events");

export class EventReader {
  private decoder: Decoder | null = null;
  private outerEventTypeId: number | null = null;
  private recordTypeId: number | null = null;

  constructor(private rpc: Rpc) {}

  async init(): Promise<void> {
    const hex = await this.rpc.call<string>("state_getMetadata", []);
    const reg: Registry = parseMetadata(hex);
    this.decoder = new Decoder(reg);
    // discover Vec<EventRecord> by shape (robust to metadata layout changes)
    this.recordTypeId = findEventRecord(reg);
    const rec = reg.types[this.recordTypeId];
    const eventField = rec.def.kind === "composite" ? rec.def.fields.find((f) => f.name === "event") : null;
    if (!eventField) throw new Error("EventRecord.event field not found");
    this.outerEventTypeId = eventField.type;
  }

  get registry(): Registry | null {
    return this.decoder?.reg ?? null;
  }

  /** All events of one block, decoded and named. */
  async eventsAt(blockHash: string): Promise<NamedEvent[]> {
    if (!this.decoder || this.recordTypeId === null || this.outerEventTypeId === null) {
      throw new Error("EventReader not initialised");
    }
    const raw = await this.rpc.getStorage(EVENTS_KEY, blockHash);
    if (!raw || raw === "0x") return [];
    const c = new Cur(hexToBytes(raw));
    const n = Number(c.compact());
    const out: NamedEvent[] = [];
    const reg = this.decoder.reg;
    for (let i = 0; i < n; i++) {
      // EventRecord { phase, event, topics }
      const rec = this.decoder.decode(this.recordTypeId, c) as Record<string, any>;
      const phase = rec.phase;
      const ev = rec.event as Record<string, any>;
      const palletName = ev._variant as string;
      // outer-enum variant carries the pallet's event enum as its (unnamed) field 0
      const inner = ev.f0 as Record<string, any> | undefined;
      const name = inner?._variant ?? "?";
      const fields: Record<string, any> = {};
      if (inner) for (const [k, v] of Object.entries(inner)) if (k !== "_variant") fields[k] = v;
      out.push({
        pallet: palletName,
        name,
        fields,
        extrinsicIndex: phase?._variant === "ApplyExtrinsic" ? Number(phase.f0) : null,
      });
    }
    void reg;
    return out;
  }

}

// ---------- security-relevant extraction ----------
export interface SlashHit {
  who: string;          // 0x account
  amount: bigint;       // raw units
  source: string;       // e.g. Staking.Slashed
  block: number;
}

export function extractSlashes(events: NamedEvent[], block: number): SlashHit[] {
  const hits: SlashHit[] = [];
  for (const e of events) {
    if (e.pallet === "Staking" && e.name === "Slashed") {
      hits.push({ who: String(e.fields.staker), amount: BigInt(e.fields.amount), source: "Staking.Slashed", block });
    } else if (e.pallet === "Balances" && e.name === "Slashed") {
      hits.push({ who: String(e.fields.who), amount: BigInt(e.fields.amount), source: "Balances.Slashed", block });
    } else if (e.pallet === "Staking" && e.name === "SlashReported") {
      hits.push({ who: String(e.fields.validator), amount: 0n, source: "Staking.SlashReported", block });
    }
  }
  return hits;
}

export function extractTransfers(events: NamedEvent[]): { from: string; to: string; amount: bigint }[] {
  return events
    .filter((e) => e.pallet === "Balances" && e.name === "Transfer")
    .map((e) => ({ from: String(e.fields.from), to: String(e.fields.to), amount: BigInt(e.fields.amount) }));
}

export function extractNewSession(events: NamedEvent[]): number | null {
  const e = events.find((x) => x.pallet === "Session" && x.name === "NewSession");
  return e ? Number(e.fields.session_index) : null;
}
