// Minimal smoke test (wave 3 expands e2e coverage). Two browser contexts: create → join → ready → match starts.
import { expect, test } from '@playwright/test';

test('two players can create, join and start a match', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await a.goto('/');
  await a.fill('#name', 'Alice');
  await a.click('text=Create room');
  const code = (await a.textContent('[data-testid=room-code]'))!.trim();
  expect(code).toMatch(/^[A-Z]{4}$/);
  await b.goto('/');
  await b.fill('#name', 'Bob');
  await b.fill('input[aria-label="Room code"]', code);
  await b.click('button:has-text("Join")');
  await b.waitForSelector('[data-testid=room-code]');
  await a.click('[data-testid=ready]');
  await b.click('[data-testid=ready]');
  await expect(a.locator('[data-testid=monster-screen]')).toBeVisible({ timeout: 20_000 });
  await expect(b.locator('[data-testid=defender-screen]')).toBeVisible({ timeout: 20_000 });
});
