// One CCTV feed: real imagery when the camera service says so (HLS / snapshot), else the labelled simulated feed.
// Always overlays FeedFxOverlay (game-driven interference / monster). Source badge reflects REAL availability only.
import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type Hls from 'hls.js';
import type { CameraGameStatus, CameraSourceMode, ManifestationState } from '@fnab/shared';
import { FeedFxOverlay, SimulatedFeed, getSimulatedPlacement, type FeedFxParams, type FeedSourceMode } from '../fx';
import { useGame, serverNow } from '../state/store';
import { cameraRecord, cameraSeed, graph } from '../lib/data';
import { usableStreamUrl } from '@fnab/shared';
import { useNow } from '../hooks/useNow';

export interface CameraFeedProps {
  cameraId: string;
  nodeId: string;
  variant: 'thumb' | 'main';
  status: CameraGameStatus;
  interference: number;
  manifestation: ManifestationState | null;
  repairProgress?: number | null;
  t0Epoch: number;
  className?: string;
  selected?: boolean;
  onClick?: () => void;
  alert?: boolean;
}

const SNAPSHOT_REFRESH_MS = 20_000;

function useHls(url: string | null, enabled: boolean, onError: () => void) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !url || !enabled) return;
    let hls: Hls | null = null;
    let cancelled = false;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      void video.play().catch(() => undefined);
    } else {
      void import('hls.js').then(({ default: HlsCtor }) => {
        if (cancelled) return;
        if (!HlsCtor.isSupported()) return onError();
        hls = new HlsCtor({ lowLatencyMode: true, maxBufferLength: 10 });
        hls.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (data.fatal) onError();
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        void video.play().catch(() => undefined);
      });
    }
    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, enabled, onError]);
  return ref;
}

export function CameraFeed(p: CameraFeedProps) {
  const source = useGame((s) => s.cameraStatuses[p.cameraId]);
  const clockOffset = useGame((s) => s.clockOffset);
  const rec = cameraRecord(p.cameraId);
  const node = graph.nodes.get(p.nodeId);
  const [failed, setFailed] = useState<null | 'stream' | 'image'>(null);
  const [tick, setTick] = useState(0);
  useNow(1000); // keep the OSD clock ticking

  useEffect(() => setFailed(null), [source?.mode, source?.snapshotUrl, source?.streamUrl]);

  // Decide what we can actually show.
  let mode: CameraSourceMode = source?.mode ?? 'simulated';
  // Streams are only used when curation verified them playable (docs/CAMERAS.md) AND the service reports one.
  const streamAllowed = usableStreamUrl(rec) !== null;
  const wantsStream = mode === 'live' && streamAllowed && !!source?.streamUrl && failed !== 'stream' && p.variant === 'main';
  const wantsImage = (mode === 'snapshot' || (mode === 'live' && !wantsStream)) && !!source?.snapshotUrl && failed !== 'image';
  if (mode === 'live' && !wantsStream && !wantsImage) mode = source?.snapshotUrl ? 'snapshot' : 'simulated';
  if (mode === 'live' && !wantsStream && wantsImage) mode = 'snapshot';
  if (mode === 'snapshot' && !wantsImage) mode = failed ? 'offline' : 'simulated';
  const showSim = mode === 'simulated';

  useEffect(() => {
    if (!wantsImage) return;
    const id = setInterval(() => setTick((x) => x + 1), SNAPSHOT_REFRESH_MS);
    return () => clearInterval(id);
  }, [wantsImage]);

  const onStreamError = useCallback(() => setFailed('stream'), []);
  const videoRef = useHls(source?.streamUrl ?? null, wantsStream, onStreamError);

  const fxSource: FeedSourceMode = mode;
  const params: FeedFxParams = {
    cameraId: p.cameraId,
    seed: cameraSeed(p.cameraId),
    sourceMode: fxSource,
    gameStatus: p.status,
    interference: p.interference,
    manifestation: p.manifestation
      ? {
          kind: p.manifestation.kind,
          strength: p.manifestation.strength,
          regionIndex: p.manifestation.regionIndex,
          startedAt: p.t0Epoch + p.manifestation.startedAtT - clockOffset,
          durationMs: p.manifestation.durationMs,
          seed: p.manifestation.seed,
        }
      : null,
    // Real imagery uses the curated placement; simulated scenes use the FX module's own layout regions.
    placement:
      showSim || !rec?.placement?.length
        ? getSimulatedPlacement(p.cameraId, cameraSeed(p.cameraId), rec?.tags ?? node?.tags ?? [])
        : rec.placement,
    variant: p.variant,
    repairProgress: p.repairProgress ?? undefined,
  };

  const badge = (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-1 py-px font-mono font-semibold tracking-[0.14em]',
        p.variant === 'main' ? 'text-[10px]' : 'text-[8px]',
        mode === 'live' && 'bg-alert/85 text-white',
        mode === 'snapshot' && 'bg-cyan-dim/90 text-[#b5f3fa]',
        mode === 'simulated' && 'bg-[#2a2f35]/90 text-[#c9ced4]',
        mode === 'offline' && 'bg-black/80 text-dim',
      )}
      title={source?.error ?? undefined}
    >
      {mode === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
      {mode === 'live' ? 'LIVE' : mode === 'snapshot' ? 'SNAPSHOT' : mode === 'simulated' ? 'SIMULATED' : 'OFFLINE'}
    </span>
  );

  const statusLabel =
    p.status === 'sabotaged'
      ? 'SIGNAL TAMPERED'
      : p.status === 'static'
        ? 'INTERFERENCE'
        : p.status === 'blackout'
          ? 'NO POWER'
          : p.status === 'repairing'
            ? 'REPAIRING'
            : null;

  return (
    <div
      className={clsx(
        'group relative overflow-hidden bg-black',
        p.onClick && 'cursor-pointer',
        p.selected ? 'outline outline-1 outline-cyan' : 'outline outline-1 outline-edge',
        p.alert && 'outline-alert',
        p.className,
      )}
      onClick={p.onClick}
      data-camera={p.cameraId}
    >
      {showSim && (
        <SimulatedFeed cameraId={p.cameraId} seed={cameraSeed(p.cameraId)} tags={rec?.tags ?? node?.tags ?? []} variant={p.variant} />
      )}
      {wantsImage && mode === 'snapshot' && (
        <img
          key={tick}
          crossOrigin="anonymous"
          src={withBust(source!.snapshotUrl!, tick)}
          alt={rec?.name ?? p.cameraId}
          className="absolute inset-0 h-full w-full object-cover [filter:grayscale(0.35)_contrast(1.08)_brightness(0.9)]"
          onError={() => setFailed('image')}
          draggable={false}
        />
      )}
      {wantsStream && (
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className="absolute inset-0 h-full w-full object-cover [filter:grayscale(0.3)_contrast(1.05)]"
        />
      )}
      {/* offline: FeedFxOverlay draws its own CAMERA OFFLINE card */}
      <FeedFxOverlay params={params} />

      {/* OSD */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-1 bg-gradient-to-b from-black/70 to-transparent px-1.5 pb-3 pt-1">
        <div
          className={clsx(
            'min-w-0 font-mono leading-tight text-[#e8ece9] [text-shadow:0_0_4px_#000]',
            p.variant === 'main' ? 'text-[11px]' : 'text-[9px]',
          )}
        >
          <div className="truncate font-semibold">{node?.name ?? p.nodeId}</div>
          {p.variant === 'main' && (
            <div className="truncate text-[10px] text-[#9aa3ab]">
              {rec?.name ?? 'Camera'} · {rec?.caltransIndex ? `CT#${rec.caltransIndex}` : p.cameraId}
            </div>
          )}
        </div>
        {badge}
      </div>
      <div
        className={clsx(
          'pointer-events-none absolute bottom-1 left-1.5 font-mono text-[#cfd6d1] [text-shadow:0_0_4px_#000]',
          p.variant === 'main' ? 'text-[11px]' : 'text-[8px]',
        )}
      >
        {new Date(serverNow()).toLocaleTimeString('en-US', { hour12: false })}
        {p.variant === 'main' && <span className="ml-2 text-[#8d969e]">{new Date(serverNow()).toLocaleDateString('en-US')}</span>}
      </div>
      {statusLabel && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center">
          <span
            className={clsx(
              'px-1.5 py-px font-mono font-semibold tracking-[0.18em]',
              p.variant === 'main' ? 'text-[11px]' : 'text-[8px]',
              p.status === 'repairing'
                ? 'bg-cyan-dim/90 text-[#b5f3fa]'
                : p.status === 'static'
                  ? 'bg-[#3a2a0c]/90 text-[#f3d28d]'
                  : 'bg-alert-dim/90 text-[#ffc9cc]',
            )}
          >
            {statusLabel}
            {p.status === 'repairing' && p.repairProgress != null ? ` ${Math.round(p.repairProgress * 100)}%` : ''}
          </span>
        </div>
      )}
    </div>
  );
}

function withBust(url: string, n: number): string {
  if (n === 0) return url;
  return url + (url.includes('?') ? '&' : '?') + '_r=' + n;
}
