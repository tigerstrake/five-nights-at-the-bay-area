import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  BreachSequence,
  ContainmentSequence,
  FeedFxOverlay,
  SignalLostTransition,
  SimulatedFeed,
  getFxPerfStats,
  getSimulatedPlacement,
  resetFxPerfStats,
  setFxReducedMotion,
  type FeedFxParams,
  type FeedGameStatus,
  type FxPerfStats,
  type MonsterManifestation,
  type PlacementRegion,
} from '../index';
import { FX_FONT_MONO } from '../core/fonts';
import { getStandins } from './standins';
import { setFxAssetsEnabled } from '../core/settings';

type Kind = MonsterManifestation['kind'] | 'none';

interface Source {
  id: string;
  label: string;
  kind: 'sim' | 'img';
  tags?: string[];
  url?: string;
  placement: PlacementRegion[];
}

function buildSources(): Source[] {
  const sims: Array<[string, string, string[]]> = [
    ['sim-freeway', 'I-80 E · SIM FREEWAY', ['freeway']],
    ['sim-bridge', 'SF-OAK BAY BR · SIM BRIDGE', ['bridge']],
    ['sim-tunnel', 'CALDECOTT · SIM TUNNEL', ['tunnel']],
    ['sim-downtown', 'SOMA · SIM DOWNTOWN', ['downtown']],
    ['sim-interchange', 'I-280/I-880 · SIM INTERCHANGE', ['interchange']],
  ];
  const out: Source[] = sims.map(([id, label, tags]) => ({ id, label, kind: 'sim', tags, placement: getSimulatedPlacement(id, 7, tags) }));
  for (const s of getStandins()) out.push({ id: s.id, label: s.label, kind: 'img', url: s.url, placement: s.placement });
  return out;
}

const q = new URLSearchParams(window.location.search);
if (q.get('fxassets') === '0') setFxAssetsEnabled(false);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

const panel: CSSProperties = { background: '#0e1114', border: '1px solid #222a31', padding: 12, display: 'grid', gap: 10, alignContent: 'start' };
const lbl: CSSProperties = { display: 'grid', gap: 4, fontSize: 11, letterSpacing: '0.12em', color: '#8b949e', textTransform: 'uppercase' };
const btn: CSSProperties = { background: '#171b1f', color: '#d4d9de', border: '1px solid #36404a', padding: '6px 10px', fontFamily: FX_FONT_MONO, fontSize: 12, cursor: 'pointer', letterSpacing: '0.06em' };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={lbl}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Tile({ src, params, big, showLabel }: { src: Source; params: FeedFxParams; big?: boolean; showLabel: boolean }) {
  return (
    <div style={{ position: 'relative', aspectRatio: '16 / 9', background: '#000', overflow: 'hidden', border: '1px solid #1c2227' }}>
      {src.kind === 'sim' ? (
        <SimulatedFeed cameraId={src.id} seed={7} tags={src.tags ?? []} variant={big ? 'main' : 'thumb'} />
      ) : (
        <img src={src.url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
      <FeedFxOverlay params={params} />
      {showLabel ? (
        <div style={{ position: 'absolute', left: big ? 10 : 5, top: big ? 8 : 4, fontFamily: FX_FONT_MONO, fontSize: big ? 12 : 9, color: '#d4d9de', letterSpacing: '0.1em', textShadow: '0 1px 2px #000' }}>
          {src.label}
        </div>
      ) : null}
    </div>
  );
}

export function Lab() {
  const sources = useMemo(buildSources, []);
  const [status, setStatus] = useState<FeedGameStatus>((q.get('status') as FeedGameStatus) ?? 'ok');
  const [interference, setInterference] = useState(num('i', 0.1));
  const [kind, setKind] = useState<Kind>((q.get('kind') as Kind) ?? 'none');
  const [strength, setStrength] = useState(num('s', 0.6));
  const [region, setRegion] = useState(num('region', 0));
  const [duration, setDuration] = useState(num('dur', 6000));
  const [loop, setLoop] = useState(q.get('loop') !== '0');
  const [repair, setRepair] = useState(num('rp', 0.4));
  const [reduced, setReduced] = useState(q.get('reduced') === '1');
  const [target, setTarget] = useState<'all' | 'main'>((q.get('target') as 'all' | 'main') ?? 'all');
  const [mainId, setMainId] = useState(q.get('main') ?? 'sim-freeway');
  const [startedAt, setStartedAt] = useState(() => Date.now() - num('mt', 0));
  const [play, setPlay] = useState<null | 'breach' | 'contain' | 'lost'>((q.get('play') as 'breach') ?? null);
  const [perf, setPerf] = useState<FxPerfStats | null>(null);
  const [hq, setHq] = useState(q.get('hq') ?? 'Stanford HQ');
  const layout = q.get('layout') ?? 'grid';
  const clean = q.get('clean') === '1';

  useEffect(() => setFxReducedMotion(reduced ? true : null), [reduced]);
  useEffect(() => {
    if (!loop || kind === 'none') return;
    const id = window.setInterval(() => setStartedAt(Date.now()), duration + 900);
    return () => window.clearInterval(id);
  }, [loop, kind, duration]);
  useEffect(() => {
    const id = window.setInterval(() => setPerf(getFxPerfStats()), 500);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    (window as unknown as { __fx: unknown }).__fx = { getFxPerfStats, resetFxPerfStats, retrigger: () => setStartedAt(Date.now()), setStatus, setInterference, setRepair };
  }, []);

  const paramsFor = (src: Source, i: number, variant: 'thumb' | 'main'): FeedFxParams => {
    const manifest: MonsterManifestation | null =
      kind !== 'none' && (target === 'all' || variant === 'main')
        ? { kind, strength, regionIndex: region, startedAt, durationMs: duration, seed: 1000 + i * 17 }
        : null;
    return {
      cameraId: src.id,
      seed: 7 + i,
      sourceMode: q.get('mode') === 'offline' ? 'offline' : src.kind === 'sim' ? 'simulated' : 'snapshot',
      gameStatus: status,
      interference,
      manifestation: manifest,
      placement: src.placement,
      variant,
      repairProgress: repair,
    };
  };

  const main = sources.find((s) => s.id === mainId) ?? sources[0];
  // perf layout: 1 main + 9 thumbs = 10 overlays (the main source repeats as a thumb)
  const thumbs = layout === 'perf' ? sources : sources.filter((s) => s !== main);

  const controls = (
    <div style={panel}>
      <div style={{ fontFamily: FX_FONT_MONO, fontSize: 13, color: '#3bc6d6', letterSpacing: '0.2em' }}>FX LAB</div>
      <Field label="Game status">
        <select value={status} onChange={(e) => setStatus(e.target.value as FeedGameStatus)}>
          {['ok', 'static', 'sabotaged', 'repairing', 'blackout'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </Field>
      <Field label={`Interference ${interference.toFixed(2)}`}>
        <input type="range" min={0} max={1} step={0.01} value={interference} onChange={(e) => setInterference(+e.target.value)} />
      </Field>
      <Field label="Manifestation">
        <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setStartedAt(Date.now()); }}>
          {['none', 'shadow', 'silhouette', 'figure', 'closeup'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </Field>
      <Field label={`Strength ${strength.toFixed(2)}`}>
        <input type="range" min={0} max={1} step={0.01} value={strength} onChange={(e) => setStrength(+e.target.value)} />
      </Field>
      <Field label={`Region index ${region}`}>
        <input type="range" min={0} max={6} step={1} value={region} onChange={(e) => setRegion(+e.target.value)} />
      </Field>
      <Field label={`Duration ${duration} ms`}>
        <input type="range" min={800} max={12000} step={100} value={duration} onChange={(e) => setDuration(+e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={btn} onClick={() => setStartedAt(Date.now())}>Trigger</button>
        <label style={{ ...lbl, display: 'flex', alignItems: 'center' }}>
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
        </label>
        <select value={target} onChange={(e) => setTarget(e.target.value as 'all' | 'main')}>
          <option value="all">all feeds</option>
          <option value="main">main only</option>
        </select>
      </div>
      <Field label={`Repair progress ${Math.round(repair * 100)}%`}>
        <input type="range" min={0} max={1} step={0.01} value={repair} onChange={(e) => setRepair(+e.target.value)} />
      </Field>
      <Field label="Main feed source">
        <select value={mainId} onChange={(e) => setMainId(e.target.value)}>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.id}</option>
          ))}
        </select>
      </Field>
      <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Reduced motion
      </label>
      <Field label="HQ name">
        <input value={hq} onChange={(e) => setHq(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={btn} onClick={() => setPlay('breach')}>Play breach</button>
        <button style={btn} onClick={() => setPlay('contain')}>Containment</button>
        <button style={btn} onClick={() => setPlay('lost')}>Signal lost</button>
      </div>
      {perf ? (
        <pre id="perf" style={{ margin: 0, fontFamily: FX_FONT_MONO, fontSize: 11, color: '#5d6670', whiteSpace: 'pre-wrap' }}>
          {`surfaces ${perf.surfaces} (${perf.activeSurfaces} visible)\nfx work/frame avg ${perf.avgWorkMs.toFixed(2)} ms · p95 ${perf.p95WorkMs.toFixed(2)} · max ${perf.maxWorkMs.toFixed(1)}\nframe interval ${perf.avgFrameIntervalMs.toFixed(1)} ms · renders/s ${perf.rendersPerSec.toFixed(0)}`}
        </pre>
      ) : null}
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#050607', color: '#d4d9de', fontFamily: FX_FONT_MONO, padding: clean ? 0 : 12, boxSizing: 'border-box' }}>
      {layout === 'main' ? (
        <div style={{ width: '100%', maxWidth: 1280 }}>
          <Tile src={main} params={paramsFor(main, 0, 'main')} big showLabel={!clean} />
        </div>
      ) : layout === 'thumbs' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 320px)', gap: 6 }}>
          {sources.slice(0, 9).map((s, i) => (
            <Tile key={s.id} src={s} params={paramsFor(s, i + 1, 'thumb')} showLabel={!clean} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: clean ? '1fr' : '280px 1fr', gap: 12 }}>
          {clean ? null : controls}
          <div style={{ display: 'grid', gap: 8 }}>
            <Tile src={main} params={paramsFor(main, 0, 'main')} big showLabel />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
              {thumbs.map((s, i) => (
                <Tile key={s.id} src={s} params={paramsFor(s, i + 1, 'thumb')} showLabel />
              ))}
            </div>
          </div>
        </div>
      )}
      {play === 'breach' ? <BreachSequence hqName={hq} onDone={() => q.get('hold') === '1' || setPlay(null)} /> : null}
      {play === 'contain' ? <ContainmentSequence hqName={hq} onDone={() => q.get('hold') === '1' || setPlay(null)} /> : null}
      {play === 'lost' ? <SignalLostTransition fixed label="SIGNAL LOST" onDone={() => setPlay(null)} /> : null}
    </div>
  );
}
