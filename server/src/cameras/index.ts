import type { CameraRecord } from '@fnab/shared';
import type { CameraMode, CameraService } from './types';
import { SimulationCameraService } from './simulation';
import { CaltransCameraService, type CaltransConfig } from './caltrans';

export * from './types';
export { SimulationCameraService, CaltransCameraService };
export { DEFAULT_CALTRANS_CONFIG } from './caltrans';
export type { CaltransConfig } from './caltrans';

/** Unset/empty = `auto` (the product default). An unrecognised value is treated as `simulation` (safe, offline). */
export function parseCameraMode(v: string | undefined): CameraMode {
  const s = v?.trim().toLowerCase();
  if (!s) return 'auto';
  return s === 'auto' || s === 'live' || s === 'snapshot' || s === 'simulation' ? s : 'simulation';
}

/** Numeric env override helper: positive finite numbers only. */
function num(v: string | undefined): number | undefined {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Tunables from the environment (all optional; see .env.example). */
export function cameraConfigFromEnv(env: Record<string, string | undefined>): Partial<CaltransConfig> {
  const c: Partial<CaltransConfig> = {};
  const set = <K extends keyof CaltransConfig>(k: K, v: CaltransConfig[K] | undefined) => {
    if (v !== undefined) c[k] = v;
  };
  set('intervalMs', num(env.CAMERA_CHECK_INTERVAL_MS));
  set('timeoutMs', num(env.CAMERA_TIMEOUT_MS));
  set('concurrency', num(env.CAMERA_CONCURRENCY));
  set('refreshMs', num(env.CAMERA_REFRESH_MS));
  if (env.CAMERA_PROBE_ORIGIN) c.probeOrigin = env.CAMERA_PROBE_ORIGIN;
  return c;
}

/**
 * Factory. `simulation` never touches the network. `auto` / `live` / `snapshot` run the Caltrans health service,
 * which starts every camera as SIMULATED and only upgrades after a probe verifies real imagery.
 */
export function createCameraService(
  mode: CameraMode,
  cameras: CameraRecord[],
  log: (msg: string) => void = console.log,
  config: Partial<CaltransConfig> = {},
): CameraService {
  if (mode === 'simulation') return new SimulationCameraService({ cameras });
  return new CaltransCameraService({ cameras, mode, config, log });
}
