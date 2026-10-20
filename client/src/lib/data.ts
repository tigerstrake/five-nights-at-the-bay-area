import { CAMERAS, CAMERA_BY_ID, NETWORK, getGraph, hashString } from '@fnab/shared';
import type { CameraRecord, Headquarters, HqId } from '@fnab/shared';

export const graph = getGraph();
export { CAMERAS, CAMERA_BY_ID, NETWORK };

export function cameraRecord(id: string): CameraRecord | undefined {
  return CAMERA_BY_ID.get(id);
}
export function nodeName(id: string | null | undefined): string {
  if (!id) return '—';
  return graph.nodes.get(id)?.name ?? id;
}
export function hqById(id: HqId): Headquarters | undefined {
  return graph.hqs.get(id);
}
export function cameraSeed(id: string): number {
  return hashString(id);
}
export function approachLabel(hqId: HqId, approachId: string): string {
  const ap = hqById(hqId)?.approaches.find((a) => a.id === approachId);
  return ap ? `${ap.door} · ${ap.label}` : approachId;
}
