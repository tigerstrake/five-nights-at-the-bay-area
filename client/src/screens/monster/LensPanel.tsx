// "Through the lens": the public traffic camera at the creature's position, seen through a predator tint.
// These are public Caltrans cameras, so showing the feed reveals nothing the monster shouldn't know.
import type { MonsterView } from '@fnab/shared';
import { CameraFeed } from '../../feeds/CameraFeed';
import { nodeName } from '../../lib/data';

export function LensPanel({ view, nodeId, caption }: { view: MonsterView; nodeId: string | null; caption: string }) {
  const cam = nodeId ? view.cameras.find((c) => c.nodeId === nodeId) : undefined;
  const dead = cam && cam.status !== 'ok';
  return (
    <section className="mx-slab shrink-0" data-testid="monster-lens">
      <header className="mx-slab-head">
        <span className="mx-slab-title">Through the lens</span>
        <span className="mx-slab-aside">
          {caption}
          {cam && (
            <span className={cam.status === 'ok' && view.powerLevel !== 'out' ? 'text-[var(--mx-vein)]' : 'text-[var(--mx-ash)]'}>
              {' · '}
              {cam.status === 'ok' ? (view.powerLevel === 'out' ? 'their power is out' : 'it can see you') : 'it is blind'}
            </span>
          )}
        </span>
      </header>
      <div className="mx-lens aspect-video w-full">
        {cam ? (
          <>
            <div className="absolute inset-0">
              <CameraFeed
                key={cam.cameraId}
                cameraId={cam.cameraId}
                nodeId={cam.nodeId}
                variant="main"
                status={cam.status}
                interference={dead ? 0.6 : 0.25}
                manifestation={null}
                t0Epoch={view.t0Epoch}
                className="h-full w-full !outline-none"
              />
            </div>
            <div className="mx-lens-tint" />
            <div className="mx-lens-burn" />
            <div className="mx-lens-sweep" />
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <div className="mx-slab-title text-[var(--mx-ash)]">{nodeId ? 'No camera here' : 'Not yet emerged'}</div>
            <div className="text-[11px] text-[var(--mx-ash-dim)]">
              {nodeId
                ? `${nodeName(nodeId)} has no public camera. Nothing watches this spot.`
                : 'Pick an emergence point on the map to look through its camera.'}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
