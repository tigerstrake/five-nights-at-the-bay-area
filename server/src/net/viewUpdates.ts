import { VIEW_TRANSPORT_CONFIG, type PlayerView, type ViewDelta } from '@fnab/shared';

// Inputs are detached, role-filtered snapshots. No authoritative state is ever read by the encoder.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(k => Object.hasOwn(right, k) && equal(left[k], right[k]));
}

export type ViewEmission = { event: 'game:view'; data: PlayerView } | { event: 'game:delta'; data: ViewDelta };

// Broadcast batches share snapshots by role. Weak keys on BOTH snapshots avoid retaining a chain of
// past ticks while allowing teammates to reuse exactly the same field comparison work.
type Patch = Pick<ViewDelta, 'changes' | 'removed'>;
const comparisons = new WeakMap<PlayerView, WeakMap<PlayerView, Patch>>();
function changedFields(view: PlayerView, previous: PlayerView): Patch {
  let against = comparisons.get(view);
  if (!against) { against = new WeakMap(); comparisons.set(view, against); }
  const cached = against.get(previous);
  if (cached) return cached;
  const changes: Record<string, unknown> = {};
  const now = view as unknown as Record<string, unknown>, before = previous as unknown as Record<string, unknown>;
  for (const key of Object.keys(now)) {
    if (key === 'viewSequence' || now[key] === undefined) continue;
    if (!equal(now[key], before[key])) changes[key] = now[key];
  }
  // JSON drops `undefined`, so an optional field that disappears must be removed explicitly.
  const removed = Object.keys(before).filter(k => k !== 'viewSequence' && before[k] !== undefined && now[k] === undefined);
  const patch: Patch = removed.length ? { changes: changes as Partial<PlayerView>, removed } : { changes: changes as Partial<PlayerView> };
  against.set(previous, patch);
  return patch;
}

/** One bounded previous snapshot per recipient; reconnect/rebind starts with a full checkpoint. */
export class ViewEncoder {
  private previous: PlayerView | null = null;
  private sequence = 0;
  reset(): void { this.previous = null; }

  next(view: PlayerView): ViewEmission {
    const previous = this.previous, baseSequence = this.sequence;
    this.previous = view;
    const sequence = ++this.sequence;
    if (!previous || previous.role !== view.role || previous.ended || view.t < previous.t || view.hqId !== previous.hqId ||
      sequence % VIEW_TRANSPORT_CONFIG.fullEveryTicks === 0) {
      return { event: 'game:view', data: { ...view, viewSequence: sequence } };
    }
    return { event: 'game:delta', data: { baseSequence, sequence, ...changedFields(view, previous) } };
  }
}
