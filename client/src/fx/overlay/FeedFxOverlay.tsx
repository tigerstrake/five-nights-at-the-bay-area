import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { FeedFxParams } from '../index';
import { addFxTask } from '../core/scheduler';
import { loadMonsterSprites } from '../monster/sprites';
import { OverlayRenderer, SABOTAGE_LOST_MS } from './OverlayRenderer';
import { StatusCard } from './StatusCard';

export interface FeedFxOverlayProps {
  params: FeedFxParams;
  className?: string;
  /** Force reduced motion for this overlay (defaults to the global FX setting / OS preference). */
  reducedMotion?: boolean;
}

const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' };

/** Canvas overlay that fills its (position: relative) parent: noise, scanlines, glitches, monster. */
export function FeedFxOverlay({ params, className, reducedMotion }: FeedFxOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const addRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OverlayRenderer | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useLayoutEffect(() => {
    rendererRef.current?.setParams(params);
  });
  useEffect(() => {
    if (rendererRef.current) rendererRef.current.reducedOverride = reducedMotion ?? null;
  }, [reducedMotion]);

  useEffect(() => {
    const root = rootRef.current;
    const base = baseRef.current;
    const add = addRef.current;
    if (!root || !base || !add) return;
    loadMonsterSprites();
    const r = new OverlayRenderer(root, base, add, paramsRef.current);
    r.reducedOverride = reducedMotion ?? null;
    rendererRef.current = r;
    const measure = () => {
      const rect = root.getBoundingClientRect();
      r.resize(rect.width, rect.height);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    const remove = addFxTask({ el: root, fps: () => r.fps(), render: (now) => r.render(now) });
    return () => {
      remove();
      ro.disconnect();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.variant]);

  // SIGNAL LOST appears once the sabotage tear has played out (immediately if mounted sabotaged)
  const [lostVisible, setLostVisible] = useState(params.gameStatus === 'sabotaged');
  const firstStatus = useRef(true);
  useEffect(() => {
    if (firstStatus.current) {
      firstStatus.current = false;
      return;
    }
    if (params.gameStatus !== 'sabotaged') {
      setLostVisible(false);
      return;
    }
    setLostVisible(false);
    const id = window.setTimeout(() => setLostVisible(true), SABOTAGE_LOST_MS);
    return () => window.clearTimeout(id);
  }, [params.gameStatus]);

  return (
    <div
      ref={rootRef}
      className={className}
      data-fx-overlay=""
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', containerType: 'size' }}
    >
      <canvas ref={baseRef} data-fx-own="" style={fill} />
      <canvas ref={addRef} data-fx-own="" style={{ ...fill, mixBlendMode: 'screen' }} />
      <StatusCard params={params} lostVisible={lostVisible} />
    </div>
  );
}
