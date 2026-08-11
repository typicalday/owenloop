import { createDefaultSpawner } from '../../src/shift/spawn.ts';

const workerScript = process.argv[2];
if (workerScript === undefined) throw new Error('missing detached worker script');

const spawner = createDefaultSpawner('https://hub.example', 'default', workerScript, 'shf_parent_exit');
spawner({ workflow: 'wf1', run: 'run_exec', step: 'cmd' });
spawner({ workflow: 'wf1', run: 'run_agent', step: 'builder', kind: 'agent-run', harness: 'fake' });
