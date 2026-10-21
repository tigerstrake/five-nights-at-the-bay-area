// §16/§18: the game stays fully playable when the external camera source is unreachable.
// Runs against the second stack in playwright.config.ts: CAMERA_MODE=auto (real-camera probing enabled) with every
// probe pointed at a refused local port (CAMERA_PROBE_ORIGIN), i.e. "Caltrans is down" without needing real network.
import { expect, test } from '@playwright/test';
import { CAMERAS, CFG } from './helpers/data';
import { chooseSpawn, disposeAll, expectSameResult, runUntilEnd, skipPrep, startMatch } from './helpers/game';

test('camera source outage: probes fail, every feed degrades to labelled SIMULATED and the match still completes', async ({ browser, request }) => {
  // Server side: it tried to probe (auto mode) and every camera ended up simulated, with a human-readable reason.
  const health = await (await request.get('/api/health')).json();
  expect(health.cameraMode).toBe('auto');
  await expect
    .poll(
      async () => {
        const list = (await (await request.get('/api/cameras')).json()) as Array<{ mode: string }>;
        return list.length === CAMERAS.length && list.every((c) => c.mode === 'simulated');
      },
      { timeout: 30_000, message: 'all cameras should be simulated while the source is unreachable' },
    )
    .toBe(true);
  const list = (await (await request.get('/api/cameras')).json()) as Array<{ mode: string; snapshotUrl: string | null; streamUrl: string | null }>;
  for (const c of list) {
    expect(c.snapshotUrl).toBeNull();
    expect(c.streamUrl).toBeNull();
  }
  // Evidence that the service really tried and noticed the outage (not just "never started"): probes ran, the
  // circuit breakers for the unreachable hosts opened, and each camera carries a human-readable reason.
  await expect
    .poll(async () => ((await (await request.get('/api/health')).json()) as { cameras: { checks: number; hosts: Array<{ breakerOpen: boolean }> } }).cameras.hosts.some((h) => h.breakerOpen), {
      timeout: 30_000,
      message: 'the camera service should open its circuit breaker for the unreachable host',
    })
    .toBe(true);
  const detail = (await (await request.get('/api/cameras?detail=1')).json()) as { health: { checks: number; counts: { simulated: number } }; cameras: Array<{ mode: string; reason?: string | null }> };
  expect(detail.health.checks).toBeGreaterThan(0);
  expect(detail.health.counts.simulated).toBe(CAMERAS.length);
  expect(detail.cameras.every((c) => c.mode === 'simulated' && !!c.reason)).toBe(true);

  const m = await startMatch(browser, { hq: 'hq-oakland', defenders: 1, durationSec: CFG.match.minDurationMs / 1000 });
  try {
    const { monster, defenders } = m;
    const def = defenders[0]!;
    await chooseSpawn(m);
    await skipPrep(m);
    const badges = def.page.getByTestId('feed-source-badge');
    await expect(badges.first()).toBeVisible();
    for (const b of await badges.all()) {
      await expect(b).toHaveAttribute('data-source-mode', 'simulated');
      await expect(b).toContainText('SIMULATED');
    }
    expect(await def.page.locator('[data-camera][data-source-mode="live"], [data-camera][data-source-mode="snapshot"]').count()).toBe(0);

    // Gameplay is unaffected by the outage: use camera-dependent features (sabotage + repair) and finish the match.
    const spawn = (await monster.view() as { self: { nodeId: string } }).self.nodeId;
    await monster.passGap();
    const sab = await monster.act({ type: 'sabotage', nodeId: spawn, target: 'camera' });
    expect(sab.ok).toBe(true);
    await def.waitView(`v.cameras.some(c => c.status === 'sabotaged')`);
    const camId = (await def.view() as { cameras: Array<{ cameraId: string; status: string }> }).cameras.find((c) => c.status === 'sabotaged')!.cameraId;
    expect((await def.act({ type: 'repair', cameraId: camId })).ok).toBe(true);
    await def.fastForward(CFG.repair.durationMs + 500);
    await def.waitView(`v.cameras.find(c => c.cameraId === ${JSON.stringify(camId)}).status === 'ok'`);
    expect((await monster.act({ type: 'command', command: 'HIDE' })).ok).toBe(true);
    await runUntilEnd(monster, { chunk: 60_000 });
    const result = await expectSameResult(m);
    expect(result.winner).toBe('defenders');
    for (const p of m.all) expect(p.pageErrors, `${p.name} page errors`).toEqual([]);
  } finally {
    await disposeAll(m);
  }
});
