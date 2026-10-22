// One CCTV feed: real imagery when the camera service says so (HLS / still), else the labelled simulated feed.
// Always overlays FeedFxOverlay (game-driven interference / monster). Source badge reflects REAL availability only,
// and LIVE only while video frames are actually advancing (stall watchdog in useHls). Stills say they are stills:
// "STILL · updated 2m ago · next ≈ 3m", a countdown to the next Caltrans frame, the image's own capture time instead
// of a ticking clock, and a visible refresh wipe when a new frame arrives. Nothing here fabricates motion.
import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import type { CameraGameStatus, CameraSourceMode, ManifestationState } from '@fnab/shared';
import { FeedFxOverlay, SimulatedFeed, getSimulatedPlacement, isReducedMotion, type FeedFxParams, type FeedSourceMode } from '../fx';
import { useGame, serverNow } from '../state/store';
import { cameraRecord, cameraSeed, graph } from '../lib/data';
import { useNow } from '../hooks/useNow';
import { SnapshotLayer, type SnapshotFrameInfo } from './SnapshotLayer';
import { useHls, type HlsState } from './useHls';
import { stillFreshness, stillLabels } from './freshness';
import { liveRetryDelay } from './stallWatchdog';

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
  /** Thumbnails only: this tile is within the live-video budget (see liveBudget.ts). Main feeds always try live. */
  liveVideo?: boolean;
}

const DEFAULT_REFRESH_MS = 60_000;
/** A local still failure is retried on our own after this long (the server may not publish a new URL soon). */
const IMAGE_RETRY_MS = 60_000;
/** While stalled, keep the last video frame (labelled BUFFERING) this long before revealing the still. */
const SHOW_STILL_AFTER_MS = 6_000;
/** A NEW FRAME marker stays up this long after a genuinely new still arrives. */
const NEW_FRAME_MS = 3_000;
const IDLE: HlsState = { advancing: false, started: false, stalledMs: 0 };

type FeedState = 'live' | 'buffering' | 'connecting' | 'still' | 'simulated' | 'offline';

const hms = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour12: false });

export function CameraFeed(p: CameraFeedProps) {
  const source = useGame((s) => s.cameraStatuses[p.cameraId]);
  const clockOffset = useGame((s) => s.clockOffset);
  const rec = cameraRecord(p.cameraId);
  const node = graph.nodes.get(p.nodeId);
  const thumb = p.variant === 'thumb';
  // Local live failures: count drives the retry backoff (30 s, 60 s, ... 5 min); `downUntil` gates the retry.
  const [streamFails, setStreamFails] = useState(0);
  const [downUntil, setDownUntil] = useState<number | null>(null);
  const [failedImage, setFailedImage] = useState(false);
  const [hs, setHs] = useState<HlsState>(IDLE);
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const [newFrameAt, setNewFrameAt] = useState<number | null>(null);
  const now = useNow(1000); // keeps the OSD clock, still age and countdown ticking
  const reduced = isReducedMotion();

  // A new server verdict (mode / stream / newer still) earns a fresh local attempt.
  useEffect(() => {
    setDownUntil(null);
    setStreamFails(0);
  }, [source?.mode, source?.streamUrl]);
  useEffect(() => setFailedImage(false), [source?.mode, source?.snapshotUrl]);
  // Local failures are never permanent: retry live after the backoff, and the still after a minute.
  useEffect(() => {
    if (downUntil === null) return;
    const id = setTimeout(() => setDownUntil(null), Math.max(0, downUntil - Date.now()));
    return () => clearTimeout(id);
  }, [downUntil]);
  useEffect(() => {
    if (!failedImage) return;
    const id = setTimeout(() => setFailedImage(false), IMAGE_RETRY_MS);
    return () => clearTimeout(id);
  }, [failedImage]);

  // What the SERVER says is trustworthy (runtime-verified, see server/src/cameras); local failures only demote:
  // live -> still -> simulated. Simulated is never styled like live.
  const serverMode: CameraSourceMode = source?.mode ?? 'simulated';
  const realOffered = serverMode === 'live' || serverMode === 'snapshot';
  const snapUrl = realOffered && !failedImage ? (source?.snapshotUrl ?? null) : null;
  const liveCapable = serverMode === 'live' && !!source?.streamUrl;
  const streamDown = downUntil !== null;
  const wantsStream = liveCapable && (!thumb || !!p.liveVideo) && !streamDown;
  useEffect(() => {
    if (!wantsStream) setHs(IDLE);
  }, [wantsStream]);
  const livePlaying = wantsStream && hs.advancing;
  // A short stall keeps the (real) last video frame on screen, honestly labelled BUFFERING; a longer one reveals the still.
  const holdingVideo = wantsStream && hs.started && !hs.advancing && hs.stalledMs < SHOW_STILL_AFTER_MS;
  const videoVisible = livePlaying || holdingVideo;

  let mode: CameraSourceMode;
  if (serverMode === 'offline') mode = 'offline';
  else if (livePlaying) mode = 'live';
  else if (snapUrl || holdingVideo) mode = 'snapshot';
  else mode = 'simulated';
  const showSim = mode === 'simulated';
  const feedState: FeedState =
    mode === 'offline'
      ? 'offline'
      : mode === 'live'
        ? 'live'
        : holdingVideo
          ? 'buffering'
          : mode === 'simulated'
            ? 'simulated'
            : wantsStream
              ? 'connecting'
              : 'still';

  const onHlsState = useCallback((s: HlsState) => setHs(s), []);
  const onStreamFail = useCallback(() => {
    setHs(IDLE);
    setStreamFails((n) => {
      setDownUntil(Date.now() + liveRetryDelay(n + 1));
      return n + 1;
    });
  }, []);
  const videoRef = useHls(source?.streamUrl ?? null, wantsStream, { onState: onHlsState, onFail: onStreamFail }, { cameraId: p.cameraId, variant: p.variant });
  // A long healthy run forgives earlier failures (next problem starts the backoff from 30 s again).
  useEffect(() => {
    if (!livePlaying || !streamFails) return;
    const id = setTimeout(() => setStreamFails(0), 120_000);
    return () => clearTimeout(id);
  }, [livePlaying, streamFails]);
  const onSnapFail = useCallback(() => setFailedImage(true), []);
  const onFrame = useCallback((f: SnapshotFrameInfo) => {
    setFrameAt(f.imageAt);
    if (f.isNew) setNewFrameAt(Date.now());
  }, []);

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
  // simulated feed can never be mistaken for live footage, and a still never for video.
  const imageAt = frameAt ?? source?.imageAt ?? null;
  const fresh = stillFreshness(imageAt, now);
  const retryIn = downUntil !== null ? Math.max(0, Math.ceil((downUntil - now) / 1000)) : null;
  const liveNote =
    feedState === 'connecting'
      ? hs.started
        ? `live video stalled ${Math.round(hs.stalledMs / 1000)}s · reconnecting`
        : 'connecting live video…'
      : liveCapable && streamDown && !thumb
        ? `live video dropped · retry in ${retryIn}s`
        : null;
  const still = feedState === 'still' || feedState === 'connecting' ? stillLabels(fresh, p.variant, liveNote) : null;
  const newFrame = newFrameAt !== null && now - newFrameAt < NEW_FRAME_MS && (feedState === 'still' || feedState === 'connecting');
  const badgeTitle =
    feedState === 'live'
      ? 'Caltrans CCTV, live HLS video (typically ~15-30 s behind real time)'
      : feedState === 'buffering'
        ? `Live video stalled ${Math.round(hs.stalledMs / 1000)} s: showing its last frame while it reconnects (not live right now)`
        : still
          ? `${still.title}${liveCapable && thumb && !p.liveVideo ? ' This camera has live video: pick it for the main monitor.' : ''}`
          : feedState === 'simulated'
            ? `SIMULATED footage, not a real camera${source?.reason ? `: ${source.reason}` : ''}`
            : `Real camera offline${source?.reason ? `: ${source.reason}` : ''}`;
  const badge = (
    <span className="flex shrink-0 flex-col items-end gap-px">
      <span
        data-testid="feed-source-badge"
        data-source-mode={mode}
        data-feed-state={feedState}
        data-live-capable={liveCapable ? '' : undefined}
        className={clsx(
          'relative inline-flex shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap px-1 py-px font-mono font-semibold',
          thumb ? 'text-[8px] tracking-[0.1em]' : 'text-[10px] tracking-[0.14em]',
          feedState === 'live' && 'bg-alert/90 text-white',
          feedState === 'buffering' && 'border border-dotted border-[#f3d28d]/80 bg-black/75 text-[#f3d28d]',
          still && 'bg-cyan-dim/90 text-[#b5f3fa] transition-colors duration-700',
          still && newFrame && 'bg-[#2f8f9b] text-white',
          feedState === 'simulated' && 'border border-dashed border-warn/70 bg-black/70 text-warn',
          feedState === 'offline' && 'bg-black/80 text-dim',
        )}
        title={badgeTitle}
      >
        {feedState === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
        {feedState === 'buffering' && <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-[#f3d28d]" />}
        {still && liveCapable && <span aria-hidden className="h-1.5 w-1.5 rounded-full border border-[#ff6b75]" />}
        {feedState === 'live'
          ? 'LIVE'
          : feedState === 'buffering'
            ? thumb
              ? 'BUFFERING'
              : `BUFFERING · ${Math.round(hs.stalledMs / 1000)}s`
            : still
              ? still.badge
              : feedState === 'simulated'
                ? 'SIMULATED'
                : 'OFFLINE'}
        {/* countdown to the next Caltrans frame: the still's refresh cycle made visible */}
        {still && fresh.state !== 'unknown' && (
          <span
            aria-hidden
            data-testid="still-countdown"
            className={clsx('absolute bottom-0 left-0 h-px', fresh.state === 'fresh' ? 'bg-[#b5f3fa]/80' : 'bg-[#f3d28d]/80')}
            style={{ width: `${Math.round(fresh.progress * 100)}%` }}
          />
        )}
      </span>
      {!thumb && (still?.detail || feedState === 'buffering') && (
        <span
          data-testid="feed-freshness"
          className="whitespace-nowrap bg-black/55 px-1 font-mono text-[9.5px] leading-tight text-[#b5f3fa] [text-shadow:0_0_4px_#000]"
        >
          {newFrame && <span className="mr-1 font-semibold text-white">NEW FRAME ·</span>}
          {feedState === 'buffering' ? 'live video stalled · recovering' : still?.detail}
        </span>
      )}
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
      data-feed-state={feedState}
    >
      {showSim && (
        // Thumbs carry ONE simulated label (the dashed SIMULATED badge below); main keeps the FX stamp too.
        <SimulatedFeed
          cameraId={p.cameraId}
          seed={cameraSeed(p.cameraId)}
          tags={rec?.tags ?? node?.tags ?? []}
          variant={p.variant}
          stamp={!thumb}
        />
      )}
      {snapUrl && (
        <SnapshotLayer
          url={snapUrl}
          refreshMs={source?.refreshMs ?? DEFAULT_REFRESH_MS}
          active={!livePlaying}
          alt={rec?.name ?? p.cameraId}
          wipe={!reduced}
          cameraId={p.cameraId}
          variant={p.variant}
          fxSource={!videoVisible}
          onFrame={onFrame}
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
          data-fx-source={videoVisible ? '' : undefined}
          className="absolute inset-0 h-full w-full object-cover [filter:grayscale(0.3)_contrast(1.05)]"
          style={{ opacity: videoVisible ? 1 : 0, transition: 'opacity 600ms ease-in-out' }}
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
        {still && imageAt ? (
          // A still carries its own capture time, not a ticking clock (a running clock over a still reads as frozen video).
          <>
            <span data-testid="still-frame-time">FRAME {hms(imageAt)}</span>
            {!thumb && <span className="ml-2 text-[#8d969e]">now {hms(serverNow())}</span>}
          </>
        ) : (
          <>
            {hms(serverNow())}
            {!thumb && <span className="ml-2 text-[#8d969e]">{new Date(serverNow()).toLocaleDateString('en-US')}</span>}
          </>
        )}
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
