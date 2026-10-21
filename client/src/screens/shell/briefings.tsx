// Role briefings and the "how to play" sheet. Copy mirrors docs/MECHANICS.md (numbers come from config).
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { DEFAULT_CONFIG, type Role } from '@fnab/shared';
import { Kbd } from '../../ui/kit';

const C = DEFAULT_CONFIG;
const capS = Math.round(C.containment.captureMs / 1000);
const trapS = Math.round(C.traps.holdMs / 1000);
const prepS = Math.round(C.match.prepMs / 1000);

function Keys({ k }: { k: string[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {k.map((x) => (
        <Kbd key={x}>{x}</Kbd>
      ))}
    </span>
  );
}

interface Brief {
  role: Exclude<Role, 'spectator'>;
  name: string;
  goal: (hq: string) => string;
  points: ReactNode[];
  controls: Array<[ReactNode, string]>;
}

export const BRIEFS: Record<'defender' | 'monster', Brief> = {
  defender: {
    role: 'defender',
    name: 'Defender',
    goal: (hq) => `Keep it out of ${hq} until dawn — or trap it and hold containment for ${capS} seconds.`,
    points: [
      'Cameras only catch glimpses. A sighting is a moment, not a track. Scan a node to confirm it and expose decoys.',
      'Doors, sensors and containment draw on one shared power pool. At zero, every system goes dark.',
      'Seal a door only when it is at the door. Sealed doors heat up and jam open.',
      `Traps are invisible to the monster and hold it for ${trapS} seconds. Engage containment before it struggles free.`,
      'A dead feed is a clue. Repair sabotaged cameras to get your eyes back.',
    ],
    controls: [
      [<Kbd key="c">Click</Kbd>, 'a feed to put it on the main monitor'],
      [<Keys key="t" k={['I', 'S', 'T', 'C', 'L']} />, 'map tool: inspect, sensor, trap, scan, lure'],
      [<Keys key="d" k={['Q', 'W', 'E']} />, 'seal or open the three doors'],
      [<Kbd key="e">Esc</Kbd>, 'back to inspect'],
    ],
  },
  monster: {
    role: 'monster',
    name: 'Monster',
    goal: (hq) => `Break through one of the three doors of ${hq} before dawn.`,
    points: [
      `During the ${prepS}-second preparation, choose where you emerge and an opening stance.`,
      'Command the entity with stances: HUNT, HIDE, FLANK, ATTACK, RETREAT. It walks the freeways between cameras on its own.',
      'Every working camera you pass may glimpse you. HIDE is slow but nearly invisible.',
      'SABOTAGE blinds a nearby camera. DECOY plants a false sighting somewhere else.',
      'Only ATTACK breaches before the night escalates. If you are trapped, RETREAT to struggle free.',
    ],
    controls: [
      [<Keys key="s" k={['H', 'C', 'F', 'A', 'R']} />, 'stance: hunt, hide (creep), flank, attack, retreat'],
      [<Keys key="a" k={['S', 'D']} />, 'aim sabotage or decoy, then click a node'],
      [<Kbd key="sp">Space</Kbd>, 'struggle (retreat) while trapped'],
      [<Kbd key="e">Esc</Kbd>, 'cancel the ability you were aiming'],
    ],
  },
};

export const PHASES: Array<{ id: string; name: string; desc: string }> = [
  { id: 'preparation', name: 'Preparation', desc: `${prepS} s. Defenders set sensors and traps; the monster picks a spawn.` },
  { id: 'infiltration', name: 'Infiltration', desc: 'It moves through the outer cameras. Breaching is slow.' },
  { id: 'escalation', name: 'Escalation', desc: 'Faster and bolder. Power and traps start to matter.' },
  { id: 'final', name: 'Final assault', desc: 'It comes for the doors. Commit everything.' },
];

export function RoleBriefing({
  role,
  hqName,
  compact,
  className,
  pointsClassName,
}: {
  role: Role;
  hqName: string;
  compact?: boolean;
  className?: string;
  /** Extra classes for the bullet list (e.g. hide it on short screens). */
  pointsClassName?: string;
}) {
  if (role === 'spectator')
    return (
      <div className={clsx('text-[13px] leading-relaxed text-mute', className)}>
        <p className="text-text">You watch the control room exactly as the defenders see it.</p>
        <p className="mt-2">
          Nothing the monster knows is shown to you, so you can sit next to either team. Pick a role in the lobby to play the next night.
        </p>
      </div>
    );
  const b = BRIEFS[role];
  const monster = role === 'monster';
  return (
    <div className={clsx('flex flex-col gap-3', className)}>
      <p className={clsx('font-display text-[17px] font-bold leading-snug', monster ? 'text-bone' : 'text-bright')}>{b.goal(hqName)}</p>
      <ul className={clsx('flex flex-col gap-1.5', pointsClassName)}>
        {(compact ? b.points.slice(0, 3) : b.points).map((p, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-snug text-mute">
            <span aria-hidden className={clsx('mt-[7px] h-px w-2.5 shrink-0', monster ? 'bg-blood-hi' : 'bg-cyan')} />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      {!compact && (
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 border-t border-edge pt-3 text-[12px]">
          {b.controls.map(([k, v], i) => (
            <div key={i} className="contents">
              <dt className="whitespace-nowrap text-right">{k}</dt>
              <dd className="text-mute">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
