import type { CameraSourceStatus } from '@fnab/shared';
import type { CameraHealth, CameraService, CameraServiceOptions } from './types';

/** Default service: every camera is explicitly SIMULATED (client renders procedural footage). No network. */
export class SimulationCameraService implements CameraService {
  readonly mode = 'simulation' as const;
  private statuses: CameraSourceStatus[];
  private listeners = new Set<(s: CameraSourceStatus[]) => void>();

  constructor(opts: CameraServiceOptions) {
    const now = (opts.now ?? Date.now)();
    this.statuses = opts.cameras.map((c) => ({
      cameraId: c.id,
      mode: 'simulated',
      snapshotUrl: null,
      streamUrl: null,
      lastUpdated: now,
      error: null,
      reason: 'CAMERA_MODE=simulation: procedural footage, no network',
    }));
  }

  async start(): Promise<void> {}
  stop(): void {
    this.listeners.clear();
  }
  getStatuses(): CameraSourceStatus[] {
    return this.statuses.map((s) => ({ ...s }));
  }
  getStatus(cameraId: string): CameraSourceStatus | null {
    const s = this.statuses.find((x) => x.cameraId === cameraId);
    return s ? { ...s } : null;
  }
  getHealth(): CameraHealth {
    return {
      mode: 'simulation',
      running: true,
      total: this.statuses.length,
      counts: { live: 0, snapshot: 0, simulated: this.statuses.length, offline: 0 },
      lastCheckAt: null,
      checks: 0,
      inflight: 0,
      hosts: [],
    };
  }
  subscribe(listener: (s: CameraSourceStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
