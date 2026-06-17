/**
 * Embedding oweflow in a Node process.
 *
 * The CLI speaks JSON on stdout; in-process you get the same engine returning
 * typed objects (`Order`, `CommitResult`, `WorkflowStatus`) — no subprocess, no
 * parsing. `createEngine` bundles the store + def wiring into one call.
 *
 * Run it:  node examples/embed.ts
 *
 * It drives the bundled `delivery` workflow one step: create an instance, tick
 * for the planner order, green its `plan`, and read the derived status.
 */

import { join } from 'node:path';
import { createEngine } from '../src/index.ts';

// An ephemeral in-memory store; defs loaded from this directory's YAML.
const { engine, store } = createEngine({
  db: ':memory:',
  defsDir: join(import.meta.dirname, 'workflows'),
});

// `proposal` is a seedOwed input, so we provide it up front.
const wf = engine.createInstance('delivery', {
  provide: { proposal: { text: 'add dark mode' } },
});
console.log('created instance:', wf);

// Pull eligible orders. Only `planner` is eligible — it's the one loop whose
// input (`proposal`) is green.
const { orders } = engine.tick(wf);
const order = orders[0];
if (!order) throw new Error('expected a planner order');
console.log(`order: ${order.loop} → owes ${order.owes.map((o) => o.path).join(', ')}`);

// Report the planner's output, then release the lease.
const result = engine.green(wf, order.run, 'plan', { plan: 'do the thing' });
console.log('green →', result.outcome);
engine.close(wf, order.run);

// `status` is a pure read over artifact state — never a lie.
const status = engine.status(wf);
console.log('eligible next:', status.eligible.map((e) => e.loop).join(', ') || '(none)');
console.log('debts:', status.debts.map((d) => `${d.path}:${d.acceptance}`).join(', '));

store.close();
