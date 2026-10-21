// "Establishing secure uplink": real readiness checks run during the countdown (or on resume), each with a
// timeout. Nothing here can block the match forever; `done` turns true once every check settled or timed out.
import { create } from 'zustand';
import type { CameraSourceStatus, HqId } from '@fnab/shared';
import { useGame } from '../../state/store';
import { NETWORK, graph } from '../../lib/data';
import { loadUiAssets } from '../../ui/assets';

export type CheckState = 'pending' | 'ok' | 'degraded' | 'timeout';
export interface UplinkCheck {
  id: 'link' | 'clock' | 'registry' | 'frames' | 'state';
  label: string;
  state: CheckState;
  detail: string;
}

interface UplinkStore {
  key: string | null;
  startedAt: number;
  checks: UplinkCheck[];
  done: boolean;
}

export const useUplink = create<UplinkStore>(() => ({ key: null, startedAt: 0, checks: [], done: false }));

/** How many cameras nearest the HQ get their first frame prefetched. */
const FRAME_RADIUS_HOPS = 3;
const FRAME_LIMIT = 12;

let timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
let unsub: (() => void) | null = null;

function patch(id: UplinkCheck['id'], p: Partial<UplinkCheck>) {
  const s = useUplink.getState();
  const checks = s.checks.map((c) => (c.id === id && c.state === 'pending' ? { ...c, ...p } : c));
  useUplink.setState({ checks, done: checks.every((c) => c.state !== 'pending') });
}

function prefetchFrames(hqId: HqId, statuses: Record<string, CameraSourceStatus>, timeoutMs: number) {
  const near = NETWORK.nodes
    .filter((n) => n.cameraId)
    .map((n) => ({ cam: n.cameraId!, hops: graph.hopsToHq(n.id, hqId) }))
    .filter((x) => x.hops <= FRAME_RADIUS_HOPS)
    .sort((a, b) => a.hops - b.hops)
    .slice(0, FRAME_LIMIT);
  const real = near.filter((x) => {
    const st = statuses[x.cam];
    return st?.snapshotUrl && (st.mode === 'snapshot' || st.mode === 'live');
  });
  const simulated = near.length - real.length;
  if (!real.length) {
    patch('frames', {
      state: 'ok',
      detail: near.length ? `${simulated} near HQ · simulated (no real source)` : 'no cameras near HQ',
    });
    return;
  }
  let loaded = 0;
  let failed = 0;
  const update = (final = false) => {
    const settled = loaded + failed;
    const detail = `${loaded}/${real.length} real${failed ? ` · ${failed} unreachable` : ''}${simulated ? ` · ${simulated} simulated` : ''}`;
    if (settled === real.length) patch('frames', { state: failed && !loaded ? 'degraded' : 'ok', detail });
    else if (final) patch('frames', { state: 'timeout', detail: detail + ' · continuing' });
    else useUplink.setState({ checks: useUplink.getState().checks.map((c) => (c.id === 'frames' ? { ...c, detail } : c)) });
  };
  update();
  for (const x of real) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      loaded++;
      update();
    };
    img.onerror = () => {
      failed++;
      update();
    };
    img.src = statuses[x.cam]!.snapshotUrl!;
  }
  timers.push(setTimeout(() => update(true), timeoutMs));
}

/**
 * Start (or keep running) the uplink checks for one match. `key` identifies the match so re-renders don't restart it.
 * `timeoutMs` bounds every check.
 */
export function startUplink(key: string, hqId: HqId, timeoutMs: number) {
  if (useUplink.getState().key === key) return;
  stopUplink();
  const now = Date.now();
  useUplink.setState({
    key,
    startedAt: now,
    done: false,
    checks: [
      { id: 'link', label: 'Server link', state: 'pending', detail: 'handshake' },
      { id: 'clock', label: 'Clock sync', state: 'pending', detail: 'measuring' },
      { id: 'registry', label: 'Camera registry', state: 'pending', detail: 'requesting' },
      { id: 'frames', label: 'First frames', state: 'pending', detail: 'waiting for registry' },
      { id: 'state', label: 'Match state', state: 'pending', detail: 'waiting for server' },
    ],
  });
  void loadUiAssets().then((a) => {
    // results art, so the post-match screen is instant
    for (const src of [a.defeat, a.victory]) if (src) new Image().src = src;
  });

  let framesStarted = false;
  let registryFetched = false;
  const evaluate = () => {
    const g = useGame.getState();
    if (g.connection === 'online') patch('link', { state: 'ok', detail: 'connected' });
    // rtt stays 0 until the first ping returns; on localhost a real sample can also round to 0 ms.
    if (g.rtt > 0) patch('clock', { state: 'ok', detail: `${Math.round(g.rtt)} ms round trip` });
    else if (g.connection === 'online' && Date.now() - now > 1200) patch('clock', { state: 'ok', detail: 'under 1 ms round trip' });
    const statuses = g.cameraStatuses;
    const n = Object.keys(statuses).length;
    if (n > 0) {
      const counts = { live: 0, snapshot: 0, simulated: 0, offline: 0 };
      for (const s of Object.values(statuses)) counts[s.mode]++;
      const parts = [
        counts.live && `${counts.live} live`,
        counts.snapshot && `${counts.snapshot} snapshot`,
        counts.simulated && `${counts.simulated} simulated`,
        counts.offline && `${counts.offline} offline`,
      ].filter(Boolean);
      patch('registry', { state: 'ok', detail: parts.join(' · ') });
      if (!framesStarted) {
        framesStarted = true;
        prefetchFrames(hqId, statuses, Math.max(800, timeoutMs - (Date.now() - now)));
      }
    } else if (!registryFetched && Date.now() - now > 1500) {
      // the socket push hasn't arrived: ask the REST endpoint directly
      registryFetched = true;
      fetch('/api/cameras')
        .then((r) => (r.ok ? (r.json() as Promise<CameraSourceStatus[]>) : null))
        .then((list) => Array.isArray(list) && list.length && useGame.getState().setCameraStatuses(list))
        .catch(() => undefined);
    }
    if (g.view && g.room?.stage === 'playing') patch('state', { state: 'ok', detail: `t+${(g.view.t / 1000).toFixed(1)} s` });
    else if (g.room?.stage === 'countdown') {
      const st = useUplink.getState().checks.find((c) => c.id === 'state');
      if (st?.state === 'pending' && st.detail !== 'standing by for start') {
        useUplink.setState({ checks: useUplink.getState().checks.map((c) => (c.id === 'state' ? { ...c, detail: 'standing by for start' } : c)) });
      }
    }
  };
  evaluate();
  unsub = useGame.subscribe(evaluate);
  timers.push(setInterval(evaluate, 250));
  // Hard ceiling: whatever hasn't answered is marked as timed out (the match never waits on it).
  timers.push(
    setTimeout(() => {
      for (const c of useUplink.getState().checks) if (c.state === 'pending' && c.id !== 'state') patch(c.id, { state: 'timeout', detail: `${c.detail} · no answer, continuing` });
    }, timeoutMs),
  );
}

/** The match-state check alone can outlive the countdown; App calls this once the first view lands or times out. */
export function settleMatchState(detail: string, state: CheckState = 'timeout') {
  patch('state', { state, detail });
}

export function stopUplink() {
  timers.forEach((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  timers = [];
  unsub?.();
  unsub = null;
}

export function resetUplink() {
  stopUplink();
  useUplink.setState({ key: null, startedAt: 0, checks: [], done: false });
}
