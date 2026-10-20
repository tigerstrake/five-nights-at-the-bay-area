// FX components (owner: FX agent). The implementations live in subfolders; this file keeps the
// module path that ./index.ts re-exports from.
export { FeedFxOverlay } from './overlay/FeedFxOverlay';
export type { FeedFxOverlayProps } from './overlay/FeedFxOverlay';
export { SimulatedFeed } from './sim/SimulatedFeed';
export type { SimulatedFeedProps } from './sim/SimulatedFeed';
export { BreachSequence, BREACH_DURATION_MS } from './cinematic/BreachSequence';
export type { BreachSequenceProps } from './cinematic/BreachSequence';
export { ContainmentSequence, CONTAINMENT_DURATION_MS } from './cinematic/ContainmentSequence';
export type { ContainmentSequenceProps } from './cinematic/ContainmentSequence';
export { SignalLostTransition } from './cinematic/SignalLostTransition';
export type { SignalLostTransitionProps } from './cinematic/SignalLostTransition';
