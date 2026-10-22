import type { PlayerView, ViewDelta } from '@fnab/shared';

/** Reject late/duplicate/missing-base updates; a full checkpoint is required after a gap. */
export function applyViewDelta(previous: PlayerView | null, delta: ViewDelta): PlayerView | null {
  if (!previous || previous.viewSequence !== delta.baseSequence || delta.sequence !== delta.baseSequence + 1 ||
    (delta.changes.role !== undefined && delta.changes.role !== previous.role)) return null;
  const next = { ...previous, ...delta.changes, viewSequence: delta.sequence } as Record<string, unknown>;
  for (const key of delta.removed ?? []) if (key !== 'role' && key !== 'viewSequence') delete next[key];
  return next as unknown as PlayerView;
}
