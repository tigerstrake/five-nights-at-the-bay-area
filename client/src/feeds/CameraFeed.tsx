// One CCTV feed: real imagery when the camera service says so (HLS / snapshot), else the labelled simulated feed.
// Always overlays FeedFxOverlay (game-driven interference / monster). Source badge reflects REAL availability only.
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import type { CameraGameStatus, CameraSourceMode, ManifestationState } from '@fnab/shared';
import { FeedFxOverlay, SimulatedFeed, getSimulatedPlacement, type FeedFxParams, type FeedSourceMode } from '../fx';
import { useGame, serverNow } from '../state/store';
import { cameraRecord, cameraSeed, graph } from '../lib/data';
import { useNow } from '../hooks/useNow';
import { SnapshotLayer } from './SnapshotLayer';
import { useHls } from './useHls';
import { ageLabel, ageShort } from './sourceUtils';

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

const DEFAULT_REFRESH_MS = 60_000;
const STREAM_RETRY_MS = 60_000;

export function CameraFeed(p: CameraFeedProps) {
  const source = useGame((s) => s.cameraStatuses[p.cameraId]);
  const clockOffset = useGame((s) => s.clockOffset);
  const rec = cameraRecord(p.cameraId);
  const node = graph.nodes.get(p.nodeId);
  const [failedStream, setFailedStream] = useState(false);
  const [failedImage, setFailedImage] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const now = useNow(1000); // keeps the OSD clock and the snapshot age ticking

  // A new server verdict (mode / stream / newer snapshot) earns a fresh local attempt.
  useEffect(() => setFailedStream(false), [source?.mode, source?.streamUrl]);
  useEffect(() => setFailedImage(false), [source?.mode, source?.snapshotUrl]);
  // A local stream failure is not permanent: retry live after a minute (the main feed may still be on screen).
  useEffect(() => {
    if (!failedStream) return;
    const id = setTimeout(() => setFailedStream(false), STREAM_RETRY_MS);
    return () => clearTimeout(id);
  }, [failedStream]);

  // What the SERVER says is trustworthy (runtime-verified, see server/src/cameras); local failures only demote:
  // live -> snapshot -> simulated. Simulated is never styled like live.
  const serverMode: CameraSourceMode = source?.mode ?? 'simulated';
  const realOffered = serverMode === 'live' || serverMode === 'snapshot';
  const snapUrl = realOffered && !failedImage ? (source?.snapshotUrl ?? null) : null;
  const wantsStream = serverMode === 'live' && !!source?.streamUrl && p.variant === 'main' && !failedStream;
  useEffect(() => {
    if (!wantsStream) setPlaying(false);
  }, [wantsStream]);
  const livePlaying = wantsStream && playing;

  let mode: CameraSourceMode;
  if (serverMode === 'offline') mode = 'offline';
  else if (livePlaying) mode = 'live';
  else if (snapUrl) mode = 'snapshot';
  else mode = 'simulated';
  const showSim = mode === 'simulated';

  const onPlaying = useCallback(() => setPlaying(true), []);
  const onStreamFail = useCallback(() => {
    setPlaying(false);
    setFailedStream(true);
  }, []);
  const videoRef = useHls(source?.streamUrl ?? null, wantsStream, { onPlaying, onFail: onStreamFail });
  const onSnapFail = useCallback(() => setFailedImage(true), []);

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

  // Source badge: REAL availability only (never the fictional game status). Distinct look per source so a
  // simulated feed can never be mistaken for live footage.
  const imageAt = frameAt ?? source?.imageAt ?? source?.lastUpdated ?? null;
  const age = mode === 'snapshot' && imageAt ? (p.variant === 'main' ? ageLabel(now - imageAt) : ageShort(now - imageAt)) : null;
  const badgeTitle =
    mode === 'live'
      ? 'Caltrans CCTV, live HLS video (typically ~30 s behind real time)'
      : mode === 'snapshot'
        ? `Caltrans CCTV still image${imageAt ? `, captured ${ageLabel(now - imageAt)}` : ''}; refreshed about every ${Math.round((source?.refreshMs ?? DEFAULT_REFRESH_MS) / 1000)} s (Caltrans updates every 5 min)`
        : mode === 'simulated'
          ? `SIMULATED footage, not a real camera${source?.reason ? `: ${source.reason}` : ''}`
          : `Real camera offline${source?.reason ? `: ${source.reason}` : ''}`;
  const badge = (
    <span
      data-testid="feed-source-badge"
      data-source-mode={mode}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 px-1 py-px font-mono font-semibold tracking-[0.14em]',
        p.variant === 'main' ? 'text-[10px]' : 'text-[8px]',
        mode === 'live' && 'bg-alert/90 text-white',
        mode === 'snapshot' && 'bg-cyan-dim/90 text-[#b5f3fa]',
        mode === 'simulated' && 'border border-dashed border-warn/70 bg-black/70 text-warn',
        mode === 'offline' && 'bg-black/80 text-dim',
      )}
      title={badgeTitle}
    >
      {mode === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
      {mode === 'live' ? 'LIVE' : mode === 'snapshot' ? 'SNAPSHOT' : mode === 'simulated' ? 'SIMULATED' : 'OFFLINE'}
      {age && <span className="font-normal tracking-normal opacity-80">· {age}</span>}
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
      data-source-mode={mode}
    >
      {showSim && (
        <SimulatedFeed cameraId={p.cameraId} seed={cameraSeed(p.cameraId)} tags={rec?.tags ?? node?.tags ?? []} variant={p.variant} />
      )}
      {snapUrl && (
        <SnapshotLayer
          url={snapUrl}
          refreshMs={source?.refreshMs ?? DEFAULT_REFRESH_MS}
          active={!livePlaying}
          alt={rec?.name ?? p.cameraId}
          onFrame={setFrameAt}
          onFail={onSnapFail}
        />
      )}
      {wantsStream && (
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          data-testid="feed-video"
          className="absolute inset-0 h-full w-full object-cover [filter:grayscale(0.3)_contrast(1.05)]"
          style={{ opacity: playing ? 1 : 0, transition: 'opacity 600ms ease-in-out' }}
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
      {p.variant === 'main' && (mode === 'live' || mode === 'snapshot') && (
        <div className="pointer-events-none absolute bottom-1 right-1.5 font-mono text-[9px] tracking-wide text-[#8d969e] [text-shadow:0_0_4px_#000]">
          Source: Caltrans CCTV
        </div>
      )}
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
