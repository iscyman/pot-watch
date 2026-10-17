/**
 * validators.ts — validator metrics engine: blocks authored, activity gaps, availability.
 */
export interface ValidatorStat {
  address: string;
  index: number;
  blocks: number;
  lastBlock: number | null;
  lastSeenAgo: number | null; // blocks since last authored
  sharePct: number;
  inactive: boolean;          // no block within window
}

export class ValidatorStats {
  private blocks = new Map<number, number>(); // index → count
  private lastSeen = new Map<number, number>(); // index → block number
  private total = 0;
  private latest = 0;

  constructor(public windowBlocks = 90) {} // ~9 min at 6s blocks

  record(blockNumber: number, authorIndex: number | null, validatorCount: number) {
    this.latest = blockNumber;
    if (authorIndex === null || authorIndex < 0 || authorIndex >= validatorCount) return;
    this.total++;
    this.blocks.set(authorIndex, (this.blocks.get(authorIndex) ?? 0) + 1);
    this.lastSeen.set(authorIndex, blockNumber);
  }

  summarize(validators: string[]): ValidatorStat[] {
    return validators.map((address, index) => {
      const last = this.lastSeen.get(index) ?? null;
      const blocks = this.blocks.get(index) ?? 0;
      const lastSeenAgo = last !== null ? this.latest - last : null;
      return {
        address,
        index,
        blocks,
        lastBlock: last,
        lastSeenAgo,
        sharePct: this.total ? (blocks / this.total) * 100 : 0,
        inactive: lastSeenAgo === null || lastSeenAgo > this.windowBlocks,
      };
    });
  }

  /** fraction of validators that authored at least once within the window */
  availability(validators: string[]): number {
    const stats = this.summarize(validators);
    const active = stats.filter((s) => !s.inactive).length;
    return stats.length ? active / stats.length : 0;
  }

  /** Herfindahl index over authored-block shares (decentralization proxy) */
  hhi(validators: string[]): number {
    const stats = this.summarize(validators);
    return stats.reduce((acc, s) => acc + (s.sharePct / 100) ** 2, 0);
  }
}
