import { describe, expect, it } from 'vitest';
import { clearRecovery, pruneRecoveries, readRecoveries, readRecovery, RECOVERY_MAX_SEATS, RECOVERY_TTL_MS, saveRecovery } from '../recovery';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); },
    key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; } };
}
const seat = { code: 'ABCD', playerId: 'p1', token: 'valid-session-token', name: 'Nightwatch' };

describe('cross-tab recovery hints', () => {
  it('persists a normalised room-scoped hint for a fresh tab, with a strict 10-minute TTL', () => {
    const local = storage();
    saveRecovery(local, { ...seat, code: ' abcd ' }, 10_000);
    expect(readRecovery(local, 'abcd', 10_001)).toEqual({ ...seat, savedAt: 10_000 });
    expect(readRecovery(local, 'EFGH', 10_001)).toBeNull();
    expect(readRecovery(local, 'ABCD', 10_000 + RECOVERY_TTL_MS - 1)).not.toBeNull();
    expect(readRecovery(local, 'ABCD', 10_000 + RECOVERY_TTL_MS)).toBeNull();
    expect(local.getItem('fnab.recovery.ABCD')).toBeNull();
  });
  it('does not let a stale tab erase a newer player\'s hint', () => {
    const local = storage();
    saveRecovery(local, seat);
    const newer = { ...seat, token: 'a-different-valid-token', playerId: 'p2' };
    saveRecovery(local, newer);
    clearRecovery(local, seat);
    expect(readRecovery(local, seat.code)).toMatchObject(newer);
    clearRecovery(local, newer);
    expect(readRecovery(local, seat.code)).toBeNull();
  });
  it('keeps one hint per tab in the same room (newest first, bounded) and refreshes a tab in place', () => {
    const local = storage();
    saveRecovery(local, seat, 1_000);
    saveRecovery(local, { ...seat, playerId: 'p2', token: 'second-tab-session-token' }, 2_000);
    saveRecovery(local, seat, 3_000);
    expect(readRecoveries(local, 'ABCD', 3_001).map(s => [s.playerId, s.savedAt])).toEqual([['p1', 3_000], ['p2', 2_000]]);
    for (let i = 0; i < 10; i++) saveRecovery(local, { ...seat, playerId: `x${i}`, token: `extra-session-token-${i}` }, 4_000 + i);
    expect(readRecoveries(local, 'ABCD', 5_000)).toHaveLength(RECOVERY_MAX_SEATS);
    expect(readRecovery(local, 'ABCD', 5_000)?.playerId).toBe('x9');
  });
  it('prunes expired hints of rooms that were never reopened', () => {
    const local = storage();
    saveRecovery(local, seat, 1_000);
    saveRecovery(local, { ...seat, code: 'WXYZ' }, 1_000 + RECOVERY_TTL_MS);
    local.setItem('fnab.recovery.bad', '{');
    local.setItem('fnab.name', 'kept');
    pruneRecoveries(local, 1_000 + RECOVERY_TTL_MS + 1);
    expect(local.getItem('fnab.recovery.ABCD')).toBeNull();
    expect(local.getItem('fnab.recovery.bad')).toBeNull();
    expect(local.getItem('fnab.recovery.WXYZ')).not.toBeNull();
    expect(local.getItem('fnab.name')).toBe('kept');
  });
  it.each([null, {}, { ...seat, savedAt: '1' }, { ...seat, savedAt: Infinity }, { ...seat, savedAt: 20_000 },
    { ...seat, token: 'short', savedAt: 1 }, { ...seat, code: 'EFGH', savedAt: 1 }])('rejects malformed or future records: %j', value => {
    const local = storage();
    local.setItem('fnab.recovery.ABCD', JSON.stringify(value));
    expect(readRecovery(local, 'ABCD', 10_000)).toBeNull();
  });
  it('handles unavailable storage and invalid JSON', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(readRecovery(blocked, seat.code)).toBeNull();
    expect(() => saveRecovery(blocked, seat)).not.toThrow();
    expect(() => clearRecovery(blocked, seat)).not.toThrow();
    const local = storage(); local.setItem('fnab.recovery.ABCD', '{');
    expect(readRecovery(local, 'ABCD')).toBeNull();
  });
});
