// §18: players join one match from separate browsers (code + invite link), one monster, others defenders,
// defenders select the HQ, ready up, synchronized countdown, spectators.
import { expect, test } from '@playwright/test';
import { CFG, NETWORK } from './helpers/data';
import { createRoom, disposeAll, joinByCode, joinByInvite, newPlayer, openTitle, pickHq, ready, setRole, startMatch } from './helpers/game';

test('players join by code and invite link; roles, HQ choice, ready and synchronized countdown', async ({ browser }) => {
  const monster = await newPlayer(browser, 'Ada');
  const def1 = await newPlayer(browser, 'Bea');
  const def2 = await newPlayer(browser, 'Cyd');
  const spec = await newPlayer(browser, 'Dot');
  const all = [monster, def1, def2, spec];
  try {
    const code = await createRoom(monster);
    await joinByCode(def1, code);
    await joinByInvite(def2, code); // invite link pre-fills the code
    await joinByInvite(spec, code);
    await setRole(spec, 'spectator');

    // Roles: creator is the host + the (only) monster; joiners default to defender.
    for (const p of all) await expect(p.page.getByTestId('player-list').locator('li')).toHaveCount(4);
    const room = await def1.room();
    const byName = (n: string) => room.players.find((p) => p.name === n)!;
    expect(byName('Ada')).toMatchObject({ role: 'monster', isHost: true });
    expect(byName('Bea').role).toBe('defender');
    expect(byName('Cyd').role).toBe('defender');
    await expect(def1.page.getByTestId('role-monster')).toBeDisabled(); // exactly one monster
    await expect(def1.page.getByTestId('role-defender')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await monster.room()).players.find((p) => p.name === 'Dot')?.role).toBe('spectator');

    // A defender chooses the HQ; everybody sees it. Spectators/others cannot start a match by themselves.
    const hq = NETWORK.headquarters.find((h) => h.id === 'hq-oakland')!;
    await pickHq(def2, hq.id);
    for (const p of all) await expect.poll(async () => (await p.room()).settings.hqId).toBe(hq.id);
    await expect(monster.page.getByTestId('blocker')).toContainText('Waiting for');

    await monster.hold(true); // keep the clock still: the assertions below must not race preparation
    await ready(def1);
    await ready(def2);
    await expect(monster.page.getByTestId('player-list')).toContainText('Ready');
    await expect(def1.page.getByTestId('lobby-screen')).toBeVisible(); // not started: the monster is not ready
    await ready(monster);

    // Countdown: every client agrees on the same server end time, and the loading screen shows on all.
    for (const p of all) await expect(p.page.getByTestId('loading-screen')).toBeVisible();
    const ends = await Promise.all(all.map(async (p) => (await p.room()).countdownEndsAt));
    expect(new Set(ends).size).toBe(1);
    expect(ends[0]).toBeGreaterThan(0);
    for (const p of [monster, def1, def2]) await expect(p.page.getByTestId('countdown')).toBeVisible();

    // Match starts for all: monster screen vs. defender screens; the spectator watches read-only.
    await expect(monster.page.getByTestId('monster-screen')).toBeVisible({ timeout: 30_000 });
    for (const p of [def1, def2, spec]) await expect(p.page.getByTestId('defender-screen')).toBeVisible({ timeout: 30_000 });
    await expect(spec.page.getByTestId('spectating-banner')).toBeVisible();
    const views = await Promise.all(all.map((p) => p.view()));
    // one shared match clock: same match time, and every view's epoch mapping agrees with it
    expect(new Set(views.map((v) => v.t)).size).toBe(1);
    for (const v of views) expect(Math.abs(v.serverNow - v.t0Epoch - v.t)).toBeLessThan(500);
    expect(new Set(views.map((v) => v.hqId))).toEqual(new Set([hq.id]));
    expect(views.map((v) => v.role).sort()).toEqual(['defender', 'defender', 'monster', 'spectator']);
    expect(views[0]!.phase).toBe('preparation');
    expect(views[0]!.matchEndsAt).toBeLessThanOrEqual(CFG.match.maxDurationMs + CFG.match.prepMs);
  } finally {
    await disposeAll({ all });
  }
});

test('lobby rejects unknown rooms; late joiners spectate a running match and cannot act', async ({ browser }) => {
  const stranger = await newPlayer(browser, 'Eve');
  await openTitle(stranger);
  await stranger.page.fill('#name', 'Eve');
  await stranger.page.fill('input[aria-label="Room code"]', 'ZZZZ');
  await stranger.page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(stranger.page.getByTestId('toasts')).toContainText(/No room uses the code ZZZZ/);
  await expect(stranger.page.getByTestId('title-screen')).toBeVisible();
  await stranger.dispose();

  const m = await startMatch(browser, { stopAt: 'match' });
  const late = await newPlayer(browser, 'Late');
  try {
    await joinByInvite(late, m.code, { midMatch: true });
    // Joined mid-match → straight into a read-only view of the control room.
    await expect(late.page.getByTestId('defender-screen')).toBeVisible({ timeout: 20_000 });
    await expect(late.page.getByTestId('spectating-banner')).toBeVisible();
    const v = await late.view();
    expect(v.role).toBe('spectator');
    const act = await late.act({ type: 'armTrap', nodeId: NETWORK.nodes[0]!.id });
    expect(act.ok).toBe(false); // spectators cannot act
  } finally {
    await disposeAll({ all: [...m.all, late] });
  }
});
