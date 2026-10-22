import { useState } from 'react';
import clsx from 'clsx';
import type { AiDifficulty, LobbyPlayer, Role, RoomView } from '@fnab/shared';
import { DEFAULT_CONFIG, spawnCandidates } from '@fnab/shared';
import { lobby, leaveRoom } from '../net/socket';
import { useGame } from '../state/store';
import { Button, Dot, Panel, Segmented } from '../ui/kit';
import { AudioUnlockPrompt, ConnectionBadge, SettingsMenu } from '../ui/chrome';
import { useUiAssets } from '../ui/assets';
import { NETWORK, graph, hqById } from '../lib/data';
import { BrandMark } from './shell/Brand';
import { HqCard } from './shell/HqCard';
import { RoleBriefing } from './shell/briefings';
import { HowToPlay } from './shell/HowToPlay';
import { nextDefenderSummary, scalingSummary } from './shell/difficulty';
import { AiDifficultyControl } from './shell/AiSetup';
import { SmallScreenNotice } from './shell/SmallScreen';

const ROLE_INFO: Record<Role, { label: string; desc: string }> = {
  monster: { label: 'Monster', desc: 'Command the thing in the cameras. Breach the HQ before dawn.' },
  defender: { label: 'Defender', desc: 'Watch the feeds, manage power, trap and contain it.' },
  spectator: { label: 'Spectator', desc: 'Watch the control room. No monster secrets shown.' },
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function RoleChip({ role }: { role: Role }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em]',
        role === 'monster' ? 'text-[#e36b74]' : role === 'defender' ? 'text-cyan' : 'text-mute',
      )}
    >
      <span className={clsx('h-1.5 w-1.5', role === 'monster' ? 'bg-blood-hi' : role === 'defender' ? 'bg-cyan' : 'border border-mute')} />
      {ROLE_INFO[role].label}
    </span>
  );
}

function PlayerRow({ p, you, isHost }: { p: LobbyPlayer; you: boolean; isHost: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.name);
  const commit = () => {
    setEditing(false);
    const n = draft.trim();
    if (n && n !== p.name) void lobby.setName(n);
    else setDraft(p.name);
  };
  return (
    <li className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5', you && 'bg-panel-2/70')} data-testid={`player-${p.id}`}>
      <span title={p.connected ? 'Connected' : 'Signal lost — seat held for 60 s'}>
        <Dot tone={p.connected ? 'ok' : 'warn'} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {editing ? (
            <input
              autoFocus
              value={draft}
              maxLength={DEFAULT_CONFIG.room.maxNameLength}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') {
                  setDraft(p.name);
                  setEditing(false);
                }
              }}
              className="w-full min-w-0 border border-cyan bg-ink px-1.5 py-0.5 text-[14px] text-bright outline-none"
              aria-label="Your name"
            />
          ) : (
            <span className={clsx('truncate text-[14px]', p.connected ? 'text-bright' : 'text-mute')}>{p.name}</span>
          )}
          {you && !editing && (
            <button className="shrink-0 text-[11px] text-dim underline decoration-edge-hi underline-offset-2 hover:text-text" onClick={() => setEditing(true)} title="Change your name">
              rename
            </button>
          )}
          {p.isHost && <span className="shrink-0 border border-warn/50 px-1 font-mono text-[9px] uppercase tracking-[0.12em] text-warn">host</span>}
          {p.ai && <span className="shrink-0 border border-cyan/40 px-1 font-mono text-[9px] text-cyan" data-testid="ai-tag">AI</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-3">
          <RoleChip role={p.role} />
          {p.ai && !isHost && <span className="font-mono text-[10px] capitalize text-mute">{p.ai.difficulty}</span>}
          {!p.connected && <span className="font-mono text-[10px] text-warn">signal lost</span>}
        </div>
      </div>
      {p.role !== 'spectator' ? (
        <span
          className={clsx(
            'shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
            p.ready ? 'border-ok/60 bg-ok-dim/40 text-[#a6f0c6]' : 'border-edge text-dim',
          )}
        >
          {p.ready ? 'Ready' : 'Not ready'}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[10px] text-dim">watching</span>
      )}
      {p.ai && isHost && (
        <div className="flex basis-full items-center gap-2 pl-[18px]">
          <AiDifficultyControl
            value={p.ai.difficulty}
            onChange={(d) => void lobby.setAiDifficulty(p.id, d)}
            testIdPrefix={`ai-difficulty-${p.id}`}
            className="min-w-0 flex-1 [&>button]:px-1 [&>button]:py-1 [&>button]:text-[10.5px]"
          />
          <Button
            tone="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => void lobby.removeAi(p.id)}
            data-testid={`ai-remove-${p.id}`}
            aria-label={`Remove ${p.name}`}
            title={`Remove ${p.name}`}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

export function LobbyScreen({ room }: { room: RoomView }) {
  const me = room.players.find((p) => p.id === room.youId);
  const isHost = !!me?.isHost;
  const hq = hqById(room.settings.hqId);
  const canPickHq = me?.role === 'defender' || isHost;
  const toast = useGame((s) => s.toast);
  const [help, setHelp] = useState(false);
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty>('competent');
  const assets = useUiAssets();
  const minS = DEFAULT_CONFIG.match.minDurationMs / 1000;
  const maxS = DEFAULT_CONFIG.match.maxDurationMs / 1000;
  const durations: number[] = [];
  for (let d = minS; d <= maxS; d += 60) durations.push(d);
  const inviteUrl = `${location.origin}${location.pathname}?room=${room.code}`;
  const defenders = room.players.filter((p) => p.role === 'defender').length;
  const monsters = room.players.filter((p) => p.role === 'monster').length;
  const spectators = room.players.length - defenders - monsters;
  const scaling = scalingSummary(defenders);
  const spawnCount = spawnCandidates(graph, room.settings.hqId, DEFAULT_CONFIG.spawn).length;
  const role = me?.role ?? 'spectator';

  const copy = async (what: 'link' | 'code') => {
    const ok = await copyText(what === 'link' ? inviteUrl : room.code);
    toast(ok ? (what === 'link' ? 'Invite link copied' : 'Room code copied') : `Copy failed. The code is ${room.code}`, ok ? 'good' : 'warn');
  };

  return (
    <div className="relative flex h-full flex-col" data-testid="lobby-screen">
      <img
        aria-hidden
        src={assets.keyartSmall ?? assets.keyart}
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.07] grayscale"
        draggable={false}
      />
      <header className="relative z-20 flex items-center justify-between gap-4 border-b border-edge bg-panel/85 px-5 py-2.5 backdrop-blur max-md:flex-wrap max-md:gap-2 max-md:px-3">
        <div className="flex items-center gap-4">
          <BrandMark />
          <span className="h-4 w-px bg-edge-hi" />
          <span className="text-[13px] text-mute">Lobby</span>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionBadge />
          <Button tone="ghost" size="sm" className="whitespace-nowrap" onClick={() => setHelp(true)}>
            How to play
          </Button>
          <SettingsMenu />
          <Button tone="ghost" size="sm" onClick={leaveRoom} data-testid="leave">
            Leave
          </Button>
        </div>
      </header>

      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-3 max-lg:auto-rows-max md:max-lg:grid-cols-2 lg:grid-cols-[320px_minmax(0,1fr)_360px] lg:overflow-hidden">
        <SmallScreenNotice
          className="sm:hidden"
          action={
            role !== 'spectator' ? (
              <Button size="sm" tone="warn" onClick={() => void lobby.setRole('spectator')} data-testid="small-screen-spectate">
                Watch as spectator
              </Button>
            ) : undefined
          }
        />
        {/* Left: room + operators + scaling */}
        <div className="flex min-h-0 flex-col gap-3 max-lg:order-1">
          <section className="fnab-brackets border border-edge bg-panel/90 p-4" aria-label="Room code">
            <div className="text-[12px] text-mute">Room code</div>
            <div className="mt-1 font-mono text-[52px] font-semibold leading-none tracking-[0.28em] text-bright" data-testid="room-code">
              {room.code}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" tone="cyan" onClick={() => void copy('link')} title={inviteUrl} data-testid="copy-invite">
                Copy invite link
              </Button>
              <Button size="sm" onClick={() => void copy('code')}>
                Copy code
              </Button>
            </div>
            <p className="mt-2 truncate font-mono text-[10px] text-dim" title={inviteUrl}>
              {inviteUrl.replace(/^https?:\/\//, '')}
            </p>
          </section>

          <Panel
            title={`Operators · ${room.players.length}`}
            right={
              <span className="font-mono text-[10px] text-dim">
                {monsters}M · {defenders}D{spectators ? ` · ${spectators}S` : ''}
              </span>
            }
            className="min-h-[160px] flex-1"
            bodyClass="overflow-auto"
          >
            <ul className="divide-y divide-edge" data-testid="player-list">
              {room.players.map((p) => (
                <PlayerRow key={p.id} p={p} you={p.id === room.youId} isHost={isHost} />
              ))}
            </ul>
            {isHost && (
              <div className="space-y-2 border-t border-edge bg-ink/40 p-3" data-testid="ai-controls">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] text-text">Add an AI player</span>
                  {room.players.length >= DEFAULT_CONFIG.room.maxPlayers && <span className="text-[11px] text-dim">Room is full</span>}
                </div>
                <AiDifficultyControl value={aiDifficulty} onChange={setAiDifficulty} testIdPrefix="ai-add-difficulty" />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    tone="cyan"
                    disabled={room.players.length >= DEFAULT_CONFIG.room.maxPlayers}
                    onClick={() => void lobby.addAi('defender', aiDifficulty)}
                    data-testid="ai-add-defender"
                    title="Add an AI defender to the control room"
                  >
                    + Defender
                  </Button>
                  <Button
                    size="sm"
                    tone="blood"
                    disabled={monsters > 0 || room.players.length >= DEFAULT_CONFIG.room.maxPlayers}
                    onClick={() => void lobby.addAi('monster', aiDifficulty)}
                    data-testid="ai-add-monster"
                    title={monsters > 0 ? 'There is already a monster' : 'Let an AI play the monster'}
                  >
                    + Monster
                  </Button>
                </div>
                <p className="text-[11px] leading-snug text-dim">
                  {monsters === 0
                    ? 'The night needs a monster. Add an AI one, or wait for someone to take the role.'
                    : 'AI players are always ready. A person who joins takes an AI seat.'}
                </p>
              </div>
            )}
            {room.players.length < 3 && !room.players.some(p => p.ai) && (
              <p className="px-3 py-3 text-[12px] leading-snug text-dim">
                {monsters === 0
                  ? 'Nobody is the monster yet. Someone has to be.'
                  : 'Send the invite link to add defenders. Any number can share the control room.'}
              </p>
            )}
          </Panel>

          <Panel title="Difficulty scaling" className="shrink-0" testId="scaling">
            <div className="p-3">
              <p className="text-[12px] leading-snug text-mute">
                The night scales with the team. {defenders <= 1 ? 'One defender plays at base settings.' : `Tuned for ${defenders} defenders.`}{' '}
                <span className="text-text">{nextDefenderSummary(defenders)}</span>
              </p>
              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 lg:[@media(max-height:820px)]:hidden">
                {scaling.map((l) => (
                  <div key={l.label} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <dt className="truncate text-dim" title={l.label}>
                      {l.label}
                    </dt>
                    <dd
                      className={clsx(
                        'shrink-0 font-mono tabular-nums',
                        !l.changed ? 'text-mute' : l.side === 'monster' ? 'text-[#e36b74]' : 'text-cyan',
                      )}
                    >
                      {l.changed || l.side === 'defenders' ? l.value : 'base'}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </Panel>
        </div>

        {/* Center: headquarters */}
        <section className="flex min-h-0 flex-col border border-edge bg-panel/70 max-lg:order-3 md:max-lg:col-span-2" aria-label="Headquarters">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-edge px-4 py-3">
            <div>
              <h2 className="font-display text-[18px] font-extrabold text-bright">Choose headquarters</h2>
              <p className="text-[12px] text-mute">
                {canPickHq ? 'Defenders pick where to make their stand.' : 'The defenders pick where to make their stand.'} Each has three doors.
              </p>
            </div>
            <span className="text-[12px] text-dim">
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full border border-blood-hi align-middle" />
              {spawnCount} places the monster can emerge
            </span>
          </header>
          <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-3 p-3 max-lg:auto-rows-[minmax(230px,auto)] sm:grid-cols-2">
            {NETWORK.headquarters.map((h) => (
              <HqCard
                key={h.id}
                hq={h}
                selected={h.id === room.settings.hqId}
                disabled={!canPickHq}
                onSelect={canPickHq ? (id) => void lobby.selectHq(id) : undefined}
              />
            ))}
          </div>
        </section>

        {/* Right: role, briefing, settings, ready */}
        <div className="flex min-h-0 flex-col gap-3 max-lg:order-2 lg:overflow-auto">
          <Panel title="Your role" className="shrink-0">
            <div className="flex flex-col gap-1.5 p-2.5" role="radiogroup" aria-label="Role">
              {(Object.keys(ROLE_INFO) as Role[]).map((r) => {
                const holder = r === 'monster' ? room.players.find((p) => p.role === 'monster' && p.id !== room.youId && !p.ai) : undefined;
                const sel = me?.role === r;
                return (
                  <button
                    key={r}
                    role="radio"
                    aria-checked={sel}
                    disabled={!!holder}
                    onClick={() => !sel && void lobby.setRole(r)}
                    data-testid={`role-${r}`}
                    className={clsx(
                      'border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed',
                      sel
                        ? r === 'monster'
                          ? 'border-blood-hi/80 bg-[#1f0a0d]'
                          : r === 'defender'
                            ? 'border-cyan/70 bg-cyan-dim/35'
                            : 'border-edge-hi bg-panel-2'
                        : 'border-edge bg-panel-2/60 hover:border-edge-hi',
                      holder && 'opacity-50',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={clsx(
                          'font-display text-[14px] font-extrabold',
                          sel ? (r === 'monster' ? 'text-bone' : r === 'defender' ? 'text-cyan' : 'text-bright') : 'text-text',
                        )}
                      >
                        {ROLE_INFO[r].label}
                      </span>
                      {holder && <span className="font-mono text-[10px] text-dim">taken by {holder.name}</span>}
                      {sel && <span className="font-mono text-[10px] text-mute">selected</span>}
                    </div>
                    <div className="mt-0.5 text-[12px] leading-snug text-mute">{ROLE_INFO[r].desc}</div>
                  </button>
                );
              })}
            </div>
          </Panel>

          <Panel
            title="Briefing"
            right={
              <button className="font-mono text-[10px] text-mute hover:text-text" onClick={() => setHelp(true)}>
                full rules
              </button>
            }
            className="min-h-0 shrink"
            bodyClass="overflow-auto"
            tone={role === 'monster' ? 'monster' : 'default'}
          >
            <RoleBriefing
              role={role}
              hqName={hq?.name ?? 'headquarters'}
              className="p-3"
              compact
              pointsClassName="[@media(max-height:820px)]:hidden"
            />
          </Panel>

          <Panel title="Night length" right={<span className="font-mono text-[10px] text-dim">{isHost ? 'you are host' : 'host sets'}</span>} className="shrink-0">
            <div className="p-2.5">
              <Segmented
                options={durations.map((d) => ({ value: d, label: `${d / 60}m`, title: `${d / 60} minute night` }))}
                value={room.settings.durationSec}
                onChange={(d) => void lobby.setDuration(d)}
                disabled={!isHost}
                testIdPrefix="duration"
              />
            </div>
          </Panel>

          <section className="shrink-0 border border-edge bg-panel/90 p-3" aria-label="Ready">
            <div className={clsx('mb-2.5 flex items-start gap-2 text-[12px]', room.blocker ? 'text-[#f3d28d]' : 'text-ok')} data-testid="blocker">
              <span className="mt-1">
                <Dot tone={room.blocker ? 'warn' : 'ok'} />
              </span>
              <span>{room.blocker ?? 'Everyone is ready. Starting…'}</span>
            </div>
            {role !== 'spectator' ? (
              <Button
                tone={me?.ready ? 'ok' : role === 'monster' ? 'blood' : 'alert'}
                size="xl"
                className="w-full"
                onClick={() => void lobby.setReady(!me?.ready)}
                data-testid="ready"
              >
                {me?.ready ? 'Ready — click to stand down' : 'Ready up'}
              </Button>
            ) : (
              <p className="text-[12px] text-mute">Spectators don't ready up. The match starts when the players are ready.</p>
            )}
          </section>
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
        <AudioUnlockPrompt />
      </div>
      <HowToPlay open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
