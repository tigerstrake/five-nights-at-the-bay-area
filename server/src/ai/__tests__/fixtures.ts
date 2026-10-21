import { DEFAULT_CONFIG, Graph, NETWORK, type MonsterStance, type NetworkData } from '@fnab/shared';
import type { BrainInput } from '../types';

export function inputFor(graph = new Graph(NETWORK), stance: MonsterStance = 'HUNT', nodeId = 'n-san-rafael'): BrainInput {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.monster.unpredictability = 0;
  return {
    graph, cfg, aggression: cfg.monster.phaseAggression.infiltration,
    knowledge: {
      t: 40_000, phase: 'infiltration', hqId: graph.data.headquarters[0].id,
      stance, targetApproachId: null, position: { nodeId, moving: null }, held: false,
      cameraStatusByNode: Object.fromEntries(graph.data.nodes.filter((n) => n.cameraId).map((n) => [n.id, 'ok'])),
      knownSensors: [], knownDoors: {}, disturbances: [], scanPulses: [], exposures: [], recentNodes: [nodeId],
      trapEncounters: [], remainingMs: 460_000, cooldowns: { SABOTAGE: 0, DECOY: 0, RETREAT: 0 }, powerLevel: 'high',
    },
  };
}

/** Two corridors with a cross-connection; unequal lengths catch BFS and heuristic mistakes. */
export function diamond(): Graph {
  const data: NetworkData = {
    version: 1,
    nodes: ['start', 'watched', 'blind', 'goal', 'isolated'].map((id, i) => ({
      id, name: id, cameraId: `cam-${id}`, lat: i * 10, lon: i * 10,
      region: 'sf', tactical: { x: i, y: 0 }, tags: [],
    })),
    edges: [
      { id: 'a', a: 'start', b: 'watched', lengthKm: 1, route: 'A', kind: 'surface' },
      { id: 'b', a: 'watched', b: 'goal', lengthKm: 1, route: 'A', kind: 'surface' },
      { id: 'c', a: 'start', b: 'blind', lengthKm: 3, route: 'B', kind: 'surface' },
      { id: 'd', a: 'blind', b: 'goal', lengthKm: 3, route: 'B', kind: 'surface' },
      { id: 'e', a: 'watched', b: 'blind', lengthKm: 8, route: 'C', kind: 'surface' },
    ],
    headquarters: [{ id: 'hq-sf', name: 'HQ', lat: 0, lon: 0, tactical: { x: 0, y: 0 },
      approaches: [{ id: 'door', label: 'Gate', door: 'Gate', fromNode: 'goal' }] }],
    spawnNodes: ['start'],
  };
  return new Graph(data);
}

export function assertPath(graph: Graph, path: string[]): boolean {
  return path.every((node, i) => graph.has(node) && (i === 0 || !!graph.edgeBetween(path[i - 1], node)));
}
