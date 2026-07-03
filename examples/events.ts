/**
 * Reacting to engine changes without polling.
 *
 * `subscribe` (or `createEngine({ onEvent })`) pushes a typed `EngineEvent` the
 * instant a mutation commits. So an in-process host advances the graph by
 * *reacting* to events instead of polling `tick`/`status` on a timer: each
 * `settled` event reports whether the workflow is `done` and which steps are
 * `eligible` — the no-poll signal.
 *
 * Run it:  node examples/events.ts
 *
 * It wires an event-driven worker over the bundled `delivery` pipeline. One
 * external kick — providing the `proposal` — cascades through plan → build →
 * review → merge entirely via events; there is no polling step anywhere.
 */

import { join } from 'node:path';
import { createEngine } from '../src/index.ts';
import type { EngineEvent } from '../src/index.ts';

// What a real worker would compute for each step's owed output.
const OUTPUTS: Record<string, Record<string, unknown>> = {
  planner: { plan: 'do the thing' },
  builder: { pr: 'https://example.com/pr/1' },
  reviewer: { verdict: 'approved' },
  merger: { merge: 'sha-abc123' },
};

// `onEvent` mirrors every committed change to the console as it happens.
const { engine, store } = createEngine({
  db: ':memory:',
  defsDir: join(import.meta.dirname, 'workflows'),
  onEvent: (e) => log(e),
});

function log(e: EngineEvent): void {
  if (e.type === 'instance') console.log(`instance  ${e.workflow} (${e.def})`);
  else if (e.type === 'commit') console.log(`commit    ${e.action} ${e.path}${e.outcome ? ` → ${e.outcome}` : ''}`);
  else if (e.type === 'closed') console.log(`closed    ${e.run} → ${e.outcome}`);
  else console.log(`  settled done=${e.done} eligible=[${e.eligible.join(', ')}]`);
}

let wf = '';

// The event-driven worker: every `settled` carries the eligible set, so we pull
// and green exactly the work it reports — no `status` poll, no timer. Greening
// an output commits and re-settles synchronously, which re-enters this handler
// for the next step, walking the pipeline to `done`.
engine.subscribe((e) => {
  if (e.type !== 'settled' || e.workflow !== wf) return;
  if (e.done) {
    console.log('\n✓ workflow complete — driven entirely by events, no polling');
    return;
  }
  if (e.eligible.length === 0) return;
  for (const order of engine.tick(wf).orders) {
    const value = OUTPUTS[order.step];
    if (!value) continue;
    engine.green(wf, order.run, order.owes[0]!.path, value);
    engine.close(wf, order.run);
  }
});

// `proposal` is a seedOwed input: at create, nothing is eligible yet.
wf = engine.createInstance('delivery');
// The single external kick. Providing the proposal greens it and fires a
// `settled` with `planner` eligible — and the worker cascades from there.
engine.provideInput(wf, 'proposal', { text: 'add dark mode' });

store.close();
