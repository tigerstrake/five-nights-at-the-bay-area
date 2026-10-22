import { writeFile } from 'node:fs/promises';
import { runLoad } from './harness';

const args = process.argv.slice(2);
const arg = (key: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? undefined : args[i + 1]; };
const sizes = (arg('rooms') ?? '10,25,50,100').split(',').map(Number);
const results = [];
for (const rooms of sizes) {
  const result = await runLoad({ rooms, minutes: Number(arg('minutes') ?? 10),
    ...(args.includes('--full-views') ? { fullViews: true } : {}),
    ...(arg('defenders') === undefined ? {} : { defenders: Number(arg('defenders')) }) });
  results.push(result);
  console.log(JSON.stringify(result));
}
if (arg('output')) await writeFile(arg('output')!, JSON.stringify(results, null, 2) + '\n');
