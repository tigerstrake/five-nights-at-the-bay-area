// Coach marks: one short, dismissable hint at a time, pinned beside the control it is about.
// Rules (what applies right now) live in ./rules; preferences (on/off, already shown) in ./store.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { audio } from '../audio';
import { rootZoom } from '../hooks/useConsoleZoom';
import { coach, useCoachPrefs, useHintsOn, type CoachRole } from './store';
import type { Hint, HintSide } from './rules';

/** Longest a hint stays up unless the player acts on it or dismisses it. */
const SHOW_MS = 16_000;
/** Quiet time between two hints, so they never chain into a wall of text. */
const GAP_MS = 3_000;
/** Grace after the screen mounts (let the screen transition finish). */
const SETTLE_MS = 1_400;
const GAP = 10;
const EDGE = 8;
const CARD_W = 292;

interface Placement {
  left: number;
  top: number;
  side: HintSide;
  arrow: number;
  ring: { left: number; top: number; width: number; height: number };
}

/** Renders `{X}` tokens as key caps. */
export function HintText({ text }: { text: string }) {
  const parts = text.split(/(\{[^}]+\})/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\{[^}]+\}$/.test(p) ? (
          <kbd
            key={i}
            className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center border border-b-2 border-edge-hi bg-ink px-1 align-[1px] font-mono text-[10px] leading-none text-bright"
          >
            {p.slice(1, -1)}
          </kbd>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

/** First selector of a hint's anchor list that is on screen. */
export function findAnchor(root: ParentNode | null | undefined, anchor: string | string[]): Element | null {
  if (!root) return null;
  for (const sel of Array.isArray(anchor) ? anchor : [anchor]) {
    const el = root.querySelector(sel);
    if (el && (el as HTMLElement).offsetParent !== null && inView(el)) return el;
  }
  return null;
}

/** At least part of the element is visible inside every scrolling panel around it (stacked layouts scroll). */
function inView(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    const pr = p.getBoundingClientRect();
    if (r.bottom < pr.top + 24 || r.top > pr.bottom - 24) return false;
  }
  return r.bottom > 0 && r.top < window.innerHeight;
}

const overlaps = (a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }) =>
  a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

function place(root: HTMLElement, anchor: Element, card: HTMLElement, want: HintSide): Placement {
  const z = rootZoom(root) || 1;
  const rr = root.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const ax = (ar.left - rr.left) / z;
  const ay = (ar.top - rr.top) / z;
  const aw = ar.width / z;
  const ah = ar.height / z;
  const W = rr.width / z;
  const H = rr.height / z;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  // Never sit on the top bar / alert strip / phase strip.
  let safeTop = EDGE;
  root.querySelectorAll('[data-coach-safe]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.height > 0) safeTop = Math.max(safeTop, (r.bottom - rr.top) / z + 4);
  });
  const fits: Record<HintSide, boolean> = {
    top: ay - GAP - ch >= safeTop,
    bottom: ay + ah + GAP + ch <= H - EDGE,
    left: ax - GAP - cw >= EDGE,
    right: ax + aw + GAP + cw <= W - EDGE,
  };
  const opposite: Record<HintSide, HintSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const order: HintSide[] =
    want === 'top' || want === 'bottom' ? [want, opposite[want], 'left', 'right'] : [want, opposite[want], 'top', 'bottom'];
  const side = order.find((s) => fits[s]) ?? want;
  let left: number;
  let top: number;
  if (side === 'top' || side === 'bottom') {
    left = ax + aw / 2 - cw / 2;
    top = side === 'top' ? ay - GAP - ch : ay + ah + GAP;
  } else {
    left = side === 'left' ? ax - GAP - cw : ax + aw + GAP;
    // Tall anchors (a whole panel): line up with its top rather than its middle.
    top = ah > ch * 1.4 ? ay + 6 : ay + ah / 2 - ch / 2;
  }
  left = Math.max(EDGE, Math.min(W - cw - EDGE, left));
  // Step clear of controls and moment banners. Recheck after each move: clearing the
  // command row can push a hint into a banner that appears earlier in DOM order.
  if (side === 'top' || side === 'bottom') {
    const blockers = Array.from(root.querySelectorAll('[data-coach-avoid]')).flatMap((el) => {
      if (el === anchor || el.contains(anchor)) return [];
      const r = el.getBoundingClientRect();
      return r.height > 0 ? [{ l: (r.left - rr.left) / z, t: (r.top - rr.top) / z, r: (r.right - rr.left) / z, b: (r.bottom - rr.top) / z }] : [];
    });
    for (let pass = 0; pass < blockers.length; pass++) {
      const b = blockers.find((b) => overlaps({ l: left, t: top - GAP, r: left + cw, b: top + ch + GAP }, b));
      if (!b) break;
      top = side === 'top' ? b.t - GAP - ch : b.b + GAP;
    }
  }
  top = Math.max(safeTop, Math.min(H - ch - EDGE, top));
  const arrow =
    side === 'top' || side === 'bottom'
      ? Math.max(14, Math.min(cw - 14, ax + aw / 2 - left))
      : Math.max(14, Math.min(ch - 14, (ah > ch * 1.4 ? ay + 20 : ay + ah / 2) - top));
  return { left, top, side, arrow, ring: { left: ax - 3, top: ay - 3, width: aw + 6, height: ah + 6 } };
}

export function CoachLayer({
  role,
  hints,
  rootRef,
  paused,
}: {
  role: CoachRole;
  /** Hints that apply right now, highest priority first. */
  hints: Hint[];
  rootRef: RefObject<HTMLElement | null>;
  /** Hold new hints back (e.g. while a phase card or a modal is up). */
  paused?: boolean;
}) {
  const on = useHintsOn(role);
  const prefs = useCoachPrefs();
  const [cur, setCur] = useState<{ hint: Hint; at: number } | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const lastClose = useRef(0);
  const mountedAt = useRef(Date.now());
  const [, tick] = useState(0);

  // Re-evaluate at least twice a second, even if the screen stops re-rendering.
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => tick((x) => x + 1), 500);
    // Stacked (tablet/phone) layouts scroll: follow the anchor.
    const root = rootRef.current;
    const onScroll = () => tick((x) => x + 1);
    root?.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      clearInterval(id);
      root?.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
    };
  }, [on, rootRef]);

  const close = () => {
    lastClose.current = Date.now();
    setCur(null);
    setPos(null);
  };

  // Choose / retire the current hint.
  useEffect(() => {
    const now = Date.now();
    if (!on) {
      if (cur) close();
      return;
    }
    const root = rootRef.current;
    const seen = new Set(prefs.seen);
    if (cur) {
      const live = hints.find((h) => h.id === cur.hint.id);
      if (!live || now - cur.at > SHOW_MS || !findAnchor(root, live.anchor)) return close();
      // An urgent hint (trap sprung, breach…) replaces a routine one at once.
      const idx = hints.indexOf(live);
      const urgent = hints.find((h, i) => i < idx && h.tone === 'alert' && !seen.has(h.id) && findAnchor(root, h.anchor));
      if (urgent && live.tone !== 'alert') {
        coach.markSeen(urgent.id);
        setCur({ hint: urgent, at: now });
        setPos(null);
        audio.play('uiHover', { volume: 0.7 });
        return;
      }
      if (live.title !== cur.hint.title || live.body !== cur.hint.body || String(live.anchor) !== String(cur.hint.anchor))
        setCur({ hint: live, at: cur.at });
      return;
    }
    if (paused || now - mountedAt.current < SETTLE_MS) return;
    const first = hints.find((h) => !seen.has(h.id) && findAnchor(root, h.anchor));
    if (now - lastClose.current < GAP_MS && first?.tone !== 'alert') return;
    const next = hints.find((h) => !seen.has(h.id) && findAnchor(root, h.anchor));
    if (!next) return;
    coach.markSeen(next.id);
    setCur({ hint: next, at: now });
    audio.play('uiHover', { volume: 0.7 });
  });

  // Keep the card beside its anchor (panels resize, scroll and reflow).
  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!cur || !root || !card) return;
    const anchor = findAnchor(root, cur.hint.anchor);
    if (!anchor) return;
    const p = place(root as HTMLElement, anchor, card, cur.hint.side);
    setPos((old) =>
      old &&
      Math.abs(old.left - p.left) < 0.5 &&
      Math.abs(old.top - p.top) < 0.5 &&
      old.side === p.side &&
      Math.abs(old.arrow - p.arrow) < 0.5 &&
      Math.abs(old.ring.top - p.ring.top) < 0.5 &&
      Math.abs(old.ring.left - p.ring.left) < 0.5
        ? old
        : p,
    );
  });

  if (!on || !cur) return null;
  const h = cur.hint;
  const monster = role === 'monster';
  const accent = h.tone === 'alert' ? (monster ? '#ff3a4f' : '#ff5a63') : h.tone === 'warn' ? '#d49a2a' : monster ? '#d8cfbf' : '#3bc6d6';
  const arrowStyle: React.CSSProperties = pos
    ? pos.side === 'top'
      ? { left: pos.arrow - 5, bottom: -6, borderWidth: '0 1px 1px 0' }
      : pos.side === 'bottom'
        ? { left: pos.arrow - 5, top: -6, borderWidth: '1px 0 0 1px' }
        : pos.side === 'left'
          ? { top: pos.arrow - 5, right: -6, borderWidth: '1px 1px 0 0' }
          : { top: pos.arrow - 5, left: -6, borderWidth: '0 0 1px 1px' }
    : {};

  return (
    <>
      {pos && (
        <div
          aria-hidden
          className="fnab-coach-ring fnab-motion pointer-events-none absolute z-[43]"
          style={{ ...pos.ring, borderColor: accent, color: accent }}
        />
      )}
      <div
        ref={cardRef}
        role="status"
        aria-live="polite"
        data-testid="coach-hint"
        data-hint={h.id}
        className={clsx(
          'absolute z-[44] border border-l-2 shadow-[0_14px_40px_rgba(0,0,0,0.65)] motion-safe:animate-rise',
          monster ? 'border-[#4a1d20] bg-[#0d0607]' : 'border-edge-hi bg-[#0b1013]',
        )}
        style={{
          width: `min(${CARD_W}px, calc(100% - ${EDGE * 2}px))`,
          left: pos?.left ?? -9999,
          top: pos?.top ?? 0,
          visibility: pos ? 'visible' : 'hidden',
          borderLeftColor: accent,
        }}
      >
        <span
          aria-hidden
          className={clsx('absolute h-2.5 w-2.5 rotate-45 border-solid', monster ? 'border-[#4a1d20] bg-[#0d0607]' : 'border-edge-hi bg-[#0b1013]')}
          style={arrowStyle}
        />
        <div className="px-3 pb-2 pt-2.5">
          <div className={clsx('text-[13.5px] font-semibold leading-snug', monster ? 'text-[#f3e6d6]' : 'text-bright')}>{h.title}</div>
          <p className={clsx('mt-1 text-[12.5px] leading-[1.5]', monster ? 'text-[#d9cbbb]' : 'text-text')}>
            <HintText text={h.body} />
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                audio.play('uiClick', { volume: 0.5 });
                close();
              }}
              className={clsx(
                'border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.12em] transition-colors',
                monster ? 'border-[#6b2a2e] text-[#f3e6d6] hover:border-[#ff3a4f]' : 'border-cyan/50 text-[#b5f3fa] hover:bg-cyan-dim/60',
              )}
              data-testid="coach-dismiss"
            >
              Got it
            </button>
            <button
              type="button"
              onClick={() => {
                audio.play('uiClick', { volume: 0.4 });
                coach.setEnabled(false);
              }}
              className="text-[11.5px] text-mute underline decoration-edge-hi underline-offset-2 hover:text-text"
              data-testid="coach-off"
            >
              Turn off hints
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
