// HUD layered over the map: position plate, targeting bar, legend, breach banner and the trapped struggle.
import clsx from 'clsx';
import type { Headquarters, MonsterView } from '@fnab/shared';
import { nodeName } from '../../lib/data';
import type { Situation } from './model';

export function PositionPlate({ view, sit, hq }: { view: MonsterView; sit: Situation; hq: Headquarters }) {
  const self = view.self;
  if (!self.spawned) return null;
  const target = self.targetApproachId ? hq.approaches.find((a) => a.id === self.targetApproachId) : null;
  return (
    <div className="pointer-events-none absolute left-2 top-2 z-[2] w-[250px] max-w-[60%] border border-[var(--mx-scar)] bg-[#070404e6] px-2.5 py-1.5">
      <div className="text-[10px] text-[var(--mx-ash)]">{self.moving ? 'Moving' : 'You are at'}</div>
      <div className="text-[14px] font-medium leading-tight text-[var(--mx-bone)]">
        {self.moving ? `${nodeName(self.moving.from)} → ${nodeName(self.moving.to)}` : nodeName(self.nodeId)}
      </div>
      {self.moving && (
        <div className="mx-bar mt-1 !h-1">
          <span style={{ width: `${self.moving.progress * 100}%` }} />
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 text-[10.5px] text-[var(--mx-ash)]">
        <span>
          {sit.hopsToHq === 0 ? (
            <span className="text-[var(--mx-vein)]">At the doors of {hq.name}</span>
          ) : (
            <>
              <span className="mx-readout">{sit.hopsToHq ?? '—'}</span> hop{sit.hopsToHq === 1 ? '' : 's'} to {hq.name}
            </>
          )}
        </span>
        <span>
          <span className="text-[var(--mx-vein)]">{self.stance}</span>
          {target ? ` → ${target.door}` : ' → AI picks the door'}
        </span>
      </div>
    </div>
  );
}

export function TargetingBar({
  mode,
  pendingName,
  pendingKind,
  canSwitchKind,
  onSwitchKind,
  onConfirm,
  onCancel,
  range,
  count,
}: {
  mode: 'sabotage' | 'decoy';
  pendingName: string | null;
  pendingKind: 'camera' | 'sensor';
  canSwitchKind: boolean;
  onSwitchKind: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  range: number;
  count: number;
}) {
  return (
    // Top-left, clear of the map-mode toggle (top-right) at every width.
    <div className="absolute left-2 right-[176px] top-2 z-[3] flex justify-start" data-testid="monster-targeting">
      <div className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 border border-[var(--mx-vein)] bg-[#12050ae8] px-3 py-1.5 shadow-[0_0_30px_-8px_#ff3a4f]">
        <span className="mx-slab-title text-[var(--mx-vein)]">{mode}</span>
        <span className="text-[12px] text-[var(--mx-bone)]">
          {pendingName
            ? mode === 'sabotage'
              ? `Kill the ${pendingKind} at ${pendingName}?`
              : `Plant a false sighting on ${pendingName}?`
            : count
              ? `Pick a ${mode === 'sabotage' ? 'camera or sensor' : 'working camera'} within ${range} hop${range === 1 ? '' : 's'} (${count} in reach)`
              : 'Nothing in reach. Move closer.'}
        </span>
        {pendingName && canSwitchKind && (
          <button type="button" className="mx-door" onClick={onSwitchKind}>
            Target the {pendingKind === 'camera' ? 'sensor' : 'camera'} instead
          </button>
        )}
        {pendingName && (
          <button
            type="button"
            className="mx-door !border-[var(--mx-vein)] !text-[var(--mx-bone)]"
            onClick={onConfirm}
            data-testid="target-confirm"
          >
            <span className="mx-key !h-4 !text-[9px]">Enter</span> {mode === 'sabotage' ? 'Sabotage' : 'Plant decoy'}
          </button>
        )}
        <button type="button" className="mx-door" onClick={onCancel} data-testid="target-cancel">
          <span className="mx-key !h-4 !text-[9px]">Esc</span> Cancel
        </button>
      </div>
    </div>
  );
}

export function Legend({ prep }: { prep: boolean }) {
  const item = (swatch: React.ReactNode, label: string) => (
    <span className="flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  );
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 z-[2] flex flex-wrap gap-x-3 gap-y-1 border border-[var(--mx-scar)] bg-[#070404d9] px-2 py-1 text-[10px] text-[var(--mx-ash)]">
      {prep ? (
        item(<span className="h-2.5 w-2.5 rounded-full border-2 border-[#a3243a]" />, 'emergence point')
      ) : (
        <>
          {item(<span className="h-0.5 w-4 bg-[#e04a62]" />, 'your route')}
          {item(<span className="h-2 w-2 rounded-full border-2 border-dashed border-[#d49a2a]" />, 'known sensor')}
          {item(<span className="h-2 w-2 rounded-full border border-dotted border-[#c8323a]" />, 'maybe seen')}
          {item(<span className="h-2 w-2 rounded-full border border-[#d49a2a]" />, 'disturbance')}
          {item(<span className="h-2 w-2 rounded-full border border-dashed border-[#3bc6d6]" />, 'scan felt')}
        </>
      )}
      {item(<span className="h-1.5 w-1.5 rounded-full bg-[#3ec47a]" />, 'camera live')}
      {item(<span className="h-1.5 w-1.5 rounded-full bg-[#c8323a]" />, 'camera dead')}
    </div>
  );
}

export function BreachBanner({ view, hq }: { view: MonsterView; hq: Headquarters }) {
  const b = view.breach;
  if (!b) return null;
  const ap = hq.approaches.find((a) => a.id === b.approachId);
  return (
    <div className="absolute inset-x-0 bottom-10 z-[3] flex justify-center px-2" data-testid="monster-breach">
      <div
        className={clsx(
          'w-[min(520px,100%)] border px-3 py-2',
          b.stalled ? 'border-[var(--mx-ember)] bg-[#1a0d06ee]' : 'border-[var(--mx-vein)] bg-[#24050aee] shadow-[0_0_40px_-6px_#ff3a4f]',
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="mx-slab-title !text-[20px]">
            {b.stalled ? `${ap?.door ?? 'Door'} is sealed` : `Tearing through ${ap?.door ?? 'the door'}`}
          </span>
          <span className="mx-readout text-[13px]">{Math.round(b.progress * 100)}%</span>
        </div>
        <div className="mx-bar mt-1.5 !h-2.5">
          <span style={{ width: `${b.progress * 100}%`, background: b.stalled ? '#d98a3a' : undefined }} />
        </div>
        <div className="mt-1 text-[11px] text-[var(--mx-ash)]">
          {b.stalled
            ? 'Battering it. Progress decays while it holds; it jams open if they keep it sealed too long.'
            : 'They know where you are now. Keep going.'}
        </div>
      </div>
    </div>
  );
}

export function TrappedOverlay({
  view,
  t,
  retreatLeft,
  calm,
  onStruggle,
}: {
  view: MonsterView;
  t: number;
  retreatLeft: number;
  calm: boolean;
  onStruggle: () => void;
}) {
  const held = view.self.held;
  if (!held) return null;
  const contained = held.contained || !!view.containment;
  const holdLeft = Math.max(0, held.until - t);
  const capture = view.containment?.progress ?? 0;
  return (
    <div className="mx-trapped" data-contained={contained ? '1' : '0'} data-testid="monster-trapped">
      <div
        className={clsx(
          'relative flex w-[min(480px,92%)] flex-col items-center gap-3 border border-[#ff3a4f40] bg-[#0b0203f2] px-6 py-5 text-center shadow-[0_0_80px_20px_#000]',
          held.struggling && !calm && 'mx-shake',
        )}
      >
        <div className="font-mono text-[11px] text-[#ffb9b1]">Trapped at {nodeName(view.self.nodeId)}</div>
        <div className="mx-slab-title !text-[44px] !leading-[0.9] text-[#ffe2dc]">
          {held.struggling ? 'Breaking free' : contained ? 'Containment field' : 'You are caught'}
        </div>
        <div className="text-[12px] leading-snug text-[#e9cfc8]">
          {contained
            ? `Break free before the field holds you for good.`
            : `The trap holds you${holdLeft < 60_000 ? ` for ${Math.ceil(holdLeft / 1000)}s more` : ''}. If they engage containment, it won't let go.`}
        </div>
        <div className="grid w-full grid-cols-1 gap-2 text-left">
          <div>
            <div className="flex justify-between text-[11px] text-[#e9cfc8]">
              <span>Your struggle</span>
              <span className="mx-readout">{Math.round(held.struggle * 100)}%</span>
            </div>
            <div className="mx-bar mt-0.5 !h-3">
              <span style={{ width: `${held.struggle * 100}%`, background: '#e4d9c8' }} />
            </div>
          </div>
          {view.containment && (
            <div>
              <div className="flex justify-between text-[11px] text-[#ffb9b1]">
                <span>Capture</span>
                <span className="mx-readout">{Math.round(capture * 100)}%</span>
              </div>
              <div className="mx-bar mt-0.5 !h-3">
                <span style={{ width: `${capture * 100}%` }} />
              </div>
            </div>
          )}
        </div>
        {held.struggling ? (
          <div className="mx-slab-title !text-[22px] text-[var(--mx-vein)]">Struggling…</div>
        ) : (
          <button type="button" className="mx-struggle" disabled={retreatLeft > 0} onClick={onStruggle} data-testid="monster-struggle">
            {retreatLeft > 0 ? `Struggle in ${Math.ceil(retreatLeft / 1000)}s` : 'Struggle'}
            <span className="mx-key ml-3 align-middle">Space</span>
          </button>
        )}
        <div className="text-[10.5px] text-[#c9a7a0]">DECOY still works while you're held. Pull their eyes elsewhere.</div>
      </div>
    </div>
  );
}
