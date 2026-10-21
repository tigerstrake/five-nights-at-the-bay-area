// Typed Socket.IO protocol. Owner: Foundation.
import type { ActionResult, AiDifficulty, CameraSourceStatus, GameAction, HqId, MatchResult, PlayerView, Role, RoomView, SoloOptions } from './types';

export interface JoinOk {
  ok: true;
  code: string;
  playerId: string;
  token: string;
}
export interface Fail {
  ok: false;
  error: string;
}
export type JoinResult = JoinOk | Fail;
export type Ack<T = ActionResult> = (res: T) => void;

export interface ClientToServerEvents {
  'room:create': (p: { name: string; token?: string }, ack: Ack<JoinResult>) => void;
  'room:createSolo': (p: { name: string; token?: string } & SoloOptions, ack: Ack<JoinResult>) => void;
  'room:join': (p: { code: string; name: string; token?: string }, ack: Ack<JoinResult>) => void;
  /** Re-attach to a room after a reconnect/refresh using the per-tab token (sessionStorage). */
  'room:resume': (p: { code: string; token: string }, ack: Ack<JoinResult>) => void;
  'room:leave': () => void;
  'lobby:setName': (p: { name: string }, ack?: Ack) => void;
  'lobby:setRole': (p: { role: Role }, ack?: Ack) => void;
  'lobby:setReady': (p: { ready: boolean }, ack?: Ack) => void;
  /** Host only; AI management is restricted to the lobby/countdown. */
  'lobby:addAi': (p: { role: 'monster' | 'defender'; difficulty: AiDifficulty }, ack?: Ack) => void;
  'lobby:removeAi': (p: { playerId: string }, ack?: Ack) => void;
  'lobby:setAiDifficulty': (p: { playerId: string; difficulty: AiDifficulty }, ack?: Ack) => void;
  /** Host only. */
  'lobby:setSettings': (p: { durationSec?: number }, ack?: Ack) => void;
  /** Any defender or the host. */
  'lobby:selectHq': (p: { hqId: HqId }, ack?: Ack) => void;
  'game:action': (p: GameAction, ack?: Ack) => void;
  /** Host only: back to lobby (from results or mid-match). */
  'room:restart': (ack?: Ack) => void;
  'time:ping': (p: { clientSentAt: number }, ack: Ack<{ clientSentAt: number; serverNow: number }>) => void;
}

export interface ServerToClientEvents {
  'room:state': (room: RoomView) => void;
  'game:view': (view: PlayerView) => void;
  'game:result': (result: MatchResult) => void;
  'cameras:status': (statuses: CameraSourceStatus[]) => void;
  'room:kicked': (p: { reason: string }) => void;
}

export const SOCKET_PATH = '/socket.io';
