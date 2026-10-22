// The command deck: five stance cards, two ability cards and the door-target picker.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Headquarters, MonsterCommand, MonsterStance, MonsterView } from '@fnab/shared';
import type { MonsterTool } from '../../state/store';
import { ABILITY_INFO, STANCE_INFO, STANCE_ORDER, type Situation } from './model';

export function CooldownRing({ left, total, size = 30 }: { left: number; total: number; size?: number }) {
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2e2220" strokeWidth={3} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#ff3a4f"
          strokeWidth={3}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 200ms linear' }}
        />
      </svg>
      <span className="mx-readout absolute text-[10px] font-semibold">{Math.ceil(left / 1000)}</span>
    </span>
  );
}

function Pips({ n, tone }: { n: number; tone: 'pace' | 'noise' }) {
  return (
    <span className="mx-pips" data-tone={tone} aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <b key={i} data-on={i < n ? '1' : '0'} />
      ))}
    </span>
  );
}

/** Flashes the claw-rake when `stamp` changes. */
function Claw({ stamp }: { stamp: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!stamp) return;
    setShown(stamp);
    const id = setTimeout(() => setShown(0), 650);
    return () => clearTimeout(id);
  }, [stamp]);
  if (!shown) return null;
  return (
    <span className="mx-claw" key={shown} aria-hidden>
      <i />
      <i />
      <i />
    </span>
  );
}

export interface CardModel {
  id: MonsterCommand;
  name: string;
  keyHint: string;
  desc: string;
  state: 'idle' | 'active' | 'targeting' | 'urgent';
  left: number;
  total: number;
  disabledReason: string | null;
  /** Brief global command gap: not clickable, but not worth a message. */
  settling?: boolean;
  foot: string;
  stats?: { pace: number; noise: number };
  stamp: number;
  onClick: () => void;
}

export function CommandCard(m: CardModel) {
  const disabled = !!m.disabledReason || !!m.settling;
  return (
    <button
      type="button"
      className="mx-card"
      data-state={m.state}
      aria-disabled={disabled}
      aria-pressed={m.state === 'active' || m.state === 'targeting'}
      title={m.disabledReason ?? `${m.name} [${m.keyHint}] — ${m.desc}`}
      data-testid={m.id === 'SABOTAGE' || m.id === 'DECOY' ? `ability-${m.id}` : `cmd-${m.id}`}
      onClick={() => !disabled && m.onClick()}
    >
      <Claw stamp={m.stamp} />
      <span className="relative flex items-start justify-between gap-2">
        <span className="mx-card-name">{m.name}</span>
        {m.left > 0 ? <CooldownRing left={m.left} total={m.total} size={28} /> : <span className="mx-key">{m.keyHint}</span>}
      </span>
      <span className="mx-card-desc relative line-clamp-4">{m.desc}</span>
      {m.stats && (
        <span className="mx-card-stats relative flex items-center gap-3 text-[9.5px] text-[var(--mx-ash-dim)]" title="How fast you move / how easily cameras see you">
          <span className="flex items-center gap-1">
            pace <Pips n={m.stats.pace} tone="pace" />
          </span>
          <span className="flex items-center gap-1">
            seen <Pips n={m.stats.noise} tone="noise" />
          </span>
        </span>
      )}
      <span className="mx-card-foot relative">
        <span className={clsx('truncate', m.disabledReason && 'text-[#d98a3a]')}>{m.disabledReason ?? m.foot}</span>
      </span>
    </button>
  );
}

const toPips = (v: number, lo: number, hi: number) => Math.max(1, Math.min(5, Math.round(1 + ((v - lo) / (hi - lo)) * 4)));

export function CommandDeck({
  view,
  sit,
  t,
  hq,
  tool,
  doorPref,
  gapLeft,
  stamps,
  onStance,
  onTool,
  onDoor,
}: {
  view: MonsterView;
  sit: Situation;
  t: number;
  hq: Headquarters;
  tool: MonsterTool;
  doorPref: string | null;
  gapLeft: number;
  stamps: Partial<Record<MonsterCommand, number>>;
  onStance: (s: MonsterStance) => void;
  onTool: (tool: MonsterTool) => void;
  onDoor: (approachId: string | null) => void;
}) {
  const self = view.self;
  const prep = view.phase === 'preparation';
  const cd = (c: MonsterCommand) => Math.max(0, self.cooldowns[c] - t);
  const cfg = sit.cfg;
  const speeds = STANCE_ORDER.map((s) => 1 / cfg.monster.stanceSpeed[s]);
  const noises = STANCE_ORDER.map((s) => cfg.detection.stanceMult[s]);
  const [sLo, sHi] = [Math.min(...speeds), Math.max(...speeds)];
  const [nLo, nHi] = [Math.min(...noises), Math.max(...noises)];

  const stanceCards: CardModel[] = STANCE_ORDER.map((s) => {
    const info = STANCE_INFO[s];
    const active = self.stance === s;
    const held = self.held;
    const left = active && !held ? 0 : cd(s);
    let disabledReason: string | null = null;
    if (left > 0) disabledReason = `Ready in ${Math.ceil(left / 1000)}s`;
    else if (held && s === 'RETREAT' && held.struggling) disabledReason = 'Already struggling';
    const isStruggle = !!held && s === 'RETREAT';
    let foot = active ? (prep ? 'Opening stance' : 'Active') : prep ? 'Open with this' : 'Switch';
    if (isStruggle) foot = 'Struggle free';
    if (held && s !== 'RETREAT') foot = active ? 'Active after release' : 'Set for release';
    return {
      id: s,
      name: isStruggle ? 'STRUGGLE' : s,
      keyHint: info.key,
      desc: isStruggle ? 'Thrash against the trap (Space or R). Containment slows it.' : info.desc,
      state: isStruggle && !held!.struggling ? 'urgent' : active && !held ? 'active' : 'idle',
      left,
      total: cfg.monster.cooldownMs[s],
      disabledReason,
      settling: gapLeft > 0,
      foot,
      stats: {
        pace: toPips(1 / cfg.monster.stanceSpeed[s], sLo, sHi),
        noise: toPips(cfg.detection.stanceMult[s], nLo, nHi),
      },
      stamp: stamps[s] ?? 0,
      onClick: () => onStance(s),
    };
  });

  const abilityCard = (id: 'SABOTAGE' | 'DECOY'): CardModel => {
    const info = ABILITY_INFO[id];
    const left = cd(id);
    const targets = id === 'SABOTAGE' ? sit.sabotageTargets.size : sit.decoyTargets.size;
    const range = id === 'SABOTAGE' ? cfg.monster.sabotageRangeHops : cfg.monster.decoyRangeHops;
    let disabledReason: string | null = null;
    if (prep || !self.spawned) disabledReason = 'Emerge first';
    else if (left > 0) disabledReason = `Ready in ${Math.ceil(left / 1000)}s`;
    else if (id === 'SABOTAGE' && self.held) disabledReason = 'Restrained';
    else if (!targets) disabledReason = id === 'SABOTAGE' ? 'Nothing to break in reach' : 'No working camera in reach';
    const toolId = id === 'SABOTAGE' ? 'sabotage' : 'decoy';
    const active = tool === toolId;
    return {
      id,
      name: id,
      keyHint: info.key,
      desc: `${info.desc} Within ${range} hop${range === 1 ? '' : 's'}.`,
      state: active ? 'targeting' : 'idle',
      left,
      total: cfg.monster.cooldownMs[id],
      disabledReason: active ? null : disabledReason,
      foot: active ? 'Pick a target on the map' : `${targets} target${targets === 1 ? '' : 's'} in reach`,
      stamp: stamps[id] ?? 0,
      onClick: () => onTool(active ? 'move' : toolId),
    };
  };

  const doorStance: MonsterStance | null =
    self.stance === 'HUNT' || self.stance === 'FLANK' || self.stance === 'ATTACK' ? self.stance : null;

  return (
    <section className="mx-slab" data-testid="commands">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--mx-scar)] px-2.5 py-1.5" data-coach-avoid>
        <span className="mx-slab-title">{prep ? 'Opening stance' : 'Commands'}</span>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-[var(--mx-ash)]">Target door</span>
          <DoorButton
            label="AI picks"
            keyHint="0"
            pressed={!doorPref}
            onClick={() => onDoor(null)}
            testid="target-ai"
            title="Let the creature choose the weakest door"
          />
          {hq.approaches.map((ap, i) => {
            const d = view.knownDoors.find((x) => x.approachId === ap.id);
            const state = d ? (d.jammed ? 'jammed' : d.closed ? 'sealed' : 'open') : 'unseen';
            return (
              <DoorButton
                key={ap.id}
                label={ap.door}
                keyHint={String(i + 1)}
                pressed={doorPref === ap.id}
                live={self.targetApproachId === ap.id}
                state={state}
                onClick={() => onDoor(ap.id)}
                testid={`target-${ap.id}`}
                title={`${ap.door} via ${ap.label}${d ? ` — ${state} when last seen` : ' — not seen yet'}`}
              />
            );
          })}
          <span className="hidden text-[10px] text-[var(--mx-ash-dim)] 2xl:inline">
            {doorStance ? `${doorStance} retargets instantly` : 'Used by HUNT, FLANK, ATTACK'}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_6px_repeat(2,minmax(0,1fr))] gap-1.5 p-1.5 max-sm:grid-cols-3 sm:max-md:grid-cols-4">
        {stanceCards.map((c) => (
          <CommandCard key={c.id} {...c} />
        ))}
        <span aria-hidden className="mx-1 w-px self-stretch bg-[var(--mx-scar)] max-md:hidden" />
        <CommandCard {...abilityCard('SABOTAGE')} />
        <CommandCard {...abilityCard('DECOY')} />
      </div>
    </section>
  );
}

const DOOR_GLYPH: Record<string, { ch: string; color: string; word: string }> = {
  open: { ch: '◻', color: '#e4d9c8', word: 'open' },
  sealed: { ch: '◼', color: '#d98a3a', word: 'sealed' },
  jammed: { ch: '◩', color: '#ff3a4f', word: 'jammed' },
  unseen: { ch: '?', color: '#5e554e', word: 'unseen' },
};

function DoorButton({
  label,
  keyHint,
  pressed,
  live,
  state,
  onClick,
  testid,
  title,
}: {
  label: string;
  keyHint: string;
  pressed: boolean;
  live?: boolean;
  state?: string;
  onClick: () => void;
  testid: string;
  title: string;
}) {
  const g = state ? DOOR_GLYPH[state] : null;
  return (
    <button type="button" className="mx-door" aria-pressed={pressed} onClick={onClick} data-testid={testid} title={title}>
      <span className="mx-key !h-4 !min-w-4 !text-[9px]">{keyHint}</span>
      <span className="max-w-[150px] truncate">{label}</span>
      {g && (
        <span className="font-mono text-[10px]" style={{ color: g.color }}>
          {g.ch} {g.word}
        </span>
      )}
      {live && <span className="h-1.5 w-1.5 rounded-full bg-[var(--mx-vein)]" title="The creature is heading here" />}
    </button>
  );
}

/** Tracks cooldown → ready transitions so the caller can play `abilityReady`. */
export function useReadyEdges(view: MonsterView, t: number, onReady: (c: MonsterCommand) => void) {
  const prev = useRef<Partial<Record<MonsterCommand, boolean>>>({});
  useEffect(() => {
    for (const c of Object.keys(view.self.cooldowns) as MonsterCommand[]) {
      const cooling = view.self.cooldowns[c] > t;
      if (prev.current[c] && !cooling && !view.ended) onReady(c);
      prev.current[c] = cooling;
    }
  });
}
