// Frozen previous 45–65 s / 15 s arming tuning. Comparison only, never production defaults.
import type { BalanceConfig } from '@fnab/shared';
import snapshot from './slow.json';
export const SLOW_CONFIG = snapshot as BalanceConfig;
export function scaleSlow(count: number, base = SLOW_CONFIG): BalanceConfig {
  const extra = Math.max(1, Math.floor(count)) - 1, c = structuredClone(base);
  const speed = 1 / (1 + 0.04 * Math.min(extra, 5));
  c.monster.baseEdgeMs = Math.round(base.monster.baseEdgeMs * speed);
  c.monster.msPerKm = base.monster.msPerKm * speed;
  c.monster.minEdgeMs = Math.round(base.monster.minEdgeMs * speed);
  c.detection.baseChance = base.detection.baseChance / (1 + 0.1 * Math.min(extra, 5));
  c.power.max = base.power.max + 6 * Math.min(extra, 4);
  c.sensors.maxCount = base.sensors.maxCount + Math.min(extra, 3);
  c.traps.maxCount = base.traps.maxCount + Math.floor(Math.min(extra, 4) / 2);
  c.repair.maxConcurrent = base.repair.maxConcurrent + Math.floor(Math.min(extra, 2) / 2);
  c.containment.struggleBreakMs = Math.round(base.containment.struggleBreakMs / (1 + 0.06 * Math.min(extra, 2) + 0.03 * Math.max(0, Math.min(extra, 5) - 2)));
  c.breach.durationMs = Math.round(base.breach.durationMs / (1 + 0.05 * Math.min(extra, 5)));
  return c;
}
