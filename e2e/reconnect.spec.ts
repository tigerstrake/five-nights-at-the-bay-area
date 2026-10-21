// §3: reconnection after a temporary disconnect (tab reload and dropped socket) and restarting without a page reload.
import { expect, test } from '@playwright/test';
import { CFG } from './helpers/data';
import { asDefender, asMonster, chooseSpawn, disposeAll, expectSameResult, ready, runUntilEnd, skipPrep, startMatch } from './helpers/game';

test('a defender reloading mid-match resumes the same seat and state; so does the monster', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 2 });
  try {
    const { monster, defenders } = m;
    const [d1, d2] = defenders as [(typeof defenders)[0], (typeof defenders)[0]];
    const spawn = await chooseSpawn(m);
    expect((await d1.act({ type: 'armTrap', nodeId: spawn })).ok).toBe(true);
    await skipPrep(m);
    await monster.passGap();
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
    await d1.fastForward(20_000);

    const roomBefore = await d1.room();
    const viewBefore = asDefender(await d1.view());
    await d1.page.reload();
    await expect(d1.page.getByTestId('defender-screen')).toBeVisible({ timeout: 20_000 });
    const roomAfter = await d1.room();
    expect(roomAfter.youId).toBe(roomBefore.youId); // same seat, not a new player
    expect(roomAfter.players).toHaveLength(roomBefore.players.length);
    await d1.waitView(`v.t >= ${viewBefore.t}`);
    const viewAfter = asDefender(await d1.view());
    expect(viewAfter.hqId).toBe(viewBefore.hqId);
    expect(viewAfter.t0Epoch).toBe(viewBefore.t0Epoch);
    expect(viewAfter.traps.map((t) => t.id)).toEqual(viewBefore.traps.map((t) => t.id));
    expect(viewAfter.power.value).toBeGreaterThan(0);
    await expect.poll(async () => (await d2.room()).players.every((p) => p.connected)).toBe(true);

    // The monster's tab too: stance and spawn survive.
    const mBefore = asMonster(await monster.view());
    await monster.page.reload();
    await expect(monster.page.getByTestId('monster-screen')).toBeVisible({ timeout: 20_000 });
    await monster.waitView(`v.self.spawned`);
    const mAfter = asMonster(await monster.view());
    expect(mAfter.self.stance).toBe(mBefore.self.stance);
    expect(mAfter.self.cooldowns.HIDE).toBe(mBefore.self.cooldowns.HIDE);
    expect((await monster.room()).players.find((p) => p.role === 'monster')!.connected).toBe(true);

    // Both can still act and the match still resolves for everybody.
    expect((await d1.act({ type: 'scan', nodeId: spawn })).ok).toBe(true);
    await runUntilEnd(monster, { chunk: 60_000 });
    const result = await expectSameResult(m);
    expect(['timer', 'breach', 'capture']).toContain(result.reason);
  } finally {
    await disposeAll(m);
  }
});

test('a dropped socket shows the reconnect banner, the seat is held, and the session resumes by itself', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-oakland', defenders: 1 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    await chooseSpawn(m);
    await skipPrep(m);
    const youId = (await def.room()).youId;
    await def.socket('disconnect');
    await expect(def.page.getByTestId('reconnect-banner')).toBeVisible();
    // The server marks the seat as disconnected (not removed) and everybody else can see that.
    await expect.poll(async () => (await monster.room()).players.find((p) => p.id === youId)?.connected).toBe(false);
    // The seat is held: the room stays in the match, and the simulation pauses while the whole defender team is away
    // (see disconnect.spec.ts for the grace-period/forfeit behaviour).
    expect((await monster.room()).stage).toBe('playing');
    await monster.waitView(`v.pausedForReconnect === true`);

    await def.socket('connect');
    await expect(def.page.getByTestId('reconnect-banner')).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => (await monster.room()).players.find((p) => p.id === youId)?.connected).toBe(true);
    expect((await def.room()).youId).toBe(youId);
    await def.waitView(`v.t >= ${asMonster(await monster.view()).t - 1}`);
    expect((await def.act({ type: 'scan', nodeId: hqNode(asDefender(await def.view())) })).ok).toBe(true);
  } finally {
    await disposeAll(m);
  }
});

function hqNode(v: ReturnType<typeof asDefender>): string {
  return v.cameras[0]!.nodeId;
}

test('after a result the host restarts to the lobby without a page reload and a second match starts', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sanjose', defenders: 1, spectators: 1, durationSec: CFG.match.minDurationMs / 1000 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    await chooseSpawn(m);
    await skipPrep(m);
    await monster.passGap();
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
    await runUntilEnd(monster, { chunk: 60_000 });
    const first = await expectSameResult(m);
    const code = m.code;
    for (const p of m.all) await p.page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 42));

    // Only the host can restart; others are told to wait for them.
    await expect(def.page.getByTestId('waiting-host')).toBeVisible();
    await expect(def.page.getByTestId('play-again')).toHaveCount(0);
    expect((await def.page.evaluate(async () => {
      const mod = await (new Function('p', 'return import(p)') as (p: string) => Promise<{ lobby: { restart: () => Promise<{ ok: boolean }> } }>)('/src/net/socket.ts');
      return mod.lobby.restart();
    })).ok).toBe(false);

    await monster.page.getByTestId('play-again').click();
    for (const p of m.all) await expect(p.page.getByTestId('lobby-screen')).toBeVisible({ timeout: 15_000 });
    for (const p of m.all) expect(await p.page.evaluate(() => (window as unknown as { __marker: number }).__marker)).toBe(42); // no reload
    for (const p of m.all) {
      const room = await p.room();
      expect(room.code).toBe(code);
      expect(room.stage).toBe('lobby');
      expect(room.result).toBeNull();
      expect(room.players.filter((x) => x.role !== 'spectator').every((x) => !x.ready)).toBe(true);
      expect(room.players.find((x) => x.id === room.youId)!.role).toBe(
        p === monster ? 'monster' : p === def ? 'defender' : 'spectator',
      );
      expect(await p.state((s) => s.result)).toBeNull();
    }

    // Second match in the same room.
    await ready(monster);
    await ready(def);
    await expect(monster.page.getByTestId('monster-screen')).toBeVisible({ timeout: 30_000 });
    await expect(def.page.getByTestId('defender-screen')).toBeVisible({ timeout: 30_000 });
    const v = asDefender(await def.view());
    expect(v.phase).toBe('preparation');
    expect(v.t).toBeLessThan(CFG.match.prepMs);
    expect(v.ended).toBe(false);
    expect(v.t0Epoch).toBeGreaterThan(first.endedAtT); // a fresh clock
  } finally {
    await disposeAll(m);
  }
});
