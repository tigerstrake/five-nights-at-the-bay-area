import type { CameraRecord } from '@fnab/shared';
import type { CameraMode, CameraService } from './types';
import { SimulationCameraService } from './simulation';

export * from './types';
export { SimulationCameraService };

export function parseCameraMode(v: string | undefined): CameraMode {
  return v === 'auto' || v === 'live' || v === 'snapshot' || v === 'simulation' ? v : 'simulation';
}

/**
 * Factory. Only the simulation service exists in wave 1; other modes fall back to it (logged) until the
 * Caltrans adapter lands. Never pretend a mode works when it does not.
 */
export function createCameraService(mode: CameraMode, cameras: CameraRecord[], log: (msg: string) => void = console.log): CameraService {
  if (mode !== 'simulation') log(`[cameras] CAMERA_MODE=${mode} not implemented yet — using simulation`);
  return new SimulationCameraService({ cameras });
}
