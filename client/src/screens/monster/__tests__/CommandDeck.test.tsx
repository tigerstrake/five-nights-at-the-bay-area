// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type MonsterView } from '@fnab/shared';
import { hqById } from '../../../lib/data';
import { CommandDeck } from '../CommandDeck';
import type { Situation } from '../model';

afterEach(cleanup);
describe('restrained ability cards', () => {
  it.each(['move', 'decoy'] as const)('disables ready DECOY while held, including an already selected %s tool', tool => {
    const onTool = vi.fn();
    const view: MonsterView = {
      role: 'monster', t: 1000, t0Epoch: 0, serverNow: 1000, hqId: 'hq-sf', defenderCount: 1,
      phase: 'infiltration', phaseEndsAt: 100_000, matchEndsAt: 200_000, ended: false, events: [],
      knownDoors: [], spawnOptions: [], cameras: [], knownSensors: [], disturbances: [], scanPulses: [],
      exposures: [], powerLevel: 'high', breach: null, containment: null,
      self: {
        spawned: true, spawnChoice: null, nodeId: null, moving: null, path: [], stance: 'HUNT', targetApproachId: null,
        held: { until: 100_000, contained: false, struggle: 0, struggling: false },
        cooldowns: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 0, RETREAT: 0, SABOTAGE: 0, DECOY: 0 },
      },
    };
    const props = {
      view, sit: { cfg: DEFAULT_CONFIG, sabotageTargets: new Map(), decoyTargets: new Set(['camera']) } as Situation,
      t: 1000, hq: hqById('hq-sf')!, tool, doorPref: null, gapLeft: 0, stamps: {},
      onStance: vi.fn(), onTool, onDoor: vi.fn(),
    };
    const ui = render(<CommandDeck {...props} />);
    const card = ui.getByTestId('ability-DECOY');
    expect(card.getAttribute('aria-disabled')).toBe('true');
    expect(card.getAttribute('title')).toBe('Restrained');
    fireEvent.click(card);
    expect(onTool).not.toHaveBeenCalled();
    ui.rerender(<CommandDeck {...props} view={{ ...view, self: { ...view.self, held: null } }} />);
    expect(card.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(card);
    expect(onTool).toHaveBeenCalledWith(tool === 'decoy' ? 'move' : 'decoy');
  });
});
