import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { MatchResult, RoomView } from '@fnab/shared';
import { BreachSequence, ContainmentSequence, BREACH_DURATION_MS, CONTAINMENT_DURATION_MS } from '../fx';
import { lobby, leaveRoom } from '../net/socket';
import { Badge, Button, Panel } from '../ui/kit';
import { MapPanel } from '../map/MapPanel';
import { approachLabel, hqById } from '../lib/data';
import { mmss } from '../lib/format';
import { AudioControls } from '../ui/chrome';

const REASON: Record<MatchResult['reason'], string> = {
  breach: 'Headquarters breached',
  timer: 'Survived until dawn',
  capture: 'Monster captured',
  forfeit: 'Opponent left the match',
};

export function ResultsScreen({ room, result }: { room: RoomView; result: MatchResult }) {
  const hasCinematic = result.reason === 'breach' || result.reason === 'capture';
  const [cinematic, setCinematic] = useState(hasCinematic);
  const me = room.players.find((p) => p.id === room.youId);
  const myTeam = me?.role === 'monster' ? 'monster' : me?.role === 'defender' ? 'defenders' : null;
  const won = myTeam === result.winner;
  const hq = hqById(result.hqId);
  const s = result.stats;

  useEffect(() => {
    if (!cinematic) return;
    // onDone moves on; this is only a safety net.
    const id = setTimeout(() => setCinematic(false), Math.max(BREACH_DURATION_MS, CONTAINMENT_DURATION_MS) + 2500);
    return () => clearTimeout(id);
  }, [cinematic]);

  if (cinematic)
    return (
      <div className="fixed inset-0 z-30" data-testid="breach-sequence">
        {result.reason === 'breach' ? (
          <BreachSequence hqName={hq?.name ?? 'HQ'} onDone={() => setCinematic(false)} />
        ) : (
          <ContainmentSequence hqName={hq?.name ?? 'HQ'} onDone={() => setCinematic(false)} />
        )}
        <button
          style={{ zIndex: 2147483647 }}
          className="fixed bottom-5 right-5 border border-edge bg-black/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-mute hover:text-text"
          onClick={() => setCinematic(false)}
        >
          Skip ▸
        </button>
      </div>
    );

  const stats: Array<[string, string | number]> = [
    ['Night length', mmss(s.durationMs)],
    ['Camera sightings', s.sightings],
    ['…of which decoys', s.falseSightings],
    ['Decoys exposed', s.decoysExposed],
    ['Sensor pings', s.sensorPings],
    ['Scans', s.scans],
    ['Traps armed / sprung', `${s.trapsArmed} / ${s.trapsTriggered}`],
    ['Containment attempts', s.containmentAttempts],
    ['Sabotages', s.sabotages],
    ['Repairs', s.repairs],
    ['Random failures', s.cameraFailures],
    ['Power spent', Math.round(s.powerSpent)],
    ['Power outages', s.powerOutages],
    ['Door-seconds sealed', Math.round(s.doorCloseSeconds)],
    ['Monster distance', `${Math.round(s.monsterDistanceKm)} km`],
    ['Nodes visited', s.monsterNodesVisited],
    ['Commands issued', s.commandsIssued],
  ];

  return (
    <div className="flex h-full flex-col" data-testid="results-screen">
      <div
        className={clsx(
          'relative flex flex-col items-center justify-center gap-2 border-b py-8',
          result.winner === 'monster'
            ? 'border-monster/50 bg-[radial-gradient(ellipse_at_center,#2a0b12_0%,#050607_70%)]'
            : 'border-ok/30 bg-[radial-gradient(ellipse_at_center,#0c2219_0%,#050607_70%)]',
        )}
      >
        <div className="absolute right-4 top-3">
          <AudioControls />
        </div>
        <div className="font-mono text-[11px] uppercase tracking-[0.5em] text-dim">
          {myTeam ? (won ? 'Victory' : 'Defeat') : 'Match over'}
        </div>
        <h1
          className={clsx('text-5xl font-bold tracking-tight', result.winner === 'monster' ? 'text-monster-hi' : 'text-ok')}
          data-testid="winner"
        >
          {result.winner === 'monster' ? 'The Monster Wins' : 'The Defenders Win'}
        </h1>
        <div className="text-sm text-mute">
          {REASON[result.reason]} · {hq?.name}
          {result.approachId ? ` · ${approachLabel(result.hqId, result.approachId)}` : ''}
        </div>
        <div className="mt-3 flex gap-2">
          {me?.isHost ? (
            <Button tone="cyan" size="lg" onClick={() => void lobby.restart()} data-testid="play-again">
              Play again
            </Button>
          ) : (
            <Badge tone="neutral">Waiting for host to restart…</Badge>
          )}
          {hasCinematic && (
            <Button size="lg" tone="ghost" onClick={() => setCinematic(true)}>
              {result.reason === 'breach' ? 'Replay breach' : 'Replay capture'}
            </Button>
          )}
          <Button size="lg" tone="ghost" onClick={leaveRoom}>
            Leave
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-[300px_1fr_1fr]">
        <Panel title="Stats" bodyClass="overflow-auto">
          <dl className="divide-y divide-edge">
            {stats.map(([k, v]) => (
              <div key={k} className="flex justify-between px-3 py-1.5 text-xs">
                <dt className="text-mute">{k}</dt>
                <dd className="font-mono tabular-nums text-bright">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="The monster's route (revealed)">
          <MapPanel
            hqId={result.hqId}
            path={result.monsterPath.map((p) => p.nodeId)}
            breachApproachId={result.reason === 'breach' ? result.approachId : null}
            monster={result.monsterPath.length ? { nodeId: result.monsterPath.at(-1)!.nodeId, moving: null } : null}
          />
        </Panel>
        <Panel title="Timeline (all sides)" bodyClass="overflow-auto">
          <ol className="font-mono text-[11px]">
            {result.timeline.map((e) => (
              <li key={e.id} className="flex gap-2 border-b border-edge/60 px-2 py-1">
                <span className="shrink-0 tabular-nums text-dim">{mmss(e.t)}</span>
                <span
                  className={clsx(
                    e.severity === 'alert' && 'text-[#ff8a93]',
                    e.severity === 'warn' && 'text-[#f3d28d]',
                    e.severity === 'good' && 'text-[#9fe8bf]',
                    e.text.includes('[DECOY]') && 'text-monster-hi',
                  )}
                >
                  {e.text}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
