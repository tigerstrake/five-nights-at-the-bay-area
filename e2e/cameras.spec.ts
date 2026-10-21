// §16/§18: a complete match is playable in simulation mode with no external network (every *.dot.ca.gov request is
// blocked and counted), and every feed is honestly labelled SIMULATED.
import { expect, test } from '@playwright/test';
import { disposeAll, expectSameResult, runUntilEnd, skipPrep, chooseSpawn, startMatch } from './helpers/game';
import { CFG, CAMERAS } from './helpers/data';

test('full match in simulation mode with Caltrans blocked: honest SIMULATED labels, nothing external is touched', async ({ browser, request }) => {
  const health = await (await request.get('/api/health')).json();
  expect(health.cameraMode).toBe('simulation');
  const statuses = (await (await request.get('/api/cameras')).json()) as Array<{ cameraId: string; mode: string; snapshotUrl: string | null; streamUrl: string | null }>;
  expect(statuses.length).toBe(CAMERAS.length);
  for (const s of statuses) {
    expect(s.mode).toBe('simulated');
    expect(s.snapshotUrl).toBeNull(); // never hand out a real URL in simulation mode
    expect(s.streamUrl).toBeNull();
  }

  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 1, durationSec: CFG.match.minDurationMs / 1000, playerOpts: { blockCaltrans: true } });
  const external: string[] = [];
  for (const p of m.all) p.page.on('request', (r) => /dot\.ca\.gov/.test(r.url()) && external.push(r.url()));
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    await chooseSpawn(m);
    await skipPrep(m);

    // Every camera the defender can see is a labelled simulation, in the store and on screen.
    await expect(def.page.getByTestId('feed-source-badge').first()).toBeVisible();
    const badges = def.page.getByTestId('feed-source-badge');
    expect(await badges.count()).toBeGreaterThan(3);
    for (const b of await badges.all()) {
      await expect(b).toHaveAttribute('data-source-mode', 'simulated');
      await expect(b).toContainText('SIMULATED');
    }
    await expect(def.page.getByText(/^LIVE$/)).toHaveCount(0);
    const modes = await def.state((s) => Object.values(s.cameraStatuses).map((c) => c.mode));
    expect(new Set(modes)).toEqual(new Set(['simulated']));
    // The monster UI is also free of any "live" claim.
    await expect(monster.page.getByText(/^LIVE$/)).toHaveCount(0);
    expect(await def.page.locator('[data-camera][data-source-mode="simulated"]').count()).toBeGreaterThan(3);
    expect(await def.page.locator('[data-camera][data-source-mode="live"], [data-camera][data-source-mode="snapshot"]').count()).toBe(0);
    expect(await def.page.locator('video[data-testid="feed-video"]').count()).toBe(0);

    // The game runs start to finish.
    await monster.passGap();
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
    await runUntilEnd(monster, { chunk: 60_000 });
    const result = await expectSameResult(m);
    expect(result.winner).toBe('defenders');
    expect(external, 'simulation mode must not request anything from Caltrans').toEqual([]);
    for (const p of m.all) expect(p.pageErrors, `${p.name} page errors`).toEqual([]);
  } finally {
    await disposeAll(m);
  }
});
