// Situation readouts, emergence picker (prep), the intent stream and the night/phase bar.
import clsx from 'clsx';
import type { Headquarters, MonsterView, VisibleEvent } from '@fnab/shared';
import { graph, nodeName } from '../../lib/data';
import { mmss, PHASE_LABEL } from '../../lib/format';
import { phaseMarks, phaseRule, RISK_WORD, type Situation } from './model';

const RISK_COLOR = { unseen: '#8f847a', watched: '#e4d9c8', exposed: '#d98a3a', hunted: '#ff3a4f' } as const;

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="min-w-0 border-l border-[var(--mx-scar)] pl-2">
      <div className="text-[10px] text-[var(--mx-ash)]">{label}</div>
      <div className="mx-readout truncate text-[15px] font-semibold leading-tight" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      {sub && <div className="truncate text-[10px] text-[var(--mx-ash-dim)]">{sub}</div>}
    </div>
  );
}

export function SituationPanel({ view, sit, t, hq }: { view: MonsterView; sit: Situation; t: number; hq: Headquarters }) {
  const factors: string[] = [];
  if (view.self.held) factors.push('Held in place — they know exactly where you are');
  else {
    if (sit.watchedHere) factors.push(`Camera here: ~${Math.round(sit.detectPerSec * 100)}% a second to spot you`);
    else if (sit.focusNode) factors.push(sit.camByNode[sit.focusNode] ? 'Camera here is blind' : 'No camera on this spot');
    if (sit.sensorsInReach) factors.push(`${sit.sensorsInReach} known sensor${sit.sensorsInReach > 1 ? 's' : ''} in reach`);
    if (sit.scanNearby) factors.push('A scan swept nearby');
    if (sit.seenRecently)
      factors.push(`Maybe seen at ${nodeName(sit.seenRecently.nodeId)} ${Math.round(sit.seenRecently.ago / 1000)}s ago`);
  }
  return (
    <section className="mx-slab shrink-0" data-testid="monster-situation">
      <header className="mx-slab-head">
        <span className="mx-slab-title">Exposure</span>
        <span className="mx-slab-aside" style={{ color: RISK_COLOR[sit.riskLevel] }}>
          {RISK_WORD[sit.riskLevel]}
        </span>
      </header>
      <div className="flex flex-col gap-2 px-2.5 py-2">
        <div className="mx-bar">
          <span style={{ width: `${sit.risk * 100}%`, background: RISK_COLOR[sit.riskLevel] }} />
        </div>
        <ul className="flex flex-col gap-0.5 text-[11px] leading-snug text-[var(--mx-ash)]">
          {factors.length ? factors.map((f) => <li key={f}>{f}</li>) : <li>Nothing you know of is watching.</li>}
        </ul>
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="To the HQ"
            value={sit.hopsToHq === null ? '—' : sit.hopsToHq === 0 ? 'At a door' : `${sit.hopsToHq} hop${sit.hopsToHq === 1 ? '' : 's'}`}
            tone={sit.hopsToHq !== null && sit.hopsToHq <= 1 ? '#ff3a4f' : undefined}
          />
          <Stat
            label="Route watched"
            value={sit.pathAhead.length ? `${sit.pathWatched}/${sit.pathAhead.length}` : '—'}
            sub={sit.pathAhead.length ? 'live cameras ahead' : 'holding'}
          />
          <Stat
            label="Blind spots"
            value={`${sit.blindNear}/${sit.camsNear}`}
            sub="dead cams ≤2 hops"
            tone={sit.blindNear ? '#e4d9c8' : undefined}
          />
        </div>
        <DoorsRow view={view} t={t} hq={hq} />
      </div>
    </section>
  );
}

function DoorsRow({ view, t, hq }: { view: MonsterView; t: number; hq: Headquarters }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {hq.approaches.map((ap) => {
        const d = view.knownDoors.find((x) => x.approachId === ap.id);
        const state = d ? (d.jammed ? 'Jammed open' : d.closed ? 'Sealed' : 'Open') : 'Unseen';
        const breaching = view.breach?.approachId === ap.id;
        return (
          <div
            key={ap.id}
            className={clsx('min-w-0 border px-1.5 py-1', breaching ? 'border-[var(--mx-vein)] bg-[#2a070d]' : 'border-[var(--mx-scar)]')}
            title={`${ap.door} via ${ap.label}`}
          >
            <div className="truncate text-[10px] text-[var(--mx-ash)]">{ap.door}</div>
            <div
              className="font-mono text-[11px] font-semibold"
              style={{ color: !d ? '#5e554e' : d.jammed ? '#ff3a4f' : d.closed ? '#d98a3a' : '#e4d9c8' }}
            >
              {breaching ? 'Breaching' : state}
            </div>
            <div className="truncate text-[9px] text-[var(--mx-ash-dim)]">{d ? `seen ${mmss(t - d.seenAt)} ago` : 'get within 1 hop'}</div>
          </div>
        );
      })}
    </div>
  );
}

export function EmergencePanel({
  view,
  hq,
  onPick,
  onHover,
}: {
  view: MonsterView;
  hq: Headquarters;
  onPick: (nodeId: string) => void;
  onHover: (nodeId: string | null) => void;
}) {
  const choice = view.self.spawnChoice;
  const opts = [...view.spawnOptions].sort((a, b) => nodeName(a).localeCompare(nodeName(b)));
  return (
    <section className="mx-slab min-h-0 flex-1" data-testid="monster-spawns">
      <header className="mx-slab-head">
        <span className="mx-slab-title">Where you emerge</span>
        <span className="mx-slab-aside">{choice ? nodeName(choice) : 'random if you don’t choose'}</span>
      </header>
      <ul className="mx-stream min-h-0 flex-1 overflow-auto py-1">
        {opts.map((n) => {
          const cam = view.cameras.find((c) => c.nodeId === n);
          const hops = graph.hopsToHq(n, view.hqId);
          const node = graph.nodes.get(n);
          return (
            <li key={n}>
              <button
                type="button"
                data-testid={`spawn-${n}`}
                onClick={() => onPick(n)}
                onMouseEnter={() => onHover(n)}
                onMouseLeave={() => onHover(null)}
                className={clsx(
                  'flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors',
                  choice === n ? 'border-[var(--mx-vein)] bg-[#24070c]' : 'border-transparent hover:bg-[#170d0c]',
                )}
              >
                <span
                  className={clsx('h-2 w-2 shrink-0 rotate-45', choice === n ? 'bg-[var(--mx-vein)]' : 'border border-[var(--mx-blood)]')}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-[var(--mx-bone)]">{nodeName(n)}</span>
                  <span className="block truncate text-[10px] text-[var(--mx-ash-dim)]">
                    {node?.region.replace('-', ' ')} · {cam ? (cam.status === 'ok' ? 'camera watching' : 'camera blind') : 'no camera'}
                  </span>
                </span>
                <span className="mx-readout text-[11px]">{hops} hops</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--mx-scar)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--mx-ash)]">
        Every point is equally far from {hq.name}. Traps they set now are invisible to you.
      </div>
    </section>
  );
}

// ── intent stream ─────────────────────────────────────────────────────

type Kind = 'intent' | 'order' | 'act' | 'door' | 'seen' | 'sense' | 'phase' | 'grid' | 'link' | 'alarm' | 'note';

function classify(e: VisibleEvent): Kind {
  if (e.kind === 'command') return e.text.startsWith('Command:') ? 'order' : 'intent';
  if (e.kind === 'ability') return 'act';
  if (e.kind === 'exposed' || e.kind === 'sighting') return 'seen';
  if (e.kind === 'sensorFound' || e.kind === 'scanFelt' || e.kind === 'disturbance') return 'sense';
  if (e.kind === 'phase') return 'phase';
  // Their power failing is an opening for the creature, not pain.
  if (e.kind === 'powerOut' || e.kind === 'powerLow' || e.kind === 'powerRestored') return 'grid';
  // Signal loss / restore on either side (and the forfeit itself): a network note, never "pain".
  if (e.kind === 'connectionLost' || e.kind === 'connectionRestored' || e.kind === 'forfeit') return 'link';
  if (['breachStart', 'breachStalled', 'breached', 'doorBattered', 'doorJammed', 'doorClosed', 'doorOpened'].includes(e.kind))
    return 'door';
  if (e.severity === 'alert' || e.kind === 'trapTriggered' || e.kind === 'containmentStart' || e.kind === 'struggle') return 'alarm';
  return 'note';
}

const KIND_TAG: Record<Kind, { tag: string; color: string }> = {
  intent: { tag: 'mind', color: '#e4d9c8' },
  order: { tag: 'you', color: '#ff3a4f' },
  act: { tag: 'act', color: '#ff3a4f' },
  door: { tag: 'door', color: '#ff3a4f' },
  seen: { tag: 'seen', color: '#d98a3a' },
  sense: { tag: 'sense', color: '#c4d2d6' },
  phase: { tag: 'night', color: '#8f847a' },
  grid: { tag: 'grid', color: '#d98a3a' },
  link: { tag: 'link', color: '#c4d2d6' },
  alarm: { tag: 'pain', color: '#ff3a4f' },
  note: { tag: '', color: '#8f847a' },
};

export function IntentStream({ view }: { view: MonsterView }) {
  const list = view.events.slice(-60).reverse();
  const intent = list.find((e) => classify(e) === 'intent');
  return (
    <section className="mx-slab min-h-[120px] flex-1 max-lg:h-[340px] max-lg:flex-none md:max-lg:col-span-2">
      <header className="mx-slab-head">
        <span className="mx-slab-title">Intent stream</span>
        <span className="mx-slab-aside">what the creature decides</span>
      </header>
      {intent && (
        <div className="border-b border-[var(--mx-scar)] bg-[#150709] px-2.5 py-2">
          <div className="text-[10px] text-[var(--mx-ash)]">Current intent · {mmss(intent.t)}</div>
          <div className="mt-0.5 text-[13px] leading-snug text-[#f3e6d6]" data-testid="monster-intent">
            {intent.text}
          </div>
        </div>
      )}
      <ol className="mx-stream min-h-0 flex-1 overflow-y-auto pb-3" data-testid="event-log">
        {list.map((e) => {
          const k = classify(e);
          const s = KIND_TAG[k];
          if (k === 'phase')
            return (
              <li key={e.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="h-px flex-1 bg-[var(--mx-scar-hi)]" />
                <span className="font-mono text-[10px] text-[var(--mx-ash)]">{e.text}</span>
                <span className="h-px flex-1 bg-[var(--mx-scar-hi)]" />
              </li>
            );
          return (
            <li
              key={e.id}
              className={clsx(
                'grid grid-cols-[34px_38px_minmax(0,1fr)] items-baseline gap-1.5 px-2.5 py-[3px] text-[11.5px] leading-snug',
                (k === 'act' || k === 'alarm' || k === 'door') && 'bg-[#1a070a]',
              )}
            >
              <span className="mx-readout text-[10px] text-[var(--mx-ash-dim)]">{mmss(e.t)}</span>
              <span className="font-mono text-[9.5px] font-semibold" style={{ color: s.color }}>
                {s.tag}
              </span>
              <span className={clsx(k === 'intent' ? 'text-[var(--mx-bone)]' : k === 'note' ? 'text-[var(--mx-ash)]' : 'text-[#eadfcf]')}>
                {k === 'order' ? e.text.replace(/^Command:\s*/, '') : e.text}
              </span>
            </li>
          );
        })}
        {!list.length && <li className="px-2.5 py-2 text-[11px] text-[var(--mx-ash-dim)]">Silence. Issue a command to begin.</li>}
      </ol>
    </section>
  );
}

// ── night bar ─────────────────────────────────────────────────────────

export function NightBar({ view, sit, t }: { view: MonsterView; sit: Situation; t: number }) {
  const m = phaseMarks(view, sit.cfg);
  const span = m.end;
  const pct = (x: number) => `${(Math.max(0, Math.min(span, x)) / span) * 100}%`;
  const segs = [
    { id: 'preparation', from: 0, to: m.prepEnd },
    { id: 'infiltration', from: m.prepEnd, to: m.inf },
    { id: 'escalation', from: m.inf, to: m.esc },
    { id: 'final', from: m.esc, to: m.end },
  ] as const;
  const aggression = sit.cfg.monster.phaseAggression[view.phase];
  const speed = 1 / sit.cfg.monster.phaseSpeed[view.phase];
  return (
    <div className="flex items-center gap-3 border-b border-[var(--mx-scar)] px-3 py-1.5 max-md:flex-wrap max-md:gap-y-1" data-coach-safe data-testid="night-bar">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="mx-slab-title text-[var(--mx-vein)]">{PHASE_LABEL[view.phase]}</span>
        {view.phase !== 'preparation' && (
          <span
            className="mx-readout text-[10px] text-[var(--mx-ash)]"
            title="This phase's multipliers on your speed and the AI's aggression"
          >
            pace ×{speed.toFixed(2)} · aggression ×{aggression.toFixed(1)}
          </span>
        )}
      </div>
      <div className="relative h-3 min-w-0 flex-1" aria-label="Night progress">
        {segs.map((s) => (
          <div
            key={s.id}
            className="absolute inset-y-0 border-r border-[var(--mx-void)]"
            style={{
              left: pct(s.from),
              width: `calc(${pct(s.to)} - ${pct(s.from)})`,
              background: s.id === view.phase ? '#3a0c13' : s.id === 'final' ? '#1f0a0c' : s.id === 'escalation' ? '#170c0b' : '#120b0a',
            }}
            title={PHASE_LABEL[s.id]}
          />
        ))}
        <div className="absolute inset-y-0 left-0 bg-[#b8142a55]" style={{ width: pct(t) }} />
        <div className="absolute -inset-y-0.5 w-0.5 bg-[var(--mx-vein)] shadow-[0_0_6px_#ff3a4f]" style={{ left: pct(t) }} />
      </div>
      <div className="max-w-[44%] shrink truncate text-[11px] text-[var(--mx-ash)] max-md:order-last max-md:max-w-full max-md:basis-full max-md:whitespace-normal" title={phaseRule(view)}>
        {phaseRule(view)}
      </div>
    </div>
  );
}
