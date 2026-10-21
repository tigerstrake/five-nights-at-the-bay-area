import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { HqId, MatchPhase, RoomView, VisibleEvent, ViewBase } from '@fnab/shared';
import { matchNow } from '../state/store';
import { useNow } from '../hooks/useNow';
import { mmss, PHASE_LABEL } from '../lib/format';
import { ConnectionBadge, SettingsMenu } from '../ui/chrome';
import { Badge, Button } from '../ui/kit';
import { lobby, leaveRoom } from '../net/socket';

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
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">{prep ? 'Prep' : 'Dawn in'}</span>
      <span
        className={clsx(
          'font-mono text-2xl font-semibold tabular-nums',
          !prep && left < 60_000 ? (accent === 'monster' ? 'text-[#e36b74]' : 'text-ok') : urgent ? 'text-warn' : accent === 'monster' ? 'text-bone' : 'text-bright',
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
              i < idx ? 'bg-mute/60' : i === idx ? (view.phase === 'final' ? 'bg-alert' : view.phase === 'escalation' ? 'bg-warn' : 'bg-cyan') : 'bg-edge',
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
      className={clsx('flex items-center gap-2 border border-warn/60 bg-[#211807] px-2 py-0.5', className)}
      data-testid="spectating-banner"
      title="You see what the defenders see. You cannot act."
    >
      <span className="h-1.5 w-1.5 rounded-full bg-warn motion-safe:animate-blink" />
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-[#f3d28d]">Spectating</span>
      <span className="hidden text-[11px] text-mute xl:inline">read-only · defender view</span>
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
  return (
    <header
      className={clsx(
        'relative z-30 flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 min-[1400px]:gap-x-5',
        monster ? 'border-blood/60 bg-[#0d0708]/95' : 'border-edge bg-panel/90',
      )}
      data-testid="top-bar"
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx('h-2 w-2', monster ? 'rotate-45 bg-blood-hi shadow-[0_0_8px_rgba(179,32,47,0.8)]' : 'rounded-full bg-cyan shadow-[0_0_8px_rgba(59,198,214,0.7)]')}
        />
        <span className={clsx('font-mono text-[11px] uppercase tracking-[0.2em]', monster ? 'text-bone' : 'text-mute')}>
          {title ?? (monster ? 'Entity Command' : 'Security Control')}
        </span>
        <span className="hidden font-mono text-[11px] text-dim min-[1400px]:inline">· {room.code}</span>
      </div>
      {spectator && <SpectatorBanner />}
      <PhaseBadge view={view} />
      <MatchClock view={view} accent={accent} />
      <div className="flex min-w-0 flex-1 items-center gap-5">{children}</div>
      {right}
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
