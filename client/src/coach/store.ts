// First-match coaching preferences, persisted per browser.
//
// Hints are on automatically for a player's first two matches in each role, then off unless they turn them on
// again in Settings. Each hint shows once; turning hints back on clears the "already shown" list. Automated test
// pages (`?e2e`) default to off so coach cards never sit on top of controls a test clicks.
import { useSyncExternalStore } from 'react';

export type CoachRole = 'defender' | 'monster';
export type CoachMode = 'auto' | 'on' | 'off';

export interface CoachPrefs {
  mode: CoachMode;
  /** Finished matches per role (counted on the results screen). */
  matches: Record<CoachRole, number>;
  /** Hint ids already shown. */
  seen: string[];
}

export const COACH_KEY = 'fnab.coach.v1';
/** Matches per role that get hints automatically. */
export const AUTO_MATCHES = 2;

const DEFAULT: CoachPrefs = { mode: 'auto', matches: { defender: 0, monster: 0 }, seen: [] };

function read(): CoachPrefs {
  try {
    const raw = localStorage.getItem(COACH_KEY);
    if (!raw) return { ...DEFAULT, matches: { ...DEFAULT.matches } };
    const p = JSON.parse(raw) as Partial<CoachPrefs>;
    return {
      mode: p.mode === 'on' || p.mode === 'off' ? p.mode : 'auto',
      matches: {
        defender: Number.isFinite(p.matches?.defender) ? p.matches!.defender : 0,
        monster: Number.isFinite(p.matches?.monster) ? p.matches!.monster : 0,
      },
      seen: Array.isArray(p.seen) ? p.seen.filter((x): x is string => typeof x === 'string').slice(-200) : [],
    };
  } catch {
    return { ...DEFAULT, matches: { ...DEFAULT.matches } };
  }
}

let prefs: CoachPrefs = typeof window === 'undefined' ? DEFAULT : read();
const listeners = new Set<() => void>();

function write(next: CoachPrefs) {
  prefs = next;
  try {
    localStorage.setItem(COACH_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: keep the in-memory copy */
  }
  listeners.forEach((l) => l());
}

function isTestPage(): boolean {
  try {
    return new URLSearchParams(location.search).has('e2e');
  } catch {
    return false;
  }
}

/** Pure rule: are hints on for this role, given the stored preferences? */
export function hintsOnFor(p: CoachPrefs, role: CoachRole, testPage = false): boolean {
  if (p.mode === 'on') return true;
  if (p.mode === 'off') return false;
  return !testPage && p.matches[role] < AUTO_MATCHES;
}

export const coach = {
  get: () => prefs,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  enabled: (role: CoachRole) => hintsOnFor(prefs, role, isTestPage()),
  /** Settings / card toggle. Turning hints on again replays every hint. */
  setEnabled(on: boolean) {
    write({ ...prefs, mode: on ? 'on' : 'off', seen: on ? [] : prefs.seen });
  },
  markSeen(id: string) {
    if (prefs.seen.includes(id)) return;
    write({ ...prefs, seen: [...prefs.seen, id] });
  },
  matchFinished(role: CoachRole) {
    write({ ...prefs, matches: { ...prefs.matches, [role]: prefs.matches[role] + 1 } });
  },
};

export function useCoachPrefs(): CoachPrefs {
  return useSyncExternalStore(coach.subscribe, coach.get, coach.get);
}

/** Whether hints are on for a role (re-renders on change). */
export function useHintsOn(role: CoachRole): boolean {
  const p = useCoachPrefs();
  return hintsOnFor(p, role, isTestPage());
}

/** Whether hints are on for at least one role (for the Settings switch). */
export function useAnyHintsOn(): boolean {
  const p = useCoachPrefs();
  const test = isTestPage();
  return hintsOnFor(p, 'defender', test) || hintsOnFor(p, 'monster', test);
}
