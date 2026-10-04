import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { def, input, step } from '../test/helpers.ts';

// Run one profile per process so timing and post-check memory snapshots do not
// inherit a previous profile's heap. These snapshots are not peak measurements.
// CHECKER_BFS_MODEL may name a separate checkout's unchanged src/model.ts.
const modelUrl = process.env.CHECKER_BFS_MODEL
  ? pathToFileURL(process.env.CHECKER_BFS_MODEL).href
  : new URL('../src/model.ts', import.meta.url).href;
const { modelCheck } = await import(modelUrl) as typeof import('../src/model.ts');

const workflow = def(
  'checker-bfs-storage-probe',
  [input('question', { seedOwed: false })],
  [
    step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'], maxAttempts: 2, maxSchemaFailures: 5 }),
    step({
      name: 'check',
      consumes: ['gather.source[$i]'],
      produces: ['gather.source[$i].verdict'],
      maxAttempts: 2,
      maxSchemaFailures: 5,
    }),
    step({
      name: 'synth',
      consumes: ['gather.source[*].verdict'],
      produces: ['draft'],
      terminal: true,
      maxAttempts: 2,
      maxSchemaFailures: 5,
    }),
  ],
);

const profiles: Array<readonly [string, number, number]> = [
  ['width1', 1, 50_000],
  ['width2-prefix', 2, 5_000],
  ['width2-400k', 2, 400_000],
];

const selectedName = process.env.CHECKER_BFS_PROFILE ?? 'width2-prefix';
const selected = profiles.find(([name]) => name === selectedName);
if (!selected) throw new Error(`unknown checker BFS profile: ${selectedName}`);
const [name, maxCollectionSize, maxStates] = selected;
const start = process.hrtime.bigint();
const report = modelCheck(workflow, { maxCollectionSize, maxStates, assumeProvided: true });
const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
const memoryAfterCheck = process.memoryUsage();
const json = JSON.stringify(report);
process.stdout.write(JSON.stringify({
  name,
  reportSha256: createHash('sha256').update(json).digest('hex'),
  report,
  elapsedMs,
  heapAfterCheckBytes: memoryAfterCheck.heapUsed,
  rssAfterCheckBytes: memoryAfterCheck.rss,
}) + '\n');
