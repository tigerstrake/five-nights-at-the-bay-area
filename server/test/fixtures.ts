import type { BalanceConfig, NetworkData, Rng } from '@fnab/shared';
import { DEFAULT_CONFIG, Graph, createRng } from '@fnab/shared';
import { BaselineBrain } from '../src/ai/baselineBrain';
import type { EngineCtx } from '../src/engine/engine';
import { step } from '../src/engine/engine';
import { createGame, type GameState } from '../src/engine/state';

/**
 *   s1 ── a ── b ── c(approach A1)
 *          \        |
 *           d ───── e(approach A2)      f(approach A3, off d)
 */
export const FIXTURE: NetworkData = {
  version: 1,
  nodes: ['s1', 'a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({
    id,
    cameraId: `cam-${id}`,
    name: id.toUpperCase(),
    lat: 37.5 + i * 0.01,
    lon: -122.2 + i * 0.01,
    region: 'peninsula' as const,
    tags: [],
    tactical: { x: 100 * i, y: 100 },
  })),
  edges: [
    { id: 'e1', a: 's1', b: 'a', kind: 'freeway', route: 'X', lengthKm: 5 },
    { id: 'e2', a: 'a', b: 'b', kind: 'freeway', route: 'X', lengthKm: 5 },
    { id: 'e3', a: 'b', b: 'c', kind: 'freeway', route: 'X', lengthKm: 5 },
    { id: 'e4', a: 'a', b: 'd', kind: 'freeway', route: 'Y', lengthKm: 5 },
    { id: 'e5', a: 'd', b: 'e', kind: 'freeway', route: 'Y', lengthKm: 5 },
    { id: 'e6', a: 'c', b: 'e', kind: 'surface', route: 'Z', lengthKm: 5 },
    { id: 'e7', a: 'd', b: 'f', kind: 'surface', route: 'Z', lengthKm: 5 },
  ],
  headquarters: [
    {
      id: 'hq-sf',
      name: 'Test HQ',
      lat: 37.6,
      lon: -122.1,
      tactical: { x: 500, y: 300 },
      approaches: [
        { id: 'A1', label: 'North', fromNode: 'c', door: 'Door A' },
        { id: 'A2', label: 'East', fromNode: 'e', door: 'Door B' },
        { id: 'A3', label: 'West', fromNode: 'f', door: 'Door C' },
      ],
    },
  ],
  spawnNodes: ['s1'],
};

export function testCfg(over?: (c: BalanceConfig) => void): BalanceConfig {
  const c: BalanceConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  c.failures.perMinute = 0; // deterministic tests: no random camera failures unless enabled
  c.spawn = { minHopsFromHq: 3, maxHopsFromHq: 3 }; // fixture: spawn at s1
  over?.(c);
  return c;
}

export interface Harness {
  graph: Graph;
  ctx: EngineCtx;
  s: GameState;
  rng: Rng;
  run(ms: number): void;
  runUntil(pred: (s: GameState) => boolean, maxMs?: number): boolean;
}

export function harness(
  opts: { cfg?: BalanceConfig; seed?: number; durationMs?: number; data?: NetworkData; defenders?: number } = {},
): Harness {
  const graph = new Graph(opts.data ?? FIXTURE);
  const cfg = opts.cfg ?? testCfg();
  const ctx: EngineCtx = { graph, brain: new BaselineBrain(), placementCount: () => 2 };
  const s = createGame({
    graph,
    cfg,
    hqId: graph.data.headquarters[0]!.id,
    durationMs: opts.durationMs ?? cfg.match.durationMs,
    defenderCount: opts.defenders ?? 1,
    seed: opts.seed ?? 42,
  });
  const rng = createRng(opts.seed ?? 42);
  const h: Harness = {
    graph,
    ctx,
    s,
    rng,
    run(ms) {
      for (let t = 0; t < ms && !s.result; t += cfg.tickMs) step(ctx, s, cfg.tickMs, rng);
    },
    runUntil(pred, maxMs = 600_000) {
      for (let t = 0; t < maxMs; t += cfg.tickMs) {
        if (pred(s)) return true;
        if (s.result) return pred(s);
        step(ctx, s, cfg.tickMs, rng);
      }
      return pred(s);
    },
  };
  return h;
}
