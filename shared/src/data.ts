// Static game data shared by server and client (loaded via JSON imports so both bundle the same file).
import networkJson from './data/network.json';
import camerasJson from './data/cameras.json';
import type { CameraRecord, NetworkData } from './types';
import { Graph } from './graph';

export const NETWORK: NetworkData = networkJson as unknown as NetworkData;
export const CAMERAS: CameraRecord[] = camerasJson as unknown as CameraRecord[];
export const CAMERA_BY_ID: ReadonlyMap<string, CameraRecord> = new Map(CAMERAS.map((c) => [c.id, c]));

/** A camera's stream URL only if curation verified it as playable (docs/CAMERAS.md). */
export function usableStreamUrl(rec: CameraRecord | undefined): string | null {
  return rec?.streamUrl && rec.verified.streamPlayable === true ? rec.streamUrl : null;
}

let graph: Graph | null = null;
/** Singleton graph over the bundled network.json. */
export function getGraph(): Graph {
  graph ??= new Graph(NETWORK);
  return graph;
}

/** Structural problems in a NetworkData (empty array = valid). */
export function validateNetwork(data: NetworkData, cameras: CameraRecord[] = CAMERAS): string[] {
  const problems: string[] = [];
  const ids = new Set(data.nodes.map((n) => n.id));
  const camIds = new Set(cameras.map((c) => c.id));
  if (ids.size !== data.nodes.length) problems.push('duplicate node ids');
  for (const n of data.nodes)
    if (n.cameraId && !camIds.has(n.cameraId)) problems.push(`node ${n.id} references unknown camera ${n.cameraId}`);
  for (const e of data.edges) if (!ids.has(e.a) || !ids.has(e.b)) problems.push(`edge ${e.id} references unknown node`);
  for (const h of data.headquarters)
    for (const a of h.approaches) if (!ids.has(a.fromNode)) problems.push(`approach ${a.id} unknown node ${a.fromNode}`);
  for (const s of data.spawnNodes) if (!ids.has(s)) problems.push(`spawn ${s} unknown node`);
  const g = new Graph(data);
  if (!g.isConnected()) problems.push('graph is not connected');
  if (!data.headquarters.length) problems.push('no headquarters');
  if (!data.spawnNodes.length) problems.push('no spawn nodes');
  return problems;
}
