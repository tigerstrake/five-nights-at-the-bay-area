// Static game data + balance read straight from the shared package (never hard-code balance numbers in specs).
// Imported by relative path (not '@fnab/shared') because Node cannot import the package's JSON data files
// without import attributes; config/graph are plain TS and the JSON is read from disk.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CameraRecord, HqId, NetworkData } from '../../shared/src/types';
import { Graph, spawnCandidates as spawnCandidatesFor } from '../../shared/src/graph';
import { DEFAULT_CONFIG, scaleForDefenders } from '../../shared/src/config';

const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/src/data/${name}`, import.meta.url)), 'utf8')) as T;

export const CFG = DEFAULT_CONFIG;
export { scaleForDefenders };
export const NETWORK = readJson<NetworkData>('network.json');
export const CAMERAS = readJson<CameraRecord[]>('cameras.json');
export const graph = new Graph(NETWORK);
export const hqById = (id: HqId) => NETWORK.headquarters.find((h) => h.id === id)!;
export const cameraIdOfNode = (nodeId: string): string | null => NETWORK.nodes.find((n) => n.id === nodeId)?.cameraId ?? null;
export const areAdjacent = (a: string, b: string) => graph.neighbors(a).includes(b);
export const spawnCandidates = (hq: HqId) => spawnCandidatesFor(graph, hq, CFG.spawn);

/** Reconnection grace the e2e server is started with (FNAB_TEST_RECONNECT_GRACE_MS, see playwright.config.ts). */
export const E2E_GRACE_MS = 10_000;
