import clsx from 'clsx';
import type { RoomView, VisibleEvent, ViewBase } from '@fnab/shared';
import { matchNow } from '../state/store';
import { useNow } from '../hooks/useNow';
import { mmss, PHASE_LABEL } from '../lib/format';
import { AudioControls, ConnectionBadge } from '../ui/chrome';
import { Badge, Button } from '../ui/kit';
import { lobby, leaveRoom } from '../net/socket';

export function MatchClock({ view, className }: { view: ViewBase; className?: string }) {
  useNow(200);
  const t = matchNow(view);
  const prep = view.phase === 'preparation';
  const left = prep ? view.phaseEndsAt - t : view.matchEndsAt - t;
  return (
    <div className={clsx('flex items-baseline gap-2', className)}>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">{prep ? 'Prep' : 'Dawn in'}</span>
      <span
        className={clsx('font-mono text-2xl font-semibold tabular-nums', !prep && left < 60_000 ? 'text-ok' : 'text-bright')}
        data-testid="match-timer"
      >
        {mmss(left)}
      </span>
    </div>
  );
}

export function PhaseBadge({ view }: { view: ViewBase }) {
  const tone = view.phase === 'final' ? 'alert' : view.phase === 'escalation' ? 'warn' : view.phase === 'preparation' ? 'cyan' : 'neutral';
  return (
    <Badge tone={tone} className="text-[10px]">
      <span data-testid="phase">{PHASE_LABEL[view.phase]}</span>
    </Badge>
  );
}

export function TopBar({
  room,
  view,
  children,
  accent,
}: {
  room: RoomView;
  view: ViewBase;
  children?: React.ReactNode;
  accent: 'cyan' | 'monster';
}) {
  const me = room.players.find((p) => p.id === room.youId);
  return (
    <header
      className={clsx(
        'flex flex-wrap items-center gap-x-5 gap-y-1 border-b bg-panel/90 px-3 py-1.5',
        accent === 'monster' ? 'border-monster/40' : 'border-edge',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={clsx('h-2 w-2 rounded-full', accent === 'monster' ? 'bg-monster-hi' : 'bg-cyan')} />
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-mute">
          {accent === 'monster' ? 'Entity Command' : 'Security Control'}
        </span>
        <span className="font-mono text-[11px] text-dim">· {room.code}</span>
      </div>
      <PhaseBadge view={view} />
      <MatchClock view={view} />
      <div className="flex min-w-0 flex-1 items-center gap-5">{children}</div>
      <ConnectionBadge />
      <AudioControls />
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

export function EventLog({
  events,
  view,
  className,
  filter,
}: {
  events: VisibleEvent[];
  view: ViewBase;
  className?: string;
  filter?: (e: VisibleEvent) => boolean;
}) {
  const list = (filter ? events.filter(filter) : events).slice(-40).reverse();
  return (
    <ol className={clsx('flex flex-col font-mono text-[11px] leading-snug', className)} data-testid="event-log">
      {list.map((e) => (
        <li key={e.id} className="flex gap-2 border-b border-edge/60 px-2 py-1">
          <span className="shrink-0 tabular-nums text-dim">{mmss(Math.max(0, e.t - (view.phase === 'preparation' ? 0 : 0)))}</span>
          <span
            className={clsx(
              e.severity === 'alert' && 'text-[#ff8a93]',
              e.severity === 'warn' && 'text-[#f3d28d]',
              e.severity === 'good' && 'text-[#9fe8bf]',
              e.severity === 'info' && 'text-text',
            )}
          >
            {e.text}
          </span>
        </li>
      ))}
      {!list.length && <li className="px-2 py-2 text-dim">No activity yet.</li>}
    </ol>
  );
}
