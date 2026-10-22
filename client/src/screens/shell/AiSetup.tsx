import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AI_PLAYER_CONFIG, type AiDifficulty, type SoloOptions } from '@fnab/shared';
import { audio } from '../../audio';
import { Button, Segmented } from '../../ui/kit';

const DIFFICULTIES: Array<{ value: AiDifficulty; label: string; title: string }> = [
  { value: 'novice', label: 'Novice', title: 'Slower reactions and less attention' },
  { value: 'competent', label: 'Competent', title: 'Attentive, with room to outplay it' },
  { value: 'expert', label: 'Expert', title: 'Quick reactions and careful resource use' },
];

/** What each difficulty means, from the point of view of the human's role. */
const DIFFICULTY_COPY: Record<SoloOptions['role'], Record<AiDifficulty, string>> = {
  defender: {
    novice: 'Makes obvious moves and reacts slowly. A good first night.',
    competent: 'Sneaks, sabotages cameras and plants decoys. A fair fight.',
    expert: 'Fast and cunning. Punishes open doors and late traps.',
  },
  monster: {
    novice: 'Misses glimpses and reacts slowly. A good first night.',
    competent: 'Watches the feeds and seals doors in time. A fair fight.',
    expert: 'Sharp-eyed and quick. Expect traps on your routes.',
  },
};

const ROLES: Array<{ value: SoloOptions['role']; name: string; line: string }> = [
  { value: 'defender', name: 'Defender', line: 'Run the control room. Watch the cameras, seal the doors, trap it before dawn.' },
  { value: 'monster', name: 'Monster', line: 'Be the thing in the cameras. Pick your moments and break into their HQ.' },
];

export function AiDifficultyControl({
  value,
  onChange,
  disabled,
  testIdPrefix,
  className,
  tone,
}: {
  value: AiDifficulty;
  onChange: (value: AiDifficulty) => void;
  disabled?: boolean;
  testIdPrefix: string;
  className?: string;
  tone?: 'cyan' | 'bone';
}) {
  return (
    <Segmented options={DIFFICULTIES} value={value} onChange={onChange} disabled={disabled} testIdPrefix={testIdPrefix} className={className} tone={tone} />
  );
}

export function SoloSetup({
  busy,
  disabled,
  name,
  onStart,
  onClose,
}: {
  busy: boolean;
  disabled: boolean;
  /** Name the player will use (blank falls back to the server default). */
  name?: string;
  onStart: (options: SoloOptions) => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<SoloOptions['role']>('defender');
  const [difficulty, setDifficulty] = useState<AiDifficulty>('competent');
  const [teammates, setTeammates] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const roleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    roleRefs.current[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key !== 'Tab') return;
      const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = buttons?.[0],
        last = buttons?.[buttons.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [busy, onClose]);

  const pickRole = (r: SoloOptions['role']) => {
    if (r === role) return;
    audio.play('uiClick', { volume: 0.5 });
    setRole(r);
  };
  const monster = role === 'monster';

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm max-sm:items-end max-sm:p-0"
      onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      data-testid="solo-setup"
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="solo-title"
        aria-describedby="solo-desc"
        className={clsx(
          'max-h-full w-full max-w-[520px] overflow-auto border bg-panel shadow-[0_30px_90px_rgba(0,0,0,0.7)] outline-none transition-colors motion-safe:animate-rise',
          monster ? 'border-blood/70' : 'border-edge-hi',
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-edge px-5 pb-3 pt-4">
          <div>
            <h2 id="solo-title" className="font-display text-xl font-extrabold text-bright">
              Play solo
            </h2>
            <p id="solo-desc" className="mt-1 text-[13px] leading-relaxed text-mute">
              Take one side and AI players run the other. You pick the headquarters and night length in the lobby.
            </p>
          </div>
          <Button tone="ghost" size="sm" disabled={busy} onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>

        <div className="space-y-5 px-5 py-4">
          <fieldset>
            <legend className="mb-2 text-[12px] text-mute">Your side</legend>
            <div role="radiogroup" aria-label="Your side" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ROLES.map((r, i) => {
                const sel = r.value === role;
                return (
                  <button
                    key={r.value}
                    ref={(el) => {
                      roleRefs.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    disabled={busy}
                    onClick={() => pickRole(r.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                      e.preventDefault();
                      const next = ROLES[(i + 1) % ROLES.length]!;
                      pickRole(next.value);
                      roleRefs.current[(i + 1) % ROLES.length]?.focus();
                    }}
                    data-testid={`solo-role-${r.value}`}
                    className={clsx(
                      'relative flex flex-col items-start gap-1 border px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed',
                      sel
                        ? r.value === 'monster'
                          ? 'border-blood-hi/80 bg-[#1f0a0d]'
                          : 'border-cyan/70 bg-cyan-dim/35'
                        : 'border-edge bg-panel-2/60 hover:border-edge-hi',
                    )}
                  >
                    <span className="flex w-full items-center justify-between">
                      <span
                        className={clsx(
                          'font-display text-[16px] font-extrabold',
                          sel ? (r.value === 'monster' ? 'text-bone' : 'text-cyan') : 'text-text',
                        )}
                      >
                        {r.name}
                      </span>
                      <span
                        aria-hidden
                        className={clsx(
                          'h-3 w-3 border',
                          r.value === 'monster' ? 'rotate-45' : 'rounded-full',
                          sel ? (r.value === 'monster' ? 'border-blood-hi bg-blood-hi' : 'border-cyan bg-cyan') : 'border-edge-hi',
                        )}
                      />
                    </span>
                    <span className="text-[12.5px] leading-snug text-mute">{r.line}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[12px] text-mute">{monster ? 'How good are the AI defenders?' : 'How good is the AI monster?'}</legend>
            <AiDifficultyControl
              value={difficulty}
              onChange={setDifficulty}
              disabled={busy}
              testIdPrefix="solo-difficulty"
              tone={monster ? 'bone' : 'cyan'}
            />
            <p className="mt-2 min-h-[2.6em] text-[12.5px] leading-snug text-text/85" aria-live="polite" data-testid="solo-difficulty-copy">
              {DIFFICULTY_COPY[role][difficulty]}
            </p>
          </fieldset>

          {role === 'defender' ? (
            <fieldset>
              <legend className="mb-2 text-[12px] text-mute">AI teammates in the control room</legend>
              <Segmented
                options={Array.from({ length: AI_PLAYER_CONFIG.soloMaxTeammates + 1 }, (_, value) => ({
                  value,
                  label: value === 0 ? 'Just me' : `+${value} AI`,
                }))}
                value={teammates}
                onChange={setTeammates}
                disabled={busy}
                testIdPrefix="solo-teammates"
              />
              <p className="mt-2 text-[12px] leading-snug text-dim">
                Teammates share your power and watch the cameras with you. The night scales up with every operator.
              </p>
            </fieldset>
          ) : (
            <p className="border-l-2 border-blood/70 pl-3 text-[12.5px] leading-snug text-mute">
              One AI defender holds the control room. You can add more from the lobby.
            </p>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-edge px-5 py-4">
          <Button
            size="lg"
            tone={monster ? 'blood' : 'cyan'}
            className="w-full"
            disabled={busy || disabled}
            onClick={() => onStart({ role, difficulty, teammates: role === 'defender' ? teammates : 0 })}
            data-testid="solo-start"
          >
            {busy ? 'Opening the lobby…' : 'Enter lobby'}
          </Button>
          <p className="text-center text-[11.5px] text-dim">
            {disabled ? 'Waiting for the game server…' : <>Playing as {name?.trim() || 'Nightwatch'}</>}
          </p>
        </footer>
      </div>
    </div>
  );
}
