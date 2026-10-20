// STUB — the FX agent replaces these implementations. Keep the exported names and props.
import type { FeedFxParams } from './index';

export interface FeedFxOverlayProps {
  params: FeedFxParams;
  className?: string;
}

/** Canvas overlay that fills its (position: relative) parent: noise, scanlines, glitches, monster. */
export function FeedFxOverlay({ params, className }: FeedFxOverlayProps) {
  const dim = params.gameStatus === 'blackout' || params.gameStatus === 'sabotaged';
  return (
    <div
      className={className}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: dim ? '#000' : 'transparent' }}
    />
  );
}

export interface SimulatedFeedProps {
  cameraId: string;
  seed: number;
  tags: string[];
  variant: 'thumb' | 'main';
  className?: string;
}

/** Procedural CCTV-style scene used when no real imagery is available. Always labelled SIMULATED. */
export function SimulatedFeed({ className }: SimulatedFeedProps) {
  return (
    <div className={className} style={{ position: 'absolute', inset: 0, background: '#111', color: '#888' }}>
      <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10, letterSpacing: 1 }}>SIMULATED</span>
    </div>
  );
}

export interface BreachSequenceProps {
  hqName: string;
  onDone?: () => void;
}

/** Full-screen cinematic played on a monster breach. */
export function BreachSequence({ hqName }: BreachSequenceProps) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', color: '#c00', display: 'grid', placeItems: 'center' }}>
      {hqName} BREACHED
    </div>
  );
}
