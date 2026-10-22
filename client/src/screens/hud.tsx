import clsx from 'clsx';
import { useCallback, useState, type ReactNode } from 'react';
import type { HqId, MatchPhase, RoomView, TeamConnectionView, VisibleEvent, ViewBase } from '@fnab/shared';
import { matchNow, serverNow } from '../state/store';
import { useNow } from '../hooks/useNow';
import { mmss, PHASE_LABEL } from '../lib/format';
import { ConnectionBadge, SettingsMenu } from '../ui/chrome';
import { Badge, Button } from '../ui/kit';
import { lobby, leaveRoom } from '../net/socket';
import { HowToPlay } from './shell/HowToPlay';

export type HudAccent = 'cyan' | 'monster';

const HQ_SHORT_NAMES: Record<HqId, string> = {
  'hq-stanford': 'Stanford Annex',
  'hq-sf': 'SF Operations',
  'hq-oakland': 'Oakland Port',
  'hq-sanjose': 'San Jose Vault',
};
/** Compact HQ name for dense bars (full names run ~40 characters). */
export function hqShortName(id: HqId): string {
  return HQ_SHORT_NAMES[id] ?? id;
}

export function MatchClock({ view, className, accent }: { view: ViewBase; className?: string; accent?: HudAccent }) {
  useNow(200);
  const t = matchNow(view);
  const prep = view.phase === 'preparation';
  const left = prep ? view.phaseEndsAt - t : view.matchEndsAt - t;
  const urgent = prep && left < 5_000;
  return (
    <div className={clsx('flex items-baseline gap-2', className)}>
      <span
        className={clsx('font-mono text-[10px] uppercase tracking-[0.2em]', view.pausedForReconnect ? 'text-warn' : 'text-dim')}
        data-testid="clock-label"
      >
        {view.pausedForReconnect ? 'Paused' : prep ? 'Prep' : 'Dawn in'}
      </span>
      <span
        className={clsx(
          'font-mono text-2xl font-semibold tabular-nums',
          !prep && left < 60_000
            ? accent === 'monster'
              ? 'text-[#e36b74]'
              : 'text-ok'
            : urgent
              ? 'text-warn'
              : accent === 'monster'
                ? 'text-bone'
                : 'text-bright',
        )}
        data-testid="match-timer"
      >
        {mmss(left)}
      </span>
    </div>
  );
}

const PHASE_ORDER: MatchPhase[] = ['preparation', 'infiltration', 'escalation', 'final'];

export function PhaseBadge({ view }: { view: ViewBase }) {
  const tone = view.phase === 'final' ? 'alert' : view.phase === 'escalation' ? 'warn' : view.phase === 'preparation' ? 'cyan' : 'neutral';
  const idx = PHASE_ORDER.indexOf(view.phase);
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex gap-0.5" aria-hidden>
        {PHASE_ORDER.map((p, i) => (
          <span
            key={p}
            className={clsx(
              'h-2.5 w-1',
              i < idx
                ? 'bg-mute/60'
                : i === idx
                  ? view.phase === 'final'
                    ? 'bg-alert'
                    : view.phase === 'escalation'
                      ? 'bg-warn'
                      : 'bg-cyan'
                  : 'bg-edge',
            )}
          />
        ))}
      </span>
      <Badge tone={tone} className="text-[10px]">
        <span data-testid="phase">{PHASE_LABEL[view.phase]}</span>
      </Badge>
    </div>
  );
}

/** Prominent read-only banner for spectators (rendered by TopBar automatically). */
export function SpectatorBanner({ className }: { className?: string }) {
  return (
    <div
      className={clsx('flex shrink-0 items-center gap-2 border border-warn/60 bg-[#211807] px-2 py-0.5', className)}
      data-testid="spectating-banner"
      title="You see what the defenders see. You cannot act."
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warn motion-safe:animate-blink" />
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-[#f3d28d]">Spectating</span>
      <span className="hidden text-[11px] text-mute min-[1720px]:inline">read-only · defender view</span>
    </div>
  );
}

/**
 * Whole-team signal loss during a match (server reconnection grace; the simulation is paused meanwhile).
 * Defenders / spectators see the entity's signal; the monster sees the control room's. Counts down to the forfeit.
 */
export function TeamSignalBanner({ view, perspective }: { view: ViewBase; perspective: 'defenders' | 'monster' }) {
  useNow(250);
  if (view.ended) return null;
  const lostTeam = (c: TeamConnectionView | undefined) => !!c && !c.connected;
  const monsterLost = lostTeam(view.monsterConnection);
  const defendersLost = lostTeam(view.defenderConnection);
  // Our own team's drop is covered by the socket ReconnectBanner; show the OTHER side first, then a pause notice.
  const other = perspective === 'defenders' ? (monsterLost ? 'monster' : null) : defendersLost ? 'defenders' : null;
  const own = perspective === 'defenders' ? (defendersLost ? 'defenders' : null) : monsterLost ? 'monster' : null;
  const team = other ?? own ?? (view.pausedForReconnect ? (monsterLost ? 'monster' : defendersLost ? 'defenders' : null) : null);
  if (!team && !view.pausedForReconnect) return null;
  const conn = team === 'monster' ? view.monsterConnection : team === 'defenders' ? view.defenderConnection : undefined;
  const deadline = conn?.reconnectDeadlineEpoch ?? null;
  const left = deadline !== null ? Math.max(0, Math.ceil((deadline - serverNow()) / 1000)) : null;
  const monsterSide = perspective === 'monster';
  const title =
    team === 'monster'
      ? monsterSide
        ? 'Your signal dropped — the night is paused'
        : 'The entity’s signal is lost — reconnecting…'
      : team === 'defenders'
        ? monsterSide
          ? 'The control room has gone dark — waiting for them…'
          : 'The control room lost its link — reconnecting…'
        : 'Match paused — waiting for a player to reconnect…';
  const sub =
    team === 'monster'
      ? 'The night is paused. If it does not return in time, the defenders win by forfeit.'
      : team === 'defenders'
        ? 'The night is paused. If no defender returns in time, the monster wins by forfeit.'
        : 'The night is paused.';
  // An in-flow strip directly under the top bar: it pushes the console down instead of floating over the alert
  // ticker, the phase strip or the map controls. (The night is paused while it shows, so the shift costs nothing.)
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        'relative z-20 flex shrink-0 items-center justify-center gap-x-3 gap-y-0.5 overflow-hidden border-b px-3 py-1.5 max-md:flex-wrap',
        monsterSide ? 'border-blood-hi/70 bg-[#1a070b]' : 'border-warn/60 bg-[#1f1608]',
      )}
      data-testid={team === 'defenders' ? 'defenders-signal-lost' : 'monster-signal-lost'}
      data-paused={view.pausedForReconnect ? '1' : '0'}
      data-coach-safe
    >
      <div aria-hidden className="fnab-noise pointer-events-none absolute inset-0 opacity-[0.1]" />
      <span
        className={clsx('relative h-2 w-2 shrink-0 rounded-full motion-safe:animate-blink', monsterSide ? 'bg-blood-hi' : 'bg-warn')}
      />
      <span
        className={clsx(
          'relative min-w-0 font-mono text-[11px] uppercase tracking-[0.18em]',
          monsterSide ? 'text-[#ffb3bf]' : 'text-[#f3d28d]',
        )}
      >
        {title}
        {left !== null && (
          <span className="ml-2 tabular-nums text-bright" data-testid="signal-lost-countdown">
            {left}s
          </span>
        )}
      </span>
      <span className="relative min-w-0 text-[11.5px] text-mute">{sub}</span>
    </div>
  );
}

export function TopBar({
  room,
  view,
  children,
  accent,
  title,
  right,
}: {
  room: RoomView;
  view: ViewBase;
  children?: ReactNode;
  accent: HudAccent;
  /** Override the console name ("Security Control" / "Entity Command"). */
  title?: ReactNode;
  /** Extra controls placed before the connection/settings cluster. */
  right?: ReactNode;
}) {
  const me = room.players.find((p) => p.id === room.youId);
  const spectator = me?.role === 'spectator';
  const monster = accent === 'monster';
  const [manual, setManual] = useState(false);
  const closeManual = useCallback(() => setManual(false), []);
  return (
    <>
      <header
        className={clsx(
          'relative z-30 flex flex-nowrap items-center gap-x-3 border-b px-3 py-1.5 max-lg:flex-wrap max-lg:gap-y-1 max-md:px-2 min-[1400px]:gap-x-5 [&>*]:shrink-0',
          monster ? 'border-blood/60 bg-[#0d0708]/95' : 'border-edge bg-panel/90',
        )}
        data-testid="top-bar"
        data-coach-safe
      >
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'h-2 w-2',
              monster
                ? 'rotate-45 bg-blood-hi shadow-[0_0_8px_rgba(179,32,47,0.8)]'
                : 'rounded-full bg-cyan shadow-[0_0_8px_rgba(59,198,214,0.7)]',
            )}
          />
          <span className={clsx('font-mono text-[11px] uppercase tracking-[0.2em] max-lg:hidden', monster ? 'text-bone' : 'text-mute')}>
            {title ?? (monster ? 'Entity Command' : 'Security Control')}
          </span>
          <span className="font-mono text-[11px] text-dim" title="Room code" data-testid="hud-room-code">
            <span className="max-lg:hidden">· </span>
            {room.code}
          </span>
        </div>
        {spectator && <SpectatorBanner />}
        <PhaseBadge view={view} />
        <MatchClock view={view} accent={accent} />
        {/* Screen-specific readouts compress first (they clip rather than push the controls off-screen). */}
        <div className="flex min-w-0 flex-1 shrink! items-center gap-3 overflow-hidden max-lg:order-last max-lg:basis-full min-[1400px]:gap-5">
          {children}
        </div>
        {right}
        <Button
          size="sm"
          tone="ghost"
          onClick={() => setManual(true)}
          aria-label="Field manual"
          aria-haspopup="dialog"
          aria-expanded={manual}
          title="Field manual — role strategy"
          data-testid="field-manual"
        >
          <span aria-hidden>?</span> <span className="hidden min-[1400px]:inline">Field manual</span>
        </Button>
        <ConnectionBadge textClassName="hidden min-[1400px]:inline" />
        <SettingsMenu labelClassName="hidden min-[1400px]:inline" />
        {me?.isHost && (
          <Button size="sm" tone="ghost" onClick={() => confirm('Abort the match and return everyone to the lobby?') && void lobby.restart()}>
            Abort
          </Button>
        )}
        <Button size="sm" tone="ghost" onClick={() => confirm('Leave this room?') && leaveRoom()}>
          Leave
        </Button>
      </header>
      <HowToPlay open={manual} onClose={closeManual} initialSection="strategy" initialRole={monster ? 'monster' : 'defender'} />
    </>
  );
}

const SEV_CLASS: Record<VisibleEvent['severity'], string> = {
  alert: 'text-[#ff8a93]',
  warn: 'text-[#f3d28d]',
  good: 'text-[#9fe8bf]',
  info: 'text-text',
};

export function EventLog({
  events,
  view,
  className,
  filter,
  limit = 40,
}: {
  events: VisibleEvent[];
  view: ViewBase;
  className?: string;
  filter?: (e: VisibleEvent) => boolean;
  /** How many of the newest entries to show (default 40). */
  limit?: number;
}) {
  const list = (filter ? events.filter(filter) : events).slice(-limit).reverse();
  const newest = list[0]?.id;
  void view;
  return (
    <ol className={clsx('flex flex-col font-mono text-[11px] leading-snug', className)} data-testid="event-log">
      {list.map((e) => (
        <li
          key={e.id}
          className={clsx('flex gap-2 border-b border-edge/60 px-2 py-1', e.id === newest && 'bg-white/[0.03] motion-safe:animate-rise')}
        >
          <span className="shrink-0 tabular-nums text-dim">{mmss(Math.max(0, e.t))}</span>
          <span
            aria-hidden
            className={clsx(
              'mt-[5px] h-1.5 w-1.5 shrink-0',
              e.severity === 'alert' ? 'bg-alert' : e.severity === 'warn' ? 'bg-warn' : e.severity === 'good' ? 'bg-ok' : 'bg-edge-hi',
            )}
          />
          <span className={SEV_CLASS[e.severity]}>{e.text}</span>
        </li>
      ))}
      {!list.length && <li className="px-2 py-2 text-dim">No activity yet.</li>}
    </ol>
  );
}
