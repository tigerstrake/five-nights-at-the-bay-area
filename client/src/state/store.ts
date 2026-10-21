import { create } from 'zustand';
import type { CameraSourceStatus, MatchResult, PlayerView, RoomView } from '@fnab/shared';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'warn' | 'error' | 'good';
}

export type MapTool = 'inspect' | 'sensor' | 'trap' | 'scan' | 'lure';
export type MonsterTool = 'move' | 'sabotage' | 'decoy';

interface GameStore {
  connection: 'connecting' | 'online' | 'reconnecting';
  room: RoomView | null;
  view: PlayerView | null;
  /** Client receive time of `view` (local ms) for interpolation. */
  viewAt: number;
  result: MatchResult | null;
  cameraStatuses: Record<string, CameraSourceStatus>;
  clockOffset: number; // serverNow ≈ Date.now() + clockOffset
  rtt: number;
  toasts: Toast[];
  // UI state
  selectedCamera: string | null;
  selectedNode: string | null;
  mapTool: MapTool;
  monsterTool: MonsterTool;
  set: (p: Partial<GameStore>) => void;
  setRoom: (room: RoomView) => void;
  setView: (v: PlayerView) => void;
  setCameraStatuses: (s: CameraSourceStatus[]) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: number) => void;
}

let toastId = 1;

// Event / sighting ids are opaque (not monotonic; order within a tick is shuffled server-side). Normalise once:
// lists are ordered by match time `t` (stable), so "newest" = last everywhere. Never compare ids numerically.
const byT = <T extends { t: number }>(a: T[]): T[] => {
  for (let i = 1; i < a.length; i++) if (a[i - 1]!.t > a[i]!.t) return [...a].sort((x, y) => x.t - y.t);
  return a;
};
export function normalizeView(v: PlayerView): PlayerView {
  const events = byT(v.events);
  if (v.role === 'monster') return events === v.events ? v : { ...v, events };
  const sightings = byT(v.sightings);
  return events === v.events && sightings === v.sightings ? v : { ...v, events, sightings };
}
export function normalizeResult(r: MatchResult): MatchResult {
  const timeline = byT(r.timeline);
  const monsterPath = byT(r.monsterPath);
  return timeline === r.timeline && monsterPath === r.monsterPath ? r : { ...r, timeline, monsterPath };
}

/** Bounded "seen" set for opaque ids (detect new events without numeric comparisons). */
export class SeenIds<K = number> {
  private set = new Set<K>();
  constructor(private readonly max = 512) {}
  has(id: K): boolean {
    return this.set.has(id);
  }
  /** Marks `id` seen; returns true if it was new. */
  add(id: K): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value as K);
    return true;
  }
  clear(): void {
    this.set.clear();
  }
  get size(): number {
    return this.set.size;
  }
}

export const useGame = create<GameStore>((set, get) => ({
  connection: 'connecting',
  room: null,
  view: null,
  viewAt: 0,
  result: null,
  cameraStatuses: {},
  clockOffset: 0,
  rtt: 0,
  toasts: [],
  selectedCamera: null,
  selectedNode: null,
  mapTool: 'inspect',
  monsterTool: 'move',
  set: (p) => set(p),
  setRoom: (room) => {
    const prev = get().room;
    const patch: Partial<GameStore> = { room };
    if (room.stage === 'lobby' || room.stage === 'countdown') {
      if (prev?.stage === 'results' || prev?.stage === 'playing') patch.view = null;
      patch.result = null;
    }
    if (room.result) patch.result = normalizeResult(room.result);
    // rough offset until the first ping lands
    if (!get().rtt) patch.clockOffset = room.serverNow - Date.now();
    set(patch);
  },
  setView: (v) => set({ view: normalizeView(v), viewAt: Date.now() }),
  setCameraStatuses: (s) => set({ cameraStatuses: Object.fromEntries(s.map((x) => [x.cameraId, x])) }),
  toast: (text, kind = 'info') => {
    const id = toastId++;
    set({ toasts: [...get().toasts.slice(-4), { id, text, kind }] });
    setTimeout(() => get().dismiss(id), 3800);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Current server epoch estimate. */
export function serverNow(): number {
  return Date.now() + useGame.getState().clockOffset;
}

/** Current match time estimate (ms) for a view, interpolated between snapshots. */
export function matchNow(view: { t: number; t0Epoch: number; ended: boolean; pausedForReconnect?: boolean } | null): number {
  if (!view) return 0;
  // Ended, or paused for a whole-team reconnection grace: the night clock is frozen at the server's t.
  if (view.ended || view.pausedForReconnect) return view.t;
  return Math.max(view.t, serverNow() - view.t0Epoch);
}
