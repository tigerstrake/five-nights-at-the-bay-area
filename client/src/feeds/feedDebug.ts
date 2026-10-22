// Tiny ring buffer of feed events (hls.js errors, watchdog actions, new stills) for QA scripts and debugging.
// Exposed as `window.__fnabFeedLog` only in dev builds or with `?e2e`; costs nothing otherwise.

export interface FeedLogEntry {
  t: number;
  cam: string;
  variant: 'main' | 'thumb';
  ev: string;
  detail?: string;
}

const MAX = 2000;
const enabled =
  typeof window !== 'undefined' &&
  (import.meta.env?.DEV || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('e2e')));
const buf: FeedLogEntry[] = [];
if (enabled) (window as unknown as { __fnabFeedLog: FeedLogEntry[] }).__fnabFeedLog = buf;

export function feedLog(cam: string, variant: 'main' | 'thumb', ev: string, detail?: string): void {
  if (!enabled) return;
  buf.push({ t: Date.now(), cam, variant, ev, detail });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}
