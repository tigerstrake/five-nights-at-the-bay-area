import type { RoomView } from '@fnab/shared';
import { serverNow } from '../state/store';
import { useNow } from '../hooks/useNow';
import { hqById, NETWORK } from '../lib/data';
import { Meter } from '../ui/kit';

const TIPS = {
  monster: [
    'HUNT stalks the HQ; it only breaches once the night escalates.',
    'HIDE is slow but nearly invisible. FLANK finds the weakest door.',
    'Sabotaged cameras are blind spots — route through them.',
    'A decoy sighting is indistinguishable… unless they scan it.',
    'Trapped? RETREAT to struggle free before containment completes.',
  ],
  defender: [
    'Doors drain power and overheat — close them only when it is at the door.',
    'Sightings are glimpses, not tracking. Scan to confirm (and expose decoys).',
    'A trap alone never wins. Engage containment and hold it for 15 seconds.',
    'Power out = blackout. Every system goes dark until auxiliary power returns.',
    'Lures draw a hunting monster toward a node — maybe one with a trap.',
  ],
  spectator: ['You see what the defenders see.'],
} as const;

export function LoadingScreen({ room }: { room: RoomView }) {
  useNow(100);
  const me = room.players.find((p) => p.id === room.youId);
  const role = me?.role ?? 'spectator';
  const left = room.countdownEndsAt ? Math.max(0, room.countdownEndsAt - serverNow()) : 0;
  const hq = hqById(room.settings.hqId);
  const tips = TIPS[role];
  const tip = tips[Math.floor(Date.now() / 4000) % tips.length];
  const total = 5000;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6">
      <div className="font-mono text-[11px] uppercase tracking-[0.5em] text-dim">
        {room.stage === 'countdown' ? 'Establishing uplink' : 'Synchronising'}
      </div>
      <div
        className="font-mono text-8xl font-semibold tabular-nums text-bright [text-shadow:0_0_30px_rgba(59,198,214,0.25)]"
        data-testid="countdown"
      >
        {room.stage === 'countdown' ? Math.ceil(left / 1000) : '··'}
      </div>
      <Meter value={room.stage === 'countdown' ? 1 - left / total : 1} className="w-80" />
      <div className="text-center">
        <div className={role === 'monster' ? 'text-lg font-semibold text-monster-hi' : 'text-lg font-semibold text-cyan'}>
          {role === 'monster' ? 'You are the Monster' : role === 'defender' ? 'You are a Defender' : 'Spectating'}
        </div>
        <div className="mt-1 text-sm text-mute">
          {role === 'monster' ? `Target: ${hq?.name}` : `Defending: ${hq?.name}`} · {room.settings.durationSec / 60} minute night ·{' '}
          {NETWORK.nodes.length} cameras
        </div>
      </div>
      <div className="max-w-lg border border-edge bg-panel/80 px-4 py-2 text-center text-sm text-text">{tip}</div>
    </div>
  );
}
