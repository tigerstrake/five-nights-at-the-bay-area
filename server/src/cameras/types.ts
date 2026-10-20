// Camera source adapter interface. Real-world availability only — completely independent of fictional
// in-game camera status (sabotage/static live in the engine). Owner: Foundation (interface + simulation);
// the real Caltrans adapter (wave 2) implements CameraService.
import type { CameraRecord, CameraSourceStatus } from '@fnab/shared';

export type CameraMode = 'auto' | 'live' | 'snapshot' | 'simulation';

/**
 * Implementations must only report `streamUrl` for cameras whose stream is actually playable (curation flag
 * `verified.streamPlayable === true` — see `usableStreamUrl` in @fnab/shared — and/or a fresh runtime probe),
 * and must flag Caltrans "Temporarily Unavailable" placeholder snapshots as offline, not live.
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
}

export interface CameraServiceOptions {
  cameras: CameraRecord[];
  now?: () => number;
}
