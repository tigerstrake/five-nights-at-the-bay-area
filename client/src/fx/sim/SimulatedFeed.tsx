import { useEffect, useRef } from 'react';
import { CAMERAS, timeOfDayAt, type TimeOfDay } from '@fnab/shared';
import { ctx2d } from '../core/noise';
import { addFxTask } from '../core/scheduler';
import { FX_FONT_MONO } from '../core/fonts';
import { getSimLayout, getSimulatedPlacement } from './layout';
import { SimScene } from './scene';
import { loadSimImages, simImageFor } from './simImages';

export interface SimulatedFeedProps {
  cameraId: string;
  seed: number;
  tags: string[];
  variant: 'thumb' | 'main';
  className?: string;
  timeOfDay?: TimeOfDay;
  /** Animated replacement for an optional real still: always procedural, never a bundled photo. */
  proceduralOnly?: boolean;
  /**
   * Draw the persistent "SIMULATED FEED" stamp (default true). Only pass false when the host draws its own
   * equally unmistakable simulated label on top (e.g. CameraFeed thumbnails), so small tiles carry one label.
   */
  stamp?: boolean;
}

const FPS = { thumb: 10, main: 15 } as const; // CCTV-ish cadence
const RES = { thumb: 240, main: 480 } as const; // internal width: deliberately low-res

/** Procedural CCTV-style scene used when no real imagery is available. Always labelled SIMULATED. */
export function SimulatedFeed({ cameraId, seed, tags, variant, className, stamp = true, timeOfDay, proceduralOnly = false }: SimulatedFeedProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tagKey = tags.join(',');

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const scene = new SimScene(getSimLayout(cameraId, seed, tags));
    const ctx = ctx2d(canvas);
    const camera = CAMERAS.find(c => c.id === cameraId);
    const currentTimeOfDay = () => timeOfDay ?? timeOfDayAt(Date.now(), camera?.lat, camera?.lon);
    let lighting = currentTimeOfDay();
    scene.setTimeOfDay(lighting);
    let disposed = false;
    let simImg: ReturnType<typeof simImageFor> = null;
    const publishPlacement = () => {
      // tell the overlay where the creature can stand in *this* picture
      const regions = simImg?.placement
        ? scene.mapImagePlacement(simImg.placement)
        : getSimulatedPlacement(cameraId, seed, tags, scene.W / Math.max(1, scene.H));
      canvas.setAttribute(
        'data-fx-placement',
        JSON.stringify(
          regions.map((r) => ({
            x: +r.x.toFixed(4),
            y: +r.y.toFixed(4),
            w: +r.w.toFixed(4),
            h: +r.h.toFixed(4),
            scale: +r.scale.toFixed(4),
          })),
        ),
      );
    };
    loadSimImages().then(() => {
      if (disposed) return;
      simImg = proceduralOnly ? null : simImageFor(tags, scene.L.kind, scene.L.seed, lighting);
      if (simImg) scene.setImage(simImg.img);
      publishPlacement();
    });
    const measure = () => {
      const r = root.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const W = Math.min(RES[variant], Math.max(64, Math.round(r.width)));
      const H = Math.max(36, Math.round((W * r.height) / r.width));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      scene.resize(W, H);
      publishPlacement();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    const remove = addFxTask({
      el: root,
      fps: () => FPS[variant],
      render: () => {
        const next = currentTimeOfDay();
        if (next !== lighting) {
          lighting = next;
          scene.setTimeOfDay(lighting);
          simImg = proceduralOnly ? null : simImageFor(tags, scene.L.kind, scene.L.seed, lighting);
          scene.setImage(simImg?.img ?? null);
          publishPlacement();
        }
        if (scene.W > 0) scene.render(ctx, Date.now());
      },
    });
    return () => {
      disposed = true;
      remove();
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, seed, tagKey, variant, timeOfDay, proceduralOnly]);

  const main = variant === 'main';
  return (
    <div
      ref={rootRef}
      className={className}
      data-fx-simulated=""
      style={{ position: 'absolute', inset: 0, background: '#050607', overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        data-fx-source=""
        aria-label="Simulated camera feed"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', filter: 'contrast(1.06) saturate(0.82)' }}
      />
      {/* Persistent label: simulated imagery must never pass as live (spec §4, §16). */}
      {stamp && (
        <div
          role="note"
          style={{
            position: 'absolute',
            right: main ? 10 : 4,
            bottom: main ? 10 : 4,
            zIndex: 4,
            display: 'flex',
            alignItems: 'center',
            gap: main ? 6 : 4,
            padding: main ? '3px 8px 3px 6px' : '1px 4px 1px 3px',
            background: 'rgba(6,7,8,0.78)',
            border: '1px solid rgba(212,154,42,0.55)',
            color: '#e0a83a',
            fontFamily: FX_FONT_MONO,
            fontSize: main ? 11 : 8,
            fontWeight: 600,
            letterSpacing: main ? '0.18em' : '0.12em',
            lineHeight: 1.3,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <span
            style={{
              width: main ? 10 : 6,
              height: main ? 10 : 6,
              background: 'repeating-linear-gradient(135deg, #e0a83a 0 2px, transparent 2px 4px)',
              flex: 'none',
            }}
          />
          SIMULATED FEED
        </div>
      )}
    </div>
  );
}
