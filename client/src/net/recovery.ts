/**
 * Cross-tab seat recovery hints (localStorage), never proof of seat ownership: the server still validates the
 * recovery credential and only hands back a seat that is currently disconnected (`room:recover`).
 *
 * The per-tab session stays in sessionStorage, so two tabs remain two players. Each tab additionally keeps a
 * short-lived record of its seat here, keyed by room code, so that a *fresh* tab (closed and reopened, or a new
 * tab on the invite link) can reclaim it within the reconnection grace period. A room key holds a small list so
 * that several tabs of one browser in the same room do not overwrite each other's hints.
 */
export const RECOVERY_TTL_MS = 10 * 60_000;
export const RECOVERY_MAX_SEATS = 6;
const PREFIX = 'fnab.recovery.';
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'key' | 'length'>>;
export interface RecoverySeat { code: string; playerId: string; recoveryToken: string; name: string; savedAt: number; }
export const roomCode = (code: string) => code.trim().toUpperCase();

function valid(s: unknown, code: string, now: number): s is RecoverySeat {
  const r = s as RecoverySeat | null;
  return !!r && typeof r === 'object' && r.code === code && typeof r.playerId === 'string' && !!r.playerId &&
    typeof r.recoveryToken === 'string' && r.recoveryToken.length >= 16 && typeof r.name === 'string' &&
    Number.isFinite(r.savedAt) && now >= r.savedAt && now - r.savedAt < RECOVERY_TTL_MS;
}

function write(storage: StorageLike, code: string, seats: RecoverySeat[]): void {
  try {
    if (seats.length) storage.setItem(PREFIX + code, JSON.stringify(seats));
    else storage.removeItem(PREFIX + code);
  } catch { /* Private mode / quota: the per-tab session still works. */ }
}

/** Valid, unexpired hints for a room, newest first. Expired or malformed entries are pruned on read. */
export function readRecoveries(storage: StorageLike, code: string, now = Date.now()): RecoverySeat[] {
  const c = roomCode(code), key = PREFIX + c;
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const seats = list.filter((s): s is RecoverySeat => valid(s, c, now)).sort((a, b) => b.savedAt - a.savedAt);
    if (seats.length !== list.length) write(storage, c, seats);
    return seats;
  } catch { return []; }
}

/** Newest valid hint for a room (or null). */
export function readRecovery(storage: StorageLike, code: string, now = Date.now()): RecoverySeat | null {
  return readRecoveries(storage, code, now)[0] ?? null;
}

/** Insert or refresh this tab's hint (matched by recovery credential or player id). */
export function saveRecovery(storage: StorageLike, seat: Omit<RecoverySeat, 'savedAt'>, now = Date.now()): void {
  const code = roomCode(seat.code);
  const others = readRecoveries(storage, code, now).filter(s => s.recoveryToken !== seat.recoveryToken && s.playerId !== seat.playerId);
  write(storage, code, [{ ...seat, code, savedAt: now }, ...others].slice(0, RECOVERY_MAX_SEATS));
}

/** Remove only this tab's hint: a stale tab must never delete another tab's newer record. */
export function clearRecovery(storage: StorageLike, seat: { code: string; recoveryToken?: string }, now = Date.now()): void {
  const code = roomCode(seat.code);
  const seats = readRecoveries(storage, code, now);
  const rest = seats.filter(s => s.recoveryToken !== seat.recoveryToken);
  if (rest.length !== seats.length) write(storage, code, rest);
}

/** Drop the hint list of a room that no longer exists (any tab may do this). */
export function clearRoomRecoveries(storage: StorageLike, code: string): void {
  write(storage, roomCode(code), []);
}

/** Housekeeping: remove every expired hint left behind by rooms this browser never reopened. */
export function pruneRecoveries(storage: StorageLike, now = Date.now()): void {
  try {
    if (typeof storage.key !== 'function' || typeof storage.length !== 'number') return;
    const codes: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(PREFIX)) codes.push(key.slice(PREFIX.length));
    }
    for (const code of codes) {
      if (code !== roomCode(code)) { storage.removeItem(PREFIX + code); continue; }
      readRecoveries(storage, code, now);
    }
  } catch { /* Storage unavailable. */ }
}
