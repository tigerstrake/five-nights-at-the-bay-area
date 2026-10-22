import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Button, Segmented } from '../../ui/kit';
import { BRIEFS, PHASES, RoleBriefing } from './briefings';
import { RoleStrategy, type PlayingRole } from './strategy';

type ManualSection = 'basics' | 'strategy';
interface HowToPlayProps {
  open: boolean;
  onClose: () => void;
  initialSection?: ManualSection;
  initialRole?: PlayingRole;
}

/** Reopening always starts on the requested section and role. */
export function HowToPlay({ open, ...props }: HowToPlayProps) {
  return open ? <ManualSheet {...props} /> : null;
}

function ManualSheet({ onClose, initialSection = 'basics', initialRole = 'defender' }: Omit<HowToPlayProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<ManualSection>(initialSection);
  const [role, setRole] = useState<PlayingRole>(initialRole);
  useEffect(() => {
    const trigger = document.activeElement;
    ref.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      data-testid="how-to-play"
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="htp-title"
        onKeyDown={(e) => {
          // Keep match hotkeys from firing while reading or using the manual.
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
          if (e.key === 'Tab') {
            const controls = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea, [tabindex="0"]');
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
        className="relative flex max-h-full w-full max-w-[980px] flex-col overflow-hidden border border-edge-hi bg-panel shadow-[0_30px_90px_rgba(0,0,0,0.7)] outline-none motion-safe:animate-rise"
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 id="htp-title" className="font-display text-lg font-extrabold text-bright">
            How a night works
          </h2>
          <Button tone="ghost" size="sm" onClick={onClose} data-testid="how-to-play-close">
            Close <span aria-hidden>×</span>
          </Button>
        </header>
        <div className="flex flex-wrap gap-3 border-b border-edge px-5 py-3">
          <Segmented<ManualSection>
            options={[{ value: 'basics', label: 'Basics' }, { value: 'strategy', label: 'Strategy' }]}
            value={section}
            onChange={setSection}
            testIdPrefix="how-to-play-section"
          />
          {section === 'strategy' && (
            <Segmented<PlayingRole>
              options={[{ value: 'defender', label: 'Defender' }, { value: 'monster', label: 'Monster' }]}
              value={role}
              onChange={setRole}
              testIdPrefix="how-to-play-role"
            />
          )}
        </div>
        <div key={`${section}-${role}`} className="min-h-0 overflow-auto">
          {section === 'strategy' ? (
            <RoleStrategy role={role} />
          ) : (
            <>
              <p className="px-5 pt-4 text-[13px] leading-relaxed text-mute">
                One player is the monster, walking the freeways between real Caltrans camera locations. Everyone else shares one control room and
                one power supply. The server decides every sighting, trap and breach; neither side sees the other's secrets until the night is over.
              </p>
              <div className="grid gap-px bg-edge md:grid-cols-2">
                {(['defender', 'monster'] as const).map((r) => (
                  <section key={r} className={clsx('bg-panel p-5', r === 'monster' && 'bg-[#0d0809]')}>
                    <div className="mb-3 flex items-center gap-2">
                      <span className={clsx('h-2 w-2', r === 'monster' ? 'bg-blood-hi' : 'bg-cyan')} />
                      <h3 className={clsx('font-display text-[15px] font-extrabold', r === 'monster' ? 'text-bone' : 'text-cyan')}>
                        {BRIEFS[r].name}
                      </h3>
                    </div>
                    <RoleBriefing role={r} hqName="headquarters" />
                  </section>
                ))}
              </div>
              <ol className="grid border-t border-edge sm:grid-cols-4">
                {PHASES.map((p, i) => (
                  <li key={p.id} className="border-edge px-5 py-4 sm:border-l sm:first:border-l-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[10px] text-dim">{i + 1}</span>
                      <span className="text-[13px] font-semibold text-text">{p.name}</span>
                    </div>
                    <p className="mt-1 text-[12px] leading-snug text-mute">{p.desc}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
