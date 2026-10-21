// Merge raw scratch reports rather than averaging medians or percentages across unequal batches.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MatchMeasurement } from './harness';
import { report, tableRow } from './report';

export function mergeMeasurements(batches: MatchMeasurement[][]): MatchMeasurement[] {
  const seen = new Set<string>();
  return batches.flat().map(m => {
    const key = `${m.hq}/${m.defenders}/${m.skill}/${m.monster}/${m.seed}`;
    if (seen.has(key)) throw new Error(`Duplicate trial: ${key}`);
    seen.add(key);
    return m;
  });
}

if (process.argv[1]?.endsWith('/balance/aggregate.ts')) {
  try {
    const args = process.argv.slice(2), outAt = args.indexOf('--out');
    const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
    if (!args.length) throw new Error('Pass one or more balance JSON paths, optionally --out /tmp/merged.json');
    const inputs = args.map(path => JSON.parse(readFileSync(path, 'utf8')));
    if (inputs.some(input => JSON.stringify(input.config) !== JSON.stringify(inputs[0].config))) throw new Error('Cannot merge different configurations');
    const matches = mergeMeasurements(inputs.map(input => input.matches as MatchMeasurement[]));
    const reports = report(matches);
    console.log('HQ / defenders              N Monster%   Cap  Dawn Breach50  Late%');
    for (const key of Object.keys(reports.cells)) console.log(tableRow(key, matches.filter(m => `${m.hq}/${m.defenders}/${m.skill}` === key)));
    console.log(tableRow('ALL', matches));
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ schemaVersion: 1, inputs: args, options: inputs.map(i => i.options), config: inputs[0].config, reports, matches }, null, 2) + '\n');
    }
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
