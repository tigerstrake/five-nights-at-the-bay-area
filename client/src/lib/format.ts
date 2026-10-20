export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function clockTime(epoch: number): string {
  const d = new Date(epoch);
  return d.toLocaleTimeString('en-US', { hour12: false });
}
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}
export const PHASE_LABEL = {
  preparation: 'PREPARATION',
  infiltration: 'INFILTRATION',
  escalation: 'ESCALATION',
  final: 'FINAL ASSAULT',
} as const;
