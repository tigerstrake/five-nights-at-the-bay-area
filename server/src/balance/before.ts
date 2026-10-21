// Frozen original values/scaling, solely for reproducible before/after measurements.
import type { BalanceConfig } from '@fnab/shared';
import snapshot from './before.json';
export const BEFORE_CONFIG = snapshot as BalanceConfig;
export function scaleBefore(count: number, base = BEFORE_CONFIG): BalanceConfig {
  const extra = Math.max(1, Math.floor(count)) - 1, c = structuredClone(base);
  const speed = 1 / (1 + 0.08 * Math.min(extra, 5));
  c.monster.baseEdgeMs = Math.round(base.monster.baseEdgeMs * speed);
  c.monster.msPerKm = base.monster.msPerKm * speed;
  c.monster.minEdgeMs = Math.round(base.monster.minEdgeMs * speed);
  c.detection.baseChance = base.detection.baseChance / (1 + 0.1 * Math.min(extra, 5));
  c.power.max = base.power.max + 20 * Math.min(extra, 4);
  c.sensors.maxCount = base.sensors.maxCount + Math.min(extra, 3);
  c.traps.maxCount = base.traps.maxCount + Math.floor(Math.min(extra, 4) / 2);
  c.repair.maxConcurrent = base.repair.maxConcurrent + Math.floor(Math.min(extra, 2) / 2);
  c.containment.struggleBreakMs = Math.round(base.containment.struggleBreakMs / (1 + 0.06 * Math.min(extra, 5)));
  c.breach.durationMs = Math.round(base.breach.durationMs / (1 + 0.05 * Math.min(extra, 5)));
  return c;
}
