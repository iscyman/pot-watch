/**
 * alerts.ts — alert evaluator: in-process rules now, on-chain AlertRegistry in Phase 3.
 * Delivery: console + optional Discord webhook (Telegram bot lands with Phase 3).
 */
export interface AlertRule {
  kind: "era_rotation" | "validator_inactive" | "finality_lag";
  window?: number;        // blocks, for validator_inactive
  threshold?: number;     // blocks, for finality_lag
  enabled?: boolean;
}

export interface AlertEvent {
  rule: AlertRule;
  message: string;
  at: number;
  data?: Record<string, unknown>;
}

export class AlertEngine {
  private firedRecently = new Map<string, number>();
  constructor(private rules: AlertRule[], private webhookUrl?: string | null, private cooldownBlocks = 10) {}

  private key(e: AlertEvent) {
    return `${e.rule.kind}:${JSON.stringify(e.data ?? {})}`;
  }

  async evaluate(currentBlock: number, candidates: AlertEvent[]) {
    for (const e of candidates) {
      if (e.rule.enabled === false) continue;
      const k = this.key(e);
      const last = this.firedRecently.get(k);
      if (last !== undefined && currentBlock - last < this.cooldownBlocks) continue;
      this.firedRecently.set(k, currentBlock);
      await this.deliver(e);
    }
  }

  private async deliver(e: AlertEvent) {
    console.log(`🔔 ALERT [${e.rule.kind}] ${e.message}`);
    if (this.webhookUrl) {
      try {
        await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "POT Watch",
            embeds: [{ title: `🔔 ${e.rule.kind}`, description: e.message, color: 0x7c5cff, timestamp: new Date(e.at).toISOString() }],
          }),
        });
      } catch (err) {
        console.warn("webhook delivery failed:", (err as Error).message);
      }
    }
  }
}
