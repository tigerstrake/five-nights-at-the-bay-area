import { useEffect, useRef, useState } from 'react';
import { AI_PLAYER_CONFIG, type AiDifficulty, type SoloOptions } from '@fnab/shared';
import { Button, Segmented } from '../../ui/kit';

const DIFFICULTIES: Array<{ value: AiDifficulty; label: string; title: string }> = [
  { value: 'novice', label: 'Novice', title: 'Slower reactions and less attention' },
  { value: 'competent', label: 'Competent', title: 'Attentive, with room to outplay it' },
  { value: 'expert', label: 'Expert', title: 'Quick reactions and careful resource use' },
];

export function AiDifficultyControl({ value, onChange, disabled, testIdPrefix }: {
  value: AiDifficulty; onChange: (value: AiDifficulty) => void; disabled?: boolean; testIdPrefix: string;
}) {
  return <Segmented options={DIFFICULTIES} value={value} onChange={onChange} disabled={disabled} testIdPrefix={testIdPrefix} />;
}

export function SoloSetup({ busy, disabled, onStart, onClose }: {
  busy: boolean; disabled: boolean; onStart: (options: SoloOptions) => void; onClose: () => void;
}) {
  const [role, setRole] = useState<SoloOptions['role']>('defender');
  const [difficulty, setDifficulty] = useState<AiDifficulty>('competent');
  const [teammates, setTeammates] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key !== 'Tab') return;
      const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = buttons?.[0], last = buttons?.[buttons.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [busy, onClose]);
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onPointerDown={e => e.target === e.currentTarget && !busy && onClose()} data-testid="solo-setup">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="solo-title"
        className="max-h-full w-full max-w-[440px] overflow-auto border border-edge-hi bg-panel shadow-[0_30px_90px_rgba(0,0,0,0.7)] outline-none motion-safe:animate-rise">
        <header className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 id="solo-title" className="font-display text-lg font-extrabold text-bright">Your solo night</h2>
          <Button tone="ghost" size="sm" disabled={busy} onClick={onClose}>Close ×</Button>
        </header>
        <div className="space-y-4 p-5">
          <p className="text-[13px] leading-relaxed text-mute">Take a side. AI players will fill the other console. Choose your headquarters in the lobby.</p>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-[12px] text-mute">Your role</legend>
            <Segmented options={[{ value: 'defender', label: 'Defender' }, { value: 'monster', label: 'Monster' }]}
              value={role} onChange={setRole} disabled={busy} testIdPrefix="solo-role" />
          </fieldset>
          <fieldset>
            <legend className="mb-1.5 text-[12px] text-mute">AI difficulty</legend>
            <AiDifficultyControl value={difficulty} onChange={setDifficulty} disabled={busy} testIdPrefix="solo-difficulty" />
          </fieldset>
          {role === 'defender' && <fieldset>
            <legend className="mb-1.5 text-[12px] text-mute">AI teammates</legend>
            <Segmented options={Array.from({ length: AI_PLAYER_CONFIG.soloMaxTeammates + 1 }, (_, value) => ({ value, label: value === 0 ? 'Just me' : `${value} AI` }))}
              value={teammates} onChange={setTeammates} disabled={busy} testIdPrefix="solo-teammates" />
          </fieldset>}
          <Button size="lg" tone={role === 'monster' ? 'blood' : 'cyan'} className="w-full" disabled={busy || disabled}
            onClick={() => onStart({ role, difficulty, teammates: role === 'defender' ? teammates : 0 })} data-testid="solo-start">
            {busy ? 'Opening…' : 'Enter lobby'}
          </Button>
        </div>
      </div>
    </div>
  );
}
