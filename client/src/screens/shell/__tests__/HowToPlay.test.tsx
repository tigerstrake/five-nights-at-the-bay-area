// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomView, ViewBase } from '@fnab/shared';
import { HowToPlay } from '../HowToPlay';
import { TopBar } from '../../hud';

vi.mock('../../../audio', () => ({ audio: { play: vi.fn() } }));
vi.mock('../../../ui/chrome', () => ({ ConnectionBadge: () => null, SettingsMenu: () => null }));
vi.mock('../../../net/socket', () => ({ lobby: { restart: vi.fn() }, leaveRoom: vi.fn() }));
vi.mock('../../../state/store', () => ({ matchNow: (view: ViewBase) => view.t, serverNow: () => 0 }));

afterEach(cleanup);

describe('field manual', () => {
  it('keeps the existing basics and lets title-screen readers select strategy for both roles', () => {
    const ui = render(<HowToPlay open onClose={vi.fn()} />);
    expect(ui.getByTestId('how-to-play')).toBeTruthy();
    expect(ui.getByRole('heading', { name: 'Defender' })).toBeTruthy();
    expect(ui.getByRole('heading', { name: 'Monster' })).toBeTruthy();
    fireEvent.click(ui.getByRole('radio', { name: 'Strategy' }));
    const defender = within(ui.getByTestId('strategy-defender'));
    expect(defender.getByText('Play for dawn')).toBeTruthy();
    expect(defender.getByText(/Keep about 30 power/)).toBeTruthy();
    expect(defender.getByText(/only about 11 s while battered/)).toBeTruthy();
    fireEvent.click(ui.getByRole('radio', { name: 'Monster' }));
    const monster = within(ui.getByTestId('strategy-monster'));
    expect(monster.getByText(/breach takes 1.8× as long/)).toBeTruthy();
    expect(monster.getByText(/6 s of trap immunity/)).toBeTruthy();
    expect(monster.getByText(/Spamming adds no progress/)).toBeTruthy();
  });

  it.each(['defender', 'monster'] as const)('opens %s strategy from the HUD and closes without leaving the match', role => {
    const room: RoomView = {
      code: 'BAYN', youId: 'me', stage: 'playing',
      players: [{ id: 'me', name: 'Nightwatch', role, ready: true, connected: true, isHost: false }],
      settings: { durationSec: 480, hqId: 'hq-sf' }, countdownEndsAt: null, serverNow: 0, blocker: null, result: null,
    };
    const view: ViewBase = {
      t: 1000, t0Epoch: 0, serverNow: 1000, phase: 'infiltration', phaseEndsAt: 100_000,
      matchEndsAt: 480_000, hqId: 'hq-sf', defenderCount: 1, events: [], ended: false,
    };
    const ui = render(<TopBar room={room} view={view} accent={role === 'monster' ? 'monster' : 'cyan'} />);
    const trigger = ui.getByRole('button', { name: 'Field manual' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(ui.getByTestId(`strategy-${role}`)).toBeTruthy();
    expect(ui.getByRole('radio', { name: 'Strategy' }).getAttribute('aria-checked')).toBe('true');
    expect(ui.getByRole('radio', { name: role === 'monster' ? 'Monster' : 'Defender' }).getAttribute('aria-checked')).toBe('true');
    expect(ui.getByTestId('top-bar')).toBeTruthy();
    expect(document.activeElement).toBe(ui.getByRole('dialog'));
    fireEvent.keyDown(ui.getByRole('dialog'), { key: 'Escape' });
    expect(ui.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    // Each HUD opening returns to the player's own strategy, even after switching roles in the manual.
    fireEvent.click(trigger);
    fireEvent.click(ui.getByRole('radio', { name: role === 'monster' ? 'Defender' : 'Monster' }));
    fireEvent.click(ui.getByTestId('how-to-play-close'));
    fireEvent.click(trigger);
    expect(ui.getByTestId(`strategy-${role}`)).toBeTruthy();
  });

  it('keeps keyboard focus in the sheet and prevents match hotkeys while reading', () => {
    const ui = render(<HowToPlay open initialSection="strategy" onClose={vi.fn()} />);
    const dialog = ui.getByRole('dialog');
    const close = ui.getByTestId('how-to-play-close');
    const last = ui.getByRole('radio', { name: 'Monster' });
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    const matchHotkey = vi.fn();
    window.addEventListener('keydown', matchHotkey);
    try {
      fireEvent.keyDown(close, { key: 'a' });
      fireEvent.keyDown(close, { key: 'Escape' });
      expect(matchHotkey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', matchHotkey);
    }
  });
});
