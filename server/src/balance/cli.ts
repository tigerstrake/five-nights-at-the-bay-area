import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, type BalanceConfig, type HqId } from '@fnab/shared';
import { HQS, runBatch, type BatchOptions } from './harness';
import { POLICIES, SKILLS, type DefenderSkill, type MonsterPolicy } from './bots';
import { report, tableRow } from './report';
import { BEFORE_CONFIG } from './before';

export function parseArgs(args: string[]): BatchOptions & { out?: string; configPath?: string } {
  const values = new Map<string, string>();
  const allowed = new Set(['matches', 'hq', 'defenders', 'duration', 'defender-skill', 'monster', 'seed', 'out', 'config', 'preset']);
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !allowed.has(args[i].slice(2)) || !args[i + 1]) throw new Error(`Invalid option: ${args[i]}`);
    values.set(args[i].slice(2), args[i + 1]);
  }
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${key} must be an integer in ${min}..${max}`);
    return value;
  };
  const hq = values.get('hq') ?? 'all';
  const hqs = hq === 'all' ? HQS : hq.split(',').map(h => h.startsWith('hq-') ? h : `hq-${h}`) as HqId[];
  if (hqs.some(h => !HQS.includes(h))) throw new Error('Unknown HQ');
  const defenders = (values.get('defenders') ?? '1,2,3,4').split(',').map(Number);
  if (defenders.some(n => !Number.isInteger(n) || n < 1 || n > 10)) throw new Error('Defenders must be 1..10');
  const skill = (values.get('defender-skill') ?? 'competent') as DefenderSkill;
  const monster = (values.get('monster') ?? 'mixed') as MonsterPolicy | 'mixed';
  if (![...SKILLS, 'lockdown'].includes(skill)) throw new Error('Unknown defender skill');
  if (![...POLICIES, 'hide', 'mixed'].includes(monster)) throw new Error('Unknown monster policy');
  const preset = values.get('preset') ?? 'current';
  if (preset !== 'before' && preset !== 'current') throw new Error('Preset must be before or current');
  return { matches: integer('matches', 400, 1, 1_000_000), hqs, defenders, duration: integer('duration', 480, 300, 600),
    skill, monster, preset, seed: integer('seed', 1, 0, 0xffffffff), out: values.get('out'), configPath: values.get('config') };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = options.configPath ? JSON.parse(readFileSync(options.configPath, 'utf8')) as BalanceConfig : options.preset === 'before' ? BEFORE_CONFIG : DEFAULT_CONFIG;
  console.log('HQ / defenders              N Monster%   Cap  Dawn Breach50  Late%');
  const started = performance.now();
  const matches = runBatch({ ...options, config }, cell => console.log(tableRow(`${cell[0].hq} / ${cell[0].defenders}`, cell)));
  console.log(tableRow('ALL', matches));
  console.log(`Each HQ/count cell has --matches games; policy: ${options.monster === 'mixed' ? POLICIES.join(', ') : options.monster}. ${(performance.now() - started).toFixed(0)} ms.`);
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, JSON.stringify({ schemaVersion: 1, options, config, reports: report(matches), matches }, null, 2) + '\n');
    console.log(`JSON: ${options.out}`);
  }
}

// Importing parseArgs in tests must not start a batch.
if (process.argv[1]?.endsWith('/balance/cli.ts')) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
