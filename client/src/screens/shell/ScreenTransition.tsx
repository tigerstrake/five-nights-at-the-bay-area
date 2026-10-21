// Cuts between top-level screens like a CCTV monitor changing input: the old picture tears into static and
// collapses (SignalLostTransition), then the new screen powers on.
import { useState, type ReactNode } from 'react';
import { SignalLostTransition } from '../../fx';
import { useReduceFlashing } from '../../ui/chrome';

const BURST_MS = 520;

export function ScreenTransition({ screenKey, children, skip }: { screenKey: string; children: ReactNode; skip?: boolean }) {
  const reduced = useReduceFlashing();
  const [last, setLast] = useState(screenKey);
  const [burst, setBurst] = useState<number | null>(null);
  const [delayed, setDelayed] = useState(false);
  // Derive the transition during render so the new screen never paints a frame before the static covers it.
  if (last !== screenKey) {
    setLast(screenKey);
    const on = !skip && !reduced;
    setBurst(on ? Date.now() : null);
    setDelayed(on);
  }
  return (
    <>
      <div
        key={screenKey}
        className="fnab-motion h-full w-full motion-safe:animate-screen-in"
        style={delayed ? { animationDelay: `${BURST_MS - 80}ms` } : undefined}
        data-screen={screenKey}
      >
        {children}
      </div>
      {burst !== null && <SignalLostTransition key={burst} fixed durationMs={BURST_MS} onDone={() => setBurst(null)} />}
    </>
  );
}
