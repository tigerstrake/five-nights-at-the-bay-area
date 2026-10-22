// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonsterView, RoomView } from '@fnab/shared';
import { hqById } from '../../../lib/data';
import { sendAction } from '../../../net/socket';
import { audio } from '../../../audio';
import { MonsterScreen } from '../../MonsterScreen';

vi.mock('../../../net/socket', () => ({ sendAction: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../../audio', () => ({ audio: { play: vi.fn() } }));
vi.mock('../../../ui/chrome', () => ({ useReduceFlashing: () => true }));
vi.mock('../../../map/MapPanel', () => ({ MapPanel: () => null }));
vi.mock('../../hud', () => ({ TopBar: () => null, TeamSignalBanner: () => null, hqShortName: () => 'SF' }));
vi.mock('../LensPanel', () => ({ LensPanel: () => null }));
vi.mock('../SidePanels', () => ({ EmergencePanel: () => null, IntentStream: () => null, NightBar: () => null, SituationPanel: () => null }));
vi.mock('../MapOverlays', () => ({ BreachBanner: () => null, Legend: () => null, PositionPlate: () => null, TargetingBar: () => null, TrappedOverlay: () => null }));
vi.mock('../../shell/Moments', () => ({ MonsterMoments: () => null }));
vi.mock('../../../coach/store', () => ({ useHintsOn: () => false, useCoachPrefs: () => ({ seen: [] }) }));
vi.mock('../../../coach/Coach', () => ({ CoachLayer: () => null }));

const hq = hqById('hq-sf')!;
const door = hq.approaches[0]!;
const otherDoor = hq.approaches[1]!;
const view: MonsterView = {
  role: 'monster', t: 100_000, t0Epoch: 0, serverNow: 100_000, hqId: 'hq-sf', defenderCount: 1,
  phase: 'infiltration', phaseEndsAt: 180_000, matchEndsAt: 300_000, ended: false, events: [],
  knownDoors: [], spawnOptions: [], cameras: [], knownSensors: [], disturbances: [], scanPulses: [],
  exposures: [], powerLevel: 'high', breach: { approachId: door.id, progress: 0.4, stalled: false }, containment: null,
  self: {
    spawned: true, spawnChoice: null, nodeId: door.fromNode, moving: null, path: [], stance: 'ATTACK', targetApproachId: door.id,
    held: null, cooldowns: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 120_000, RETREAT: 0, SABOTAGE: 0, DECOY: 0 },
  },
};
// The room chrome is omitted so this test exercises the real command deck and screen handlers.
const room = {} as RoomView;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('monster screen repeated stances', () => {
  it.each([door.id, null])('does not send ATTACK or spend the local command gap for the current door (preference=%s)', async targetApproachId => {
    const ui = render(<MonsterScreen room={room} view={{ ...view, self: { ...view.self, targetApproachId } }} />);
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.click(ui.getByTestId('cmd-ATTACK'));
    fireEvent.click(ui.getByTestId(`target-${door.id}`));
    expect(sendAction).not.toHaveBeenCalled();
    expect(audio.play).not.toHaveBeenCalledWith('commandIssued');
    await act(async () => { fireEvent.keyDown(window, { key: 'f' }); });
    expect(sendAction).toHaveBeenCalledExactlyOnceWith({ type: 'command', command: 'FLANK', approachId: door.id });
  });

  it('sends ATTACK when the player chooses a different door despite the active stance cooldown', async () => {
    const ui = render(<MonsterScreen room={room} view={view} />);
    await act(async () => { fireEvent.click(ui.getByTestId(`target-${otherDoor.id}`)); });
    expect(sendAction).toHaveBeenCalledExactlyOnceWith({ type: 'command', command: 'ATTACK', approachId: otherDoor.id });
  });
});
