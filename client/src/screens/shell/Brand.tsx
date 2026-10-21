// The title treatment: an overhead freeway guide sign, set in Overpass (Highway Gothic's open-source heir),
// left out in the dark too long. `BrandMark` is the compact header version.
import clsx from 'clsx';
import { useReduceFlashing } from '../../ui/chrome';

function Shield({ n }: { n: string }) {
  // Interstate-style shield silhouette (generic shape, no logos).
  return (
    <svg viewBox="0 0 40 42" className="h-[30px] w-[29px] shrink-0" aria-hidden>
      <path d="M3 4 Q20 -1 37 4 Q40 22 20 40 Q0 22 3 4Z" fill="#1d2a45" stroke="#cfd4d8" strokeWidth="2" />
      <path d="M4.5 10.5 H35.5" stroke="#cfd4d8" strokeWidth="1.2" />
      <path d="M5 5.2 Q20 1.2 35 5.2 L35.3 10 H4.7Z" fill="#7a1b22" />
      <text x="20" y="28.5" textAnchor="middle" fontFamily="Overpass, sans-serif" fontWeight="800" fontSize={n.length > 2 ? 11.5 : 14} fill="#e9ecee">
        {n}
      </text>
    </svg>
  );
}

export function TitleSign({ className }: { className?: string }) {
  const reduced = useReduceFlashing();
  return (
    <div className={clsx('relative w-fit select-none', className)}>
      {/* gantry posts */}
      <div aria-hidden className="absolute bottom-full left-[16%] h-[30vh] w-2 bg-gradient-to-b from-transparent via-[#15191c] to-[#2b3135]" />
      <div aria-hidden className="absolute bottom-full right-[16%] h-[30vh] w-2 bg-gradient-to-b from-transparent via-[#15191c] to-[#2b3135]" />
      <div
        className={clsx(
          'relative overflow-hidden rounded-[10px] bg-sign px-7 pb-6 pt-5 shadow-[0_30px_80px_rgba(0,0,0,0.75),inset_0_0_60px_rgba(0,0,0,0.55)]',
          !reduced && 'fnab-motion motion-safe:animate-flicker',
        )}
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 30% 130%, rgba(127,240,208,0.12) 0%, transparent 55%), radial-gradient(ellipse at 85% 120%, rgba(179,32,47,0.28) 0%, transparent 50%), linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.1) 45%, rgba(0,0,0,0.35) 100%), linear-gradient(90deg, rgba(0,0,0,0.5), transparent 45%, rgba(0,0,0,0.4))',
        }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-[6px] rounded-[6px] border-[2.5px] border-[#d9ddd8]/70" />
        <div aria-hidden className="fnab-noise pointer-events-none absolute inset-0 opacity-[0.14] mix-blend-overlay" />
        {/* rust streaks */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              'linear-gradient(180deg, transparent 0 62%, rgba(90,40,20,0.5) 100%), repeating-linear-gradient(90deg, transparent 0 37px, rgba(60,25,10,0.35) 37px 39px, transparent 39px 91px)',
            maskImage: 'linear-gradient(180deg, transparent 55%, black)',
          }}
        />
        <div className="relative flex items-center gap-1.5">
          <Shield n="80" />
          <Shield n="101" />
          <Shield n="880" />
          <span className="ml-2 font-display text-[13px] font-bold tracking-[0.06em] text-[#d9ddd8]/80">NIGHT ONLY</span>
        </div>
        <h1 className="relative mt-3 font-display text-[clamp(36px,min(5.4vw,8.4vh),76px)] font-extrabold leading-[0.95] tracking-[-0.01em] text-[#e4e7e1] [text-shadow:0_0_14px_rgba(228,231,225,0.14)]">
          Five Nights
          <br />
          at the Bay Area
        </h1>
      </div>
      {/* exit-only style plaque below the sign */}
      <div className="relative -mt-px ml-auto mr-6 w-fit rounded-b-[6px] bg-[#ad8b22] px-4 pb-1 pt-1.5 font-display text-[13px] font-extrabold tracking-[0.08em] text-[#141106] shadow-[0_10px_30px_rgba(0,0,0,0.6)]">
        DUSK TO DAWN
      </div>
    </div>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <span className="relative flex h-6 items-center rounded-[4px] bg-sign px-2 ring-1 ring-inset ring-[#d9ddd8]/60">
        <span className="font-display text-[12px] font-extrabold leading-none tracking-[0.02em] text-[#eef0ec]">FNaBA</span>
      </span>
      <span className="hidden font-display text-[14px] font-bold text-text sm:inline">Five Nights at the Bay Area</span>
    </div>
  );
}
