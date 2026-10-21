// Human-readable view of scaleForDefenders(n): what changes as more defenders join.
import { DEFAULT_CONFIG, scaleForDefenders } from '@fnab/shared';

export interface ScalingLine {
  label: string;
  value: string;
  side: 'monster' | 'defenders';
  changed: boolean;
}

const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;

export function scalingSummary(defenders: number): ScalingLine[] {
  const b = DEFAULT_CONFIG;
  const c = scaleForDefenders(Math.max(1, defenders));
  const speed = b.monster.baseEdgeMs / c.monster.baseEdgeMs - 1;
  const detect = c.detection.baseChance / b.detection.baseChance - 1;
  const struggle = b.containment.struggleBreakMs / c.containment.struggleBreakMs - 1;
  const breach = b.breach.durationMs / c.breach.durationMs - 1;
  return [
    { label: 'Monster speed', value: pct(speed), side: 'monster', changed: Math.abs(speed) > 0.005 },
    { label: 'Chance a camera sees it', value: pct(detect), side: 'monster', changed: Math.abs(detect) > 0.005 },
    { label: 'Breaks free of traps', value: pct(struggle) + ' faster', side: 'monster', changed: Math.abs(struggle) > 0.005 },
    { label: 'Breach speed', value: pct(breach), side: 'monster', changed: Math.abs(breach) > 0.005 },
    { label: 'Power capacity', value: String(c.power.max), side: 'defenders', changed: c.power.max !== b.power.max },
    { label: 'Motion sensors', value: String(c.sensors.maxCount), side: 'defenders', changed: c.sensors.maxCount !== b.sensors.maxCount },
    { label: 'Traps', value: String(c.traps.maxCount), side: 'defenders', changed: c.traps.maxCount !== b.traps.maxCount },
    { label: 'Repair crews', value: String(c.repair.maxConcurrent), side: 'defenders', changed: c.repair.maxConcurrent !== b.repair.maxConcurrent },
  ];
}

/** One sentence: what the next defender to join would change. */
export function nextDefenderSummary(defenders: number): string {
  const now = scaleForDefenders(Math.max(1, defenders));
  const next = scaleForDefenders(Math.max(1, defenders) + 1);
  const parts: string[] = [];
  const speed = now.monster.baseEdgeMs / next.monster.baseEdgeMs - 1;
  if (speed > 0.005) parts.push(`monster ${pct(speed)} speed`);
  const det = next.detection.baseChance / now.detection.baseChance - 1;
  if (Math.abs(det) > 0.005) parts.push(`${pct(det)} camera detection`);
  if (next.power.max > now.power.max) parts.push(`+${next.power.max - now.power.max} power`);
  if (next.sensors.maxCount > now.sensors.maxCount) parts.push(`+${next.sensors.maxCount - now.sensors.maxCount} sensor`);
  if (next.traps.maxCount > now.traps.maxCount) parts.push(`+${next.traps.maxCount - now.traps.maxCount} trap`);
  return parts.length ? `Another defender: ${parts.join(', ')}.` : 'Scaling is at its cap; more defenders just add eyes.';
}
