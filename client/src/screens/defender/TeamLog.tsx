// Crew roster + event log with severity colours, filters, attribution and click-to-locate.
import { useState } from 'react';
import clsx from 'clsx';
import type { GameEventKind, RoomView, VisibleEvent } from '@fnab/shared';
import { mmss } from '../../lib/format';
import { Bay, FOCUS, type RoomCtx } from './common';

const INTEL: GameEventKind[] = ['sighting', 'sensorPing', 'scan', 'scanClear', 'decoyExposed', 'trapTriggered', 'struggle', 'freed', 'containmentStart', 'containmentBroken', 'containmentCancelled', 'captured', 'breachStart', 'breachStalled', 'doorBattered'];
const SYSTEMS: GameEventKind[] = ['doorClosed', 'doorOpened', 'doorJammed', 'sabotage', 'cameraFailure', 'cameraRestored', 'repairStart', 'repairDone', 'powerLow', 'powerOut', 'powerRestored', 'connectionLost', 'connectionRestored', 'forfeit'];

type Filter = 'all' | 'alerts' | 'intel' | 'systems' | 'team';
const FILTERS: Array<{ id: Filter; label: string; test: (e: VisibleEvent) => boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'alerts', label: 'Alerts', test: (e) => e.severity === 'alert' || e.severity === 'warn' },
  { id: 'intel', label: 'Intel', test: (e) => INTEL.includes(e.kind) },
  { id: 'systems', label: 'Systems', test: (e) => SYSTEMS.includes(e.kind) },
  { id: 'team', label: 'Team', test: (e) => !!e.by },
];

export function Crew({ room }: { room: RoomView }) {
  const crew = room.players.filter((p) => p.role === 'defender');
  const watchers = room.players.filter((p) => p.role === 'spectator').length;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-edge px-2.5 py-1.5" data-testid="crew">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">Crew</span>
      {crew.map((p) => (
        <span key={p.id} className="flex items-center gap-1 text-[11.5px]" title={p.connected ? 'Online' : 'Disconnected'}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', p.connected ? 'bg-ok shadow-[0_0_5px_#3ec47a]' : 'bg-dim')} />
          <span className={clsx(p.connected ? 'text-text' : 'text-dim line-through', p.id === room.youId && 'font-semibold text-bright')}>
            {p.name}
            {p.id === room.youId ? ' (you)' : ''}
          </span>
        </span>
      ))}
      {watchers > 0 && <span className="text-[11px] text-dim">+{watchers} watching</span>}
    </div>
  );
}

export function TeamLog({ ctx, room, onLocate }: { ctx: RoomCtx; room: RoomView; onLocate: (e: VisibleEvent) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const names = new Map(room.players.map((p) => [p.id, p.id === room.youId ? 'You' : p.name]));
  const f = FILTERS.find((x) => x.id === filter)!;
  const list = ctx.view.events.filter(f.test).slice(-60).reverse();
  const multi = room.players.filter((p) => p.role === 'defender').length > 1;
  return (
    <Bay
      title="Log"
      led={list[0] && ctx.t - list[0].t < 4000 ? (list[0].severity === 'alert' ? 'alert' : 'cyan') : 'off'}
      right={
        <div className="flex gap-0.5" role="tablist" aria-label="Log filter">
          {FILTERS.filter((x) => x.id !== 'team' || multi).map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={filter === x.id}
              onClick={() => setFilter(x.id)}
              data-testid={`log-filter-${x.id}`}
              className={clsx(
                'h-5 px-1.5 font-mono text-[10px] uppercase tracking-[0.08em]',
                filter === x.id ? 'bg-edge-hi text-bright' : 'text-dim hover:text-text',
                FOCUS,
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
      }
      className="min-h-[120px] flex-1"
      bodyClass="flex flex-col"
    >
      <Crew room={room} />
      <ol className="min-h-0 flex-1 overflow-y-auto font-mono text-[11.5px] leading-snug" data-testid="event-log">
        {list.map((e) => {
          const who = e.by ? names.get(e.by) : undefined;
          const locatable = !!(e.nodeId || e.cameraId || e.approachId);
          return (
            <li
              key={e.id}
              className={clsx(
                'flex gap-2 border-b border-l-2 border-b-edge/60 px-2 py-1',
                e.severity === 'alert' ? 'border-l-alert bg-alert-dim/15' : e.severity === 'warn' ? 'border-l-warn/70' : e.severity === 'good' ? 'border-l-ok/70' : 'border-l-transparent',
                ctx.t - e.t < 3000 && 'fnab-tick-in',
              )}
            >
              <span className="shrink-0 tabular-nums text-dim">{mmss(e.t)}</span>
              <span className="min-w-0 flex-1">
                {locatable ? (
                  <button
                    type="button"
                    onClick={() => onLocate(e)}
                    className={clsx('text-left hover:underline', toneText(e.severity), FOCUS)}
                    title="Show on monitor and map"
                  >
                    {e.text}
                  </button>
                ) : (
                  <span className={toneText(e.severity)}>{e.text}</span>
                )}
                {who && <span className="ml-1.5 text-[10.5px] text-cyan/80">· {who}</span>}
              </span>
            </li>
          );
        })}
        {!list.length && (
          <li className="px-2 py-2 font-sans text-[12px] leading-snug text-dim">
            {filter === 'all'
              ? 'Quiet so far. Sightings, sensor pings, door changes and sabotage land here; click an entry to look at it.'
              : 'Nothing in this filter yet.'}
          </li>
        )}
      </ol>
    </Bay>
  );
}

const toneText = (s: VisibleEvent['severity']) =>
  s === 'alert' ? 'text-[#ff8a93]' : s === 'warn' ? 'text-[#f3d28d]' : s === 'good' ? 'text-[#9fe8bf]' : 'text-text';
