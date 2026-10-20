import clsx from 'clsx';
import type { HqId, Role, RoomView } from '@fnab/shared';
import { lobby, leaveRoom } from '../net/socket';
import { Badge, Button, Dot, Label, Panel } from '../ui/kit';
import { AudioControls, ConnectionBadge } from '../ui/chrome';
import { MapPanel } from '../map/MapPanel';
import { NETWORK, graph, hqById } from '../lib/data';
import { DEFAULT_CONFIG, spawnCandidates } from '@fnab/shared';

const ROLE_INFO: Record<Role, { label: string; desc: string; tone: 'monster' | 'cyan' | 'neutral' }> = {
  monster: { label: 'Monster', desc: 'Command the thing in the cameras. Breach the HQ before dawn.', tone: 'monster' },
  defender: { label: 'Defender', desc: 'Watch the feeds, manage power, trap and contain it.', tone: 'cyan' },
  spectator: { label: 'Spectator', desc: 'Watch the control room. No secrets revealed.', tone: 'neutral' },
};

export function LobbyScreen({ room }: { room: RoomView }) {
  const me = room.players.find((p) => p.id === room.youId);
  const isHost = !!me?.isHost;
  const hq = hqById(room.settings.hqId);
  const canPickHq = me?.role === 'defender' || isHost;
  const durations = [300, 360, 420, 480, 540, 600];
  const inviteUrl = `${location.origin}/?room=${room.code}`;

  return (
    <div className="relative flex h-full flex-col">
      <img
        aria-hidden
        src="/assets/ui/keyart-small.jpg"
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.1]"
        draggable={false}
      />
      <header className="relative flex items-center justify-between border-b border-edge bg-panel/80 px-5 py-3">
        <div className="flex items-center gap-4">
          <div className="text-sm font-semibold tracking-tight text-bright">Five Nights at the Bay Area</div>
          <Badge tone="neutral">Lobby</Badge>
        </div>
        <div className="flex items-center gap-4">
          <ConnectionBadge />
          <AudioControls />
          <Button tone="ghost" size="sm" onClick={leaveRoom}>
            Leave
          </Button>
        </div>
      </header>

      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[360px_1fr_320px]">
        {/* Left: room + players */}
        <div className="flex min-h-0 flex-col gap-3">
          <Panel title="Room code">
            <div className="flex items-center justify-between p-3">
              <div className="font-mono text-4xl font-semibold tracking-[0.35em] text-bright" data-testid="room-code">
                {room.code}
              </div>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteUrl);
                }}
                title={inviteUrl}
              >
                Copy link
              </Button>
            </div>
          </Panel>
          <Panel title={`Operators (${room.players.length})`} className="min-h-0 flex-1" bodyClass="overflow-auto">
            <ul className="divide-y divide-edge">
              {room.players.map((p) => (
                <li key={p.id} className={clsx('flex items-center justify-between px-3 py-2', p.id === room.youId && 'bg-panel-2')}>
                  <div className="flex min-w-0 items-center gap-2">
                    <Dot tone={p.connected ? 'ok' : 'warn'} />
                    <span className="truncate text-sm text-bright">{p.name}</span>
                    {p.isHost && <Badge tone="warn">Host</Badge>}
                    {p.id === room.youId && <span className="font-mono text-[10px] text-dim">(you)</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={ROLE_INFO[p.role].tone}>{ROLE_INFO[p.role].label}</Badge>
                    {p.role !== 'spectator' && <Badge tone={p.ready ? 'ok' : 'ghost'}>{p.ready ? 'Ready' : 'Not ready'}</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        {/* Center: HQ map */}
        <Panel
          title="Headquarters"
          right={
            <span className="font-mono text-[10px] text-mute">
              {canPickHq ? 'Defenders choose · click a diamond' : 'Chosen by defenders'}
            </span>
          }
          className="min-h-[320px]"
        >
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <MapPanel
                allHqs
                hqId={room.settings.hqId}
                onHqClick={canPickHq ? (id) => void lobby.selectHq(id) : undefined}
                marks={Object.fromEntries(
                  spawnCandidates(graph, room.settings.hqId, DEFAULT_CONFIG.spawn).map((n) => [n, ['spawn' as const]]),
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-edge p-2 md:grid-cols-4">
              {NETWORK.headquarters.map((h) => (
                <Button
                  key={h.id}
                  size="sm"
                  tone={h.id === room.settings.hqId ? 'ok' : 'neutral'}
                  disabled={!canPickHq}
                  onClick={() => void lobby.selectHq(h.id as HqId)}
                  data-testid={`hq-${h.id}`}
                >
                  {h.name}
                </Button>
              ))}
            </div>
          </div>
        </Panel>

        {/* Right: role, settings, ready */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <Panel title="Your role">
            <div className="flex flex-col gap-2 p-3">
              {(Object.keys(ROLE_INFO) as Role[]).map((r) => {
                const taken = r === 'monster' && room.players.some((p) => p.role === 'monster' && p.id !== room.youId);
                return (
                  <button
                    key={r}
                    disabled={taken}
                    onClick={() => void lobby.setRole(r)}
                    data-testid={`role-${r}`}
                    className={clsx(
                      'border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                      me?.role === r
                        ? r === 'monster'
                          ? 'border-monster bg-[#2a0b12]'
                          : 'border-cyan bg-cyan-dim/40'
                        : 'border-edge bg-panel-2 hover:border-edge-hi',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs uppercase tracking-[0.18em] text-bright">{ROLE_INFO[r].label}</span>
                      {taken && <span className="font-mono text-[9px] text-dim">TAKEN</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-mute">{ROLE_INFO[r].desc}</div>
                  </button>
                );
              })}
            </div>
          </Panel>
          <Panel title="Night length" right={!isHost && <span className="font-mono text-[10px] text-dim">host</span>}>
            <div className="grid grid-cols-6 gap-1 p-3">
              {durations.map((d) => (
                <Button
                  key={d}
                  size="sm"
                  tone={room.settings.durationSec === d ? 'cyan' : 'neutral'}
                  disabled={!isHost}
                  onClick={() => void lobby.setDuration(d)}
                >
                  {d / 60}m
                </Button>
              ))}
            </div>
          </Panel>
          <Panel title="Status">
            <div className="flex flex-col gap-3 p-3">
              <div>
                <Label>Target HQ</Label>
                <div className="text-sm text-bright">{hq?.name}</div>
                <div className="text-xs text-mute">{hq?.approaches.map((a) => a.label).join(' · ')}</div>
              </div>
              <div className={clsx('font-mono text-[11px]', room.blocker ? 'text-warn' : 'text-ok')}>
                {room.blocker ?? 'All set — starting'}
              </div>
              {me?.role !== 'spectator' ? (
                <Button tone={me?.ready ? 'ok' : 'alert'} size="lg" onClick={() => void lobby.setReady(!me?.ready)} data-testid="ready">
                  {me?.ready ? 'Ready ✓ (click to cancel)' : 'Ready up'}
                </Button>
              ) : (
                <div className="text-xs text-mute">Spectators don't need to ready up.</div>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
