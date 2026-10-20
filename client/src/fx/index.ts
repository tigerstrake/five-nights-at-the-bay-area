// Public interface of the FX module (owner: FX agent). Foundation consumes these exports as declared.
// Stub implementations live in ./FeedFx.tsx until the FX agent replaces them.

/** Real-world availability of the source camera, from the camera adapter. Never game-driven. */
export type FeedSourceMode = 'live' | 'snapshot' | 'simulated' | 'offline';

/** Fictional in-game status of the feed (sabotage etc.). Independent of FeedSourceMode. */
export type FeedGameStatus = 'ok' | 'sabotaged' | 'repairing' | 'static' | 'blackout';

export interface PlacementRegion {
  x: number; // normalized 0..1, left edge
  y: number; // normalized 0..1, top edge
  w: number;
  h: number;
  scale: number; // figure height relative to frame height at this spot
}

/** A server-approved appearance of the monster on one camera. Only sent when visibility rules allow. */
export interface MonsterManifestation {
  kind: 'shadow' | 'silhouette' | 'figure' | 'closeup';
  strength: number; // 0..1, grows as the monster nears HQ
  regionIndex: number; // index into the camera's placement regions
  startedAt: number; // epoch ms (server clock, already offset-corrected by the client)
  durationMs: number;
  seed: number;
  // Decoy manifestations are indistinguishable from real ones on the client by design.
}

export interface FeedFxParams {
  cameraId: string;
  seed: number; // stable per camera
  sourceMode: FeedSourceMode;
  gameStatus: FeedGameStatus;
  interference: number; // 0..1 ambient interference (monster proximity / phase)
  manifestation: MonsterManifestation | null;
  placement: PlacementRegion[];
  variant: 'thumb' | 'main';
  repairProgress?: number; // 0..1 while gameStatus === 'repairing'
}

export { FeedFxOverlay, SimulatedFeed, BreachSequence } from './FeedFx';
export type { FeedFxOverlayProps, SimulatedFeedProps, BreachSequenceProps } from './FeedFx';
