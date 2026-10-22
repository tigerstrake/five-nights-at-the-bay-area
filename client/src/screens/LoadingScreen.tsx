import clsx from 'clsx';
import type { RoomView } from '@fnab/shared';
import { DEFAULT_CONFIG } from '@fnab/shared';
import { serverNow } from '../state/store';
import { useNow } from '../hooks/useNow';
import { hqById, NETWORK } from '../lib/data';
import { Meter } from '../ui/kit';
import { SettingsMenu } from '../ui/chrome';
import { useUiAssets } from '../ui/assets';
import { BrandMark } from './shell/Brand';
import { MiniMap } from './shell/MiniMap';
import { RoleBriefing } from './shell/briefings';
import { useUplink, type CheckState } from './shell/uplink';

const TIPS = {
  monster: [
    'HUNT stalks the HQ; it only breaches once the night escalates.',
    'HIDE is slow but nearly invisible. FLANK finds the weakest door.',
    'Sabotaged cameras are blind spots. Route through them.',
    'A decoy sighting looks real to them, unless they scan it.',
    'Trapped? RETREAT to struggle free before containment completes.',
  ],
  defender: [
    'Doors drain power and overheat. Close them only when it is at the door.',
    'Sightings are glimpses, not tracking. Scan to confirm, and to expose decoys.',
    'A trap alone never wins. Engage containment and hold it for 15 seconds.',
    'Power out means blackout: every system goes dark until auxiliary power returns.',
    'Lures draw a hunting monster toward a node. Maybe one with a trap.',
  ],
  spectator: ['You see what the defenders see, and nothing the monster knows.', 'Watch the doors: that is where nights are lost.'],
} as const;

const STATE_TEXT: Record<CheckState, string> = { pending: '····', ok: 'OK', degraded: 'DEGRADED', timeout: 'SKIPPED' };

export function LoadingScreen({ room }: { room: RoomView }) {
  useNow(100);
  const checks = useUplink((s) => s.checks);
  const assets = useUiAssets();
  const me = room.players.find((p) => p.id === room.youId);
  const role = me?.role ?? 'spectator';
  const monster = role === 'monster';
  const counting = room.stage === 'countdown' && !!room.countdownEndsAt;
  const left = counting ? Math.max(0, room.countdownEndsAt! - serverNow()) : 0;
  const total = DEFAULT_CONFIG.match.countdownMs;
  const secs = Math.ceil(left / 1000);
  const hq = hqById(room.settings.hqId);
  const tips = TIPS[role];
  const tip = tips[Math.floor(Date.now() / 4500) % tips.length];
  const settled = checks.filter((c) => c.state !== 'pending').length;
  const defenders = room.players.filter((p) => p.role === 'defender').length;

  return (
    <div
      className={clsx('relative flex h-full flex-col overflow-hidden', monster ? 'bg-blood-ink' : 'bg-void')}
      data-testid="loading-screen"
    >
      <img
        aria-hidden
        src={assets.keyartSmall ?? assets.keyart}
        alt=""
        draggable={false}
        className={clsx('pointer-events-none absolute inset-0 h-full w-full object-cover opacity-[0.12]', monster ? 'sepia' : 'grayscale')}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: monster
            ? 'radial-gradient(ellipse at 70% 40%, rgba(125,20,32,0.28) 0%, transparent 60%), linear-gradient(0deg, #0a0304 0%, transparent 60%)'
            : 'radial-gradient(ellipse at 70% 40%, rgba(59,198,214,0.12) 0%, transparent 60%), linear-gradient(0deg, #050607 0%, transparent 60%)',
        }}
      />
      <header className="relative z-10 flex items-center justify-between px-6 py-4">
        <BrandMark />
        <SettingsMenu />
      </header>

      <main className="relative z-10 mx-auto grid min-h-0 w-full max-w-[1180px] flex-1 grid-cols-1 items-center gap-10 px-6 pb-6 max-lg:auto-rows-max max-lg:content-center-safe max-lg:overflow-y-auto max-md:gap-6 max-md:px-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* Uplink checklist */}
        <section aria-label="Uplink status" className="motion-safe:animate-rise">
          <div className="font-mono text-[11px] uppercase tracking-[0.34em] text-dim">
            <span className={clsx('mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle motion-safe:animate-blink', monster ? 'bg-blood-hi' : 'bg-cyan')} />
            {counting ? 'Establishing secure uplink' : 'Synchronising with the night'}
          </div>
          <h1 className={clsx('mt-3 font-display text-[clamp(30px,3.4vw,46px)] font-extrabold leading-[1.02]', monster ? 'text-bone' : 'text-bright')}>
            {monster ? 'You are the Monster' : role === 'defender' ? 'You are on the night shift' : 'You are spectating'}
          </h1>
          <p className="mt-2 text-[14px] text-mute">
            {monster ? 'Target' : 'Defending'}: <span className="text-text">{hq?.name}</span> · {room.settings.durationSec / 60} minute night ·{' '}
            {defenders} defender{defenders === 1 ? '' : 's'} · {NETWORK.nodes.length} cameras
          </p>

          <ol className="mt-7 max-w-[560px] border-y border-edge font-mono text-[12px]" data-testid="uplink-checks">
            {checks.map((c) => (
              <li key={c.id} className="flex items-baseline gap-3 border-b border-edge/60 py-2 last:border-b-0" data-state={c.state}>
                <span
                  className={clsx(
                    'h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full',
                    c.state === 'ok' && (monster ? 'bg-bone' : 'bg-ok'),
                    c.state === 'pending' && 'bg-dim motion-safe:animate-pulse',
                    (c.state === 'degraded' || c.state === 'timeout') && 'bg-warn',
                  )}
                />
                <span className="w-36 shrink-0 text-text">{c.label}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{c.detail}</span>
                <span
                  className={clsx(
                    'w-16 shrink-0 text-right text-[10px] tracking-[0.14em]',
                    c.state === 'ok' ? (monster ? 'text-bone' : 'text-ok') : c.state === 'pending' ? 'text-dim' : 'text-warn',
                  )}
                >
                  {STATE_TEXT[c.state]}
                </span>
              </li>
            ))}
            {!checks.length && <li className="py-2 text-dim">Contacting server…</li>}
          </ol>
          <Meter value={checks.length ? settled / checks.length : 0} tone={monster ? 'blood' : 'cyan'} className="mt-3 max-w-[560px]" segments={checks.length || 5} />

          <div className={clsx('mt-7 max-w-[560px] border-l-2 py-1 pl-4', monster ? 'border-blood-hi' : 'border-cyan')}>
            <RoleBriefing role={role} hqName={hq?.name ?? 'headquarters'} compact />
          </div>
        </section>

        {/* Countdown + target */}
        <section className="flex flex-col items-center gap-5 lg:items-end" aria-live="polite">
          <div className="relative flex h-[260px] w-[260px] items-center justify-center">
            <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90" aria-hidden>
              <circle cx="50" cy="50" r="47" fill="none" stroke="#252b31" strokeWidth="0.8" />
              <circle
                cx="50"
                cy="50"
                r="47"
                fill="none"
                stroke={monster ? '#b3202f' : '#3bc6d6'}
                strokeWidth="1.4"
                strokeDasharray={`${2 * Math.PI * 47}`}
                strokeDashoffset={`${2 * Math.PI * 47 * (counting ? left / total : 0)}`}
                style={{ transition: 'stroke-dashoffset 100ms linear' }}
              />
            </svg>
            <div className="absolute inset-7 opacity-50">{hq && <MiniMap hqId={hq.id} tone={monster ? 'bone' : 'cyan'} showOtherHqs={false} />}</div>
            <div
              key={counting ? secs : 'sync'}
              className={clsx(
                'relative font-display text-[150px] font-black leading-none tabular-nums motion-safe:animate-rise',
                monster ? 'text-bone [text-shadow:0_0_40px_rgba(179,32,47,0.55)]' : 'text-bright [text-shadow:0_0_40px_rgba(59,198,214,0.35)]',
              )}
              data-testid="countdown"
            >
              {counting ? secs : '··'}
            </div>
          </div>
          <div className="text-center font-mono text-[11px] uppercase tracking-[0.28em] text-dim lg:text-right">
            {counting ? 'Night begins' : 'Waiting for the first frame'}
          </div>
          <p className="max-w-[360px] text-center text-[13px] leading-snug text-mute lg:text-right" key={tip}>
            {tip}
          </p>
        </section>
      </main>
    </div>
  );
}
