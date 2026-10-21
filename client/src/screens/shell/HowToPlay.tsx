import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { BRIEFS, PHASES, RoleBriefing } from './briefings';

/** Modal sheet: both roles side by side, plus the four phases of a night. */
export function HowToPlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
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
        className="relative flex max-h-full w-full max-w-[980px] flex-col overflow-hidden border border-edge-hi bg-panel shadow-[0_30px_90px_rgba(0,0,0,0.7)] outline-none motion-safe:animate-rise"
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-3">
          <h2 id="htp-title" className="font-display text-lg font-extrabold text-bright">
            How a night works
          </h2>
          <button onClick={onClose} className="px-2 font-mono text-[11px] uppercase tracking-[0.14em] text-mute hover:text-text">
            Close <span aria-hidden>×</span>
          </button>
        </header>
        <div className="min-h-0 overflow-auto">
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
        </div>
      </div>
    </div>
  );
}
