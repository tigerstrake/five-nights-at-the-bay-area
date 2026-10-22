// Team disconnects (server-side grace period): the other side is told, the simulation pauses, and the match is forfeited
// when nobody from the team returns in time. Returning inside the grace period resumes seamlessly.
// The e2e server runs with a shortened grace (E2E_GRACE_MS) so the forfeit is observable in seconds.
import { expect, test } from '@playwright/test';
import type { DefenderView, MonsterView } from '@fnab/shared';
import { CFG, E2E_GRACE_MS } from './helpers/data';
import { asDefender, chooseSpawn, disposeAll, skipPrep, startMatch, type Player } from './helpers/game';

type Conn = { monsterConnection?: { connected: boolean; reconnectDeadlineEpoch: number | null }; defenderConnection?: { connected: boolean }; pausedForReconnect?: boolean };
const conn = async (p: Player) => (await p.view()) as unknown as Conn & (DefenderView | MonsterView);

test('monster disconnects: defenders are notified and the match pauses, then defenders win by forfeit after the grace period', async ({ browser }) => {
  test.setTimeout(90_000);
  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 1, spectators: 1 });
  try {
    const { monster, defenders, spectators } = m;
    const def = defenders[0]!;
    const spec = spectators[0]!;
    await chooseSpawn(m);
    await skipPrep(m);
    const monsterId = (await monster.room()).youId;
    expect((await conn(def)).monsterConnection?.connected).toBe(true);

    const droppedAt = Date.now();
    await monster.socket('disconnect');
    for (const p of [def, spec]) {
      await p.waitView(`v.monsterConnection && v.monsterConnection.connected === false`);
      const v = await conn(p);
      expect(v.defenderConnection?.connected).toBe(true);
      // A deadline is published (wall clock), roughly `grace` from the drop.
      const deadline = v.monsterConnection!.reconnectDeadlineEpoch!;
      expect(deadline).toBeGreaterThan(Date.now() - 2_000);
      expect(Math.abs(deadline - (droppedAt + E2E_GRACE_MS))).toBeLessThan(6_000);
      expect(v.pausedForReconnect).toBe(true);
    }
    await expect.poll(async () => (await def.room()).players.find((x) => x.id === monsterId)?.connected).toBe(false);
    await expect(def.page.getByTestId('event-log').first()).toContainText(/signal is lost|reconnect/i);

    // The simulation is paused while the entity is away: match time does not advance in real time.
    const t0 = asDefender(await def.view()).t;
    await def.page.waitForTimeout(1_500);
    expect(asDefender(await def.view()).t - t0).toBeLessThan(CFG.tickMs * 3);

    // Nobody returns: defenders (and the spectator) win by forfeit, with the same result everywhere that is connected.
    const everyone = { all: [def, spec] };
    for (const p of everyone.all) await expect(p.page.getByTestId('results-screen')).toBeVisible({ timeout: E2E_GRACE_MS + 15_000 });
    const [a, b] = await Promise.all([def.result(), spec.result()]);
    expect(a).toMatchObject({ winner: 'defenders', reason: 'forfeit' });
    expect(b.winner).toBe(a.winner);
    expect(b.reason).toBe(a.reason);
    expect(b.endedAtT).toBe(a.endedAtT);
    expect(a.timeline.some((e) => /forfeit|reconnect/i.test(e.text))).toBe(true);
  } finally {
    await disposeAll(m);
  }
});

test('monster reconnecting within the grace period resumes the match; the clock restarts and nobody forfeits', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-oakland', defenders: 1 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    await chooseSpawn(m);
    await skipPrep(m);
    const monsterId = (await monster.room()).youId;
    await monster.socket('disconnect');
    await def.waitView(`v.monsterConnection && v.monsterConnection.connected === false`);
    await def.page.waitForTimeout(1_000);
    await monster.socket('connect');
    await def.waitView(`v.monsterConnection && v.monsterConnection.connected === true && !v.pausedForReconnect`);
    await monster.hold(false); // this one asserts that real time flows again after the resume
    await expect(def.page.getByTestId('event-log').first()).toContainText(/restored|reconnect/i);
    expect((await monster.room()).youId).toBe(monsterId);
    await monster.waitView(`v.self.spawned`);

    // Time flows again and the monster is back in control.
    const t0 = asDefender(await def.view()).t;
    await def.waitView(`v.t > ${t0 + 800}`);
    await monster.passGap();
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
    await monster.waitView(`v.self.stance === 'HIDE'`);
    expect((await def.room()).stage).toBe('playing');
    expect(asDefender(await def.view()).ended).toBe(false);
  } finally {
    await disposeAll(m);
  }
});

test('all defenders disconnect: the monster is told, then wins by forfeit when none return in time', async ({ browser }) => {
  test.setTimeout(90_000);
  const m = await startMatch(browser, { hq: 'hq-sanjose', defenders: 2 });
  try {
    const { monster, defenders } = m;
    await chooseSpawn(m);
    await skipPrep(m);
    // One defender dropping is not a team loss: the match keeps running.
    await defenders[0]!.socket('disconnect');
    await monster.waitView(`v.defenderConnection && v.defenderConnection.connectedPlayers === 1`);
    expect((await conn(monster)).pausedForReconnect).toBeFalsy();
    await defenders[1]!.socket('disconnect');
    await monster.waitView(`v.defenderConnection && v.defenderConnection.connected === false`);
    expect((await conn(monster)).pausedForReconnect).toBe(true);
    await expect(monster.page.getByTestId('results-screen')).toBeVisible({ timeout: E2E_GRACE_MS + 15_000 });
    const r = await monster.result();
    expect(r).toMatchObject({ winner: 'monster', reason: 'forfeit' });
  } finally {
    await disposeAll(m);
  }
});
