// Camera source adapter interface. Real-world availability only — completely independent of fictional
// in-game camera status (sabotage/static live in the engine). Owner: Foundation (interface + simulation);
// the real Caltrans adapter (wave 2) implements CameraService.
import type { CameraRecord, CameraSourceStatus } from '@fnab/shared';

export type CameraMode = 'auto' | 'live' | 'snapshot' | 'simulation';

/**
 * Implementations must only report `streamUrl` for cameras whose stream is actually playable (verified by a
 * runtime probe; `verified.streamPlayable` from curation only decides how eagerly a stream is trusted) and must
 * never report a Caltrans "Temporarily Unavailable" placeholder snapshot as live or snapshot. The real service
 * (`CaltransCameraService`) downgrades such cameras to `simulated` (labelled fallback) and never emits
 * `offline` (see docs/CAMERAS.md §7.2 for the rule).
 */
export interface CameraService {
  readonly mode: CameraMode;
  /** Begin polling/health-checking. Must never throw for network failures (report them per camera). */
  start(): Promise<void>;
  stop(): void;
  getStatuses(): CameraSourceStatus[];
  getStatus(cameraId: string): CameraSourceStatus | null;
  /** Called whenever any status changes. Returns unsubscribe. */
  subscribe(listener: (statuses: CameraSourceStatus[]) => void): () => void;
  /** Ops/debug summary for `/api/health`. */
  getHealth?(): CameraHealth;
  /** Per-camera probe internals for `/api/cameras?detail=1`. */
  getDiagnostics?(): CameraDiagnostics[];
}

export interface CameraHealth {
  mode: CameraMode;
  running: boolean;
  total: number;
  counts: Record<CameraSourceStatus['mode'], number>;
  /** Epoch of the most recent completed probe (null before the first). */
  lastCheckAt: number | null;
  checks: number;
  inflight: number;
  hosts: Array<{ host: string; breakerOpen: boolean; openUntil: number | null; failStreak: number }>;
}

export interface ProbeDiagnostics {
  state: 'unknown' | 'good' | 'bad';
  fails: number;
  successes: number;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  /** Technical reason / failure kind of the most recent probe. */
  last: string | null;
}

export interface CameraDiagnostics {
  cameraId: string;
  snapshot: ProbeDiagnostics;
  /** null when the camera has no published stream or the mode never probes streams. */
  stream: ProbeDiagnostics | null;
  curatedStreamPlayable: boolean;
}

export interface CameraServiceOptions {
  cameras: CameraRecord[];
  now?: () => number;
}
