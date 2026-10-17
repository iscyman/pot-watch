/**
 * health.ts — composite network health score (0–100).
 */
export interface HealthInput {
  finalityLag: number;
  availability: number;     // 0..1
  blockTimeAvgS: number;
  blockTimeTargetS: number;
  hhi: number;              // 0..1, lower = better distributed
  slashEvents30d: number;
}

export interface HealthResult {
  score: number;
  grade: string;
  components: Record<string, { score: number; weight: number }>;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function computeHealth(inp: HealthInput): HealthResult {
  const components = {
    finality: { score: clamp(100 - inp.finalityLag * 15), weight: 0.25 },
    availability: { score: clamp(inp.availability * 100), weight: 0.3 },
    blockTime: {
      score: clamp(100 - Math.abs(inp.blockTimeAvgS - inp.blockTimeTargetS) * 40),
      weight: 0.2,
    },
    decentralization: { score: clamp((1 - inp.hhi) * 130), weight: 0.15 },
    security: { score: clamp(100 - inp.slashEvents30d * 25), weight: 0.1 },
  };
  let score = 0;
  for (const c of Object.values(components)) score += c.score * c.weight;
  score = Math.round(score);
  const grade =
    score >= 90 ? "EXCELLENT" : score >= 75 ? "GOOD" : score >= 60 ? "FAIR" : "DEGRADED";
  return {
    score,
    grade,
    components: Object.fromEntries(
      Object.entries(components).map(([k, c]) => [k, { score: Math.round(c.score), weight: c.weight }])
    ),
  };
}
