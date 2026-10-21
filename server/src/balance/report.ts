import type { MatchMeasurement } from './harness';
import { PHASES } from './harness';

export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * p;
  return sorted[Math.floor(pos)] + (sorted[Math.ceil(pos)] - sorted[Math.floor(pos)]) * (pos % 1);
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const distribution = (v: number[]) => ({ n: v.length, p10: quantile(v, 0.1), median: quantile(v, 0.5), p90: quantile(v, 0.9) });
export function summarize(matches: MatchMeasurement[]) {
  const n = matches.length;
  const breaches = matches.filter(m => m.reason === 'breach');
  const captures = matches.filter(m => m.reason === 'capture').length;
  const attempts = sum(matches.map(m => m.stats.containmentAttempts));
  const armed = sum(matches.map(m => m.stats.trapsArmed));
  const hits = sum(matches.map(m => m.stats.trapsTriggered));
  const rate = breaches.length / Math.max(1, n), z = 1.96, denom = 1 + z * z / Math.max(1, n);
  const center = (rate + z * z / (2 * Math.max(1, n))) / denom;
  const margin = z * Math.sqrt((rate * (1 - rate) + z * z / (4 * Math.max(1, n))) / Math.max(1, n)) / denom;
  const seconds = [...new Set(matches.flatMap(m => m.power.map(p => p.second)))].sort((a, b) => a - b);
  return {
    matches: n, monsterWinRate: rate, monsterWin95: [center - margin, center + margin],
    breach: breaches.length, capture: captures, survive: matches.filter(m => m.reason === 'timer').length,
    breachSeconds: distribution(breaches.map(m => m.durationMs / 1000)),
    captureAttempts: attempts, captureSuccessRate: captures / Math.max(1, attempts),
    trappedSeconds: distribution(matches.map(m => m.trappedMs / 1000)),
    blackoutFrequency: matches.filter(m => m.stats.powerOutages > 0).length / Math.max(1, n),
    blackoutsPerMatch: sum(matches.map(m => m.stats.powerOutages)) / Math.max(1, n),
    // Conditional on still playing: retain the denominator to expose survivorship bias.
    powerCurve: seconds.map(second => { const values = matches.flatMap(m => m.power.filter(p => p.second === second).map(p => p.value));
      return { second, alive: values.length, median: quantile(values, 0.5) }; }),
    meanDoorUptime: sum(matches.map(m => m.doorUptime)) / Math.max(1, n),
    doorJams: sum(matches.map(m => m.doorJams)), trapsArmed: armed, trapsHit: hits, trapHitRate: hits / Math.max(1, armed),
    sabotageRepairSeconds: distribution(matches.flatMap(m => m.repairLatencyMs.map(t => t / 1000))),
    unrepairedSabotages: sum(matches.map(m => m.unrepairedSabotages)),
    sightingsPerMinute: Object.fromEntries(PHASES.map(p => [p, sum(matches.map(m => m.sightings[p])) / Math.max(1, sum(matches.map(m => m.phaseMs[p]))) * 60_000])),
    distanceKm: distribution(matches.map(m => m.distanceKm)),
    earlyEndRate: matches.filter(m => m.earlyEnd).length / Math.max(1, n),
    lastThirdShareOfBreaches: matches.filter(m => m.lastThirdBreach).length / Math.max(1, breaches.length),
    rejectedActions: { defenders: sum(matches.map(m => m.actions.rejectedDefenders)), monster: sum(matches.map(m => m.actions.rejectedMonster)) },
  };
}
export function report(matches: MatchMeasurement[]) {
  const groups = (key: (m: MatchMeasurement) => string) => {
    const grouped = new Map<string, MatchMeasurement[]>();
    for (const m of matches) { const k = key(m); if (!grouped.has(k)) grouped.set(k, []); grouped.get(k)!.push(m); }
    return Object.fromEntries([...grouped].map(([k, cell]) => [k, summarize(cell)]));
  };
  return { overall: summarize(matches), byHq: groups(m => m.hq), byDefenders: groups(m => String(m.defenders)),
    byPairing: groups(m => `${m.skill}/${m.monster}`), cells: groups(m => `${m.hq}/${m.defenders}/${m.skill}`),
    policyCells: groups(m => `${m.hq}/${m.defenders}/${m.skill}/${m.monster}`) };
}
export function tableRow(label: string, matches: MatchMeasurement[]): string {
  const s = summarize(matches);
  return `${label.padEnd(24)} ${String(s.matches).padStart(5)} ${(s.monsterWinRate * 100).toFixed(1).padStart(6)}% ${String(s.capture).padStart(5)} ${String(s.survive).padStart(5)} ${String(s.breachSeconds.median?.toFixed(1) ?? '-').padStart(7)} ${(s.lastThirdShareOfBreaches * 100).toFixed(0).padStart(5)}%`;
}
