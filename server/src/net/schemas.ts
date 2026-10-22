// zod validation for every client → server payload. Never trust the client.
import { z } from 'zod';
import { AI_PLAYER_CONFIG } from '@fnab/shared';

const id = z.string().min(1).max(64);
export const nameSchema = z.string().max(40);
export const tokenSchema = z.string().min(16).max(64);
export const codeSchema = z
  .string()
  .min(3)
  .max(8)
  .regex(/^[A-Za-z]+$/);

export const createSchema = z.object({ name: nameSchema, token: tokenSchema.optional() });
const aiDifficulty = z.enum(['novice', 'competent', 'expert']);
const aiRole = z.enum(['monster', 'defender']);
export const createSoloSchema = createSchema.extend({ role: aiRole, difficulty: aiDifficulty,
  teammates: z.number().int().min(0).max(AI_PLAYER_CONFIG.soloMaxTeammates).optional() });
export const addAiSchema = z.object({ role: aiRole, difficulty: aiDifficulty });
export const removeAiSchema = z.object({ playerId: id });
export const aiDifficultySchema = removeAiSchema.extend({ difficulty: aiDifficulty });
export const joinSchema = z.object({ code: codeSchema, name: nameSchema, token: tokenSchema.optional() });
export const resumeSchema = z.object({ code: codeSchema, token: tokenSchema });
export const recoverSchema = resumeSchema.extend({ playerId: id });
export const setNameSchema = z.object({ name: nameSchema });
export const roleSchema = z.object({ role: z.enum(['monster', 'defender', 'spectator']) });
export const readySchema = z.object({ ready: z.boolean() });
export const settingsSchema = z.object({ durationSec: z.number().int().min(60).max(3600).optional() });
export const hqSchema = z.object({ hqId: z.enum(['hq-stanford', 'hq-sf', 'hq-oakland', 'hq-sanjose']) });
export const pingSchema = z.object({ clientSentAt: z.number().finite() });

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('door'), approachId: id, closed: z.boolean() }),
  z.object({ type: z.literal('placeSensor'), nodeId: id }),
  z.object({ type: z.literal('removeSensor'), sensorId: id }),
  z.object({ type: z.literal('armTrap'), nodeId: id }),
  z.object({ type: z.literal('disarmTrap'), trapId: id }),
  z.object({ type: z.literal('scan'), nodeId: id }),
  z.object({ type: z.literal('repair'), cameraId: id }),
  z.object({ type: z.literal('lure'), nodeId: id }),
  z.object({ type: z.literal('containment'), engage: z.boolean() }),
  z.object({ type: z.literal('command'), command: z.enum(['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT']), approachId: id.optional() }),
  z.object({ type: z.literal('sabotage'), nodeId: id, target: z.enum(['camera', 'sensor']) }),
  z.object({ type: z.literal('decoy'), nodeId: id }),
  z.object({ type: z.literal('chooseSpawn'), nodeId: id }),
]);
