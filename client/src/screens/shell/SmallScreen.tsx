// Phones: the consoles are dense multi-panel layouts. Say so plainly, and point at what works well on a phone.
import { useState } from 'react';
import clsx from 'clsx';

const KEY = 'fnab.smallScreenNotice';

export function SmallScreenNotice({ className, action }: { className?: string; action?: React.ReactNode }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <div
      className={clsx('flex items-start gap-3 border border-warn/50 bg-[#1a1407]/90 px-3 py-2.5 backdrop-blur', className)}
      role="note"
      data-testid="small-screen-notice"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d49a2a" strokeWidth="1.6" aria-hidden className="mt-0.5 shrink-0">
        <rect x="2.5" y="4" width="13" height="10" />
        <rect x="17.5" y="8" width="4" height="9" />
        <path d="M6 18h6M9 14v4" />
      </svg>
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
        <div className="text-[#f3d28d]">Best on a tablet or computer</div>
        <div className="mt-0.5 text-mute">On a phone you can still join a room and watch the night as a spectator.</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
      <button
        type="button"
        className="-mr-1 -mt-0.5 px-1 text-[16px] leading-none text-dim hover:text-text"
        aria-label="Dismiss"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(KEY, '1');
          } catch {
            /* ignore */
          }
        }}
      >
        ×
      </button>
    </div>
  );
}
