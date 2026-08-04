/**
 * Embedding owenloop in a Node process.
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
const { engine, store, resolver } = createEngine({
  db: ':memory:',
  defsDir: join(import.meta.dirname, 'workflows'),
});

// `proposal` is a seedOwed input, so we provide it up front.
const wf = engine.createInstance('delivery', {
  provide: { proposal: { text: 'add dark mode' } },
});
console.log('created instance:', wf);

// Pull eligible orders. Only `planner` is eligible — it's the one step whose
// input (`proposal`) is green. Orders are REFERENCE packets: they carry a
// defDigest and routing/dynamic fields, never the authored prompt text.
const { orders } = engine.tick(wf);
const order = orders[0];
if (!order) throw new Error('expected a planner order');
console.log(`order: ${order.step} (defDigest ${order.defDigest.slice(0, 12)}…) → owes ${order.owes.map((o) => o.path).join(', ')}`);

// Resolve the reference into exact authored instructions BEFORE dispatching —
// the same boundary local and remote orders use; an unknown digest raises
// UnknownDefDigestError here, before anything executes.
const instructions = resolver.resolveOrder(order);
console.log('resolved prompt:', JSON.stringify(instructions.prompt));

// Report the planner's output (keyed by order.workflow/run/output path),
// then release the lease.
const result = engine.green(order.workflow, order.run, order.outputs[0]!, { plan: 'do the thing' });
console.log('green →', result.outcome);
engine.close(order.workflow, order.run);

// `status` is a pure read over artifact state — never a lie.
const status = engine.status(wf);
console.log('eligible next:', status.eligible.map((e) => e.step).join(', ') || '(none)');
console.log('debts:', status.debts.map((d) => `${d.path}:${d.acceptance}`).join(', '));

store.close();
