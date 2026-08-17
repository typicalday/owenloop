/**
 * A2 — capability claim filter tests.
 *
 * A tick caller may pass an optional `capabilities` filter; a step may declare
 * its own `capabilities`. A firing is claimable iff the caller passes NO filter
 * at all, OR the step declares no capabilities, OR the two match. Disjoint →
 * the firing is deferred as `'capability-mismatch'` and left for a matching
 * caller. The deep tick threads the same filter into `calls:` children.
 *
 * Note the distinction an empty array now carries: omitting `capabilities`
 * means "no filter presented" (a local operator — claim everything), while
 * passing `[]` means a crew that serves nothing, which matches only
 * capability-silent steps. Matching itself lives in `capabilities.ts`; these
 * tests drive it through the engine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { StepDef, WorkflowDef } from '../src/types.ts';
import {
  applyCapabilityRewrites,
  capabilityName,
  claimMatches,
  composeCapabilities,
} from '../src/capabilities.ts';
import { def, input, step } from './helpers.ts';

function makeEngine(defs: WorkflowDef[]): { engine: Engine; store: Store } {
  const store = openStore(':memory:');
  const byName = new Map(defs.map((d) => [d.name, d]));
  const engine = new Engine(store, (name) => {
    const d = byName.get(name);
    if (!d) throw new Error(`no def: ${name}`);
    return d;
  });
  return { engine, store };
}

// A def with a capability-routed step, a differently-capability-routed step, and an without capabilities one —
// all three eligible off the same seeded input.
const mixedDef = def(
  'mixed',
  [input('proposal')],
  [
    step({ name: 'alpha', consumes: ['proposal'], produces: ['a'], capabilities: ['x'] }),
    step({ name: 'beta', consumes: ['proposal'], produces: ['b'], capabilities: ['y'] }),
    step({ name: 'gamma', consumes: ['proposal'], produces: ['c'] }),
  ],
);

// ---- Test 1: no filter claims everything (byte-for-byte today's behavior) ----

test('capabilities: no caller filter claims every eligible firing, labeled or not', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0 });
  const steps = t.orders.map((o) => o.step).sort();
  assert.deepEqual(steps, ['alpha', 'beta', 'gamma'], 'no filter = claim all');
  assert.equal(t.deferred.filter((d) => d.reason === 'capability-mismatch').length, 0);
});

// ---- Test 2: filter claims intersecting + without capabilities, defers disjoint ----------

test('capabilities: filter claims matching + uncapability-routed steps, defers the disjoint one', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0, capabilities: ['x'] });
  const claimed = t.orders.map((o) => o.step).sort();
  // alpha (capabilities ['x'] intersect) + gamma (no capabilities = universal); beta deferred.
  assert.deepEqual(claimed, ['alpha', 'gamma']);

  const mismatches = t.deferred.filter((d) => d.reason === 'capability-mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.step, 'beta');
});

// ---- Test 3: any-overlap intersection claims (["a","b"] vs ["b","c"]) ---------

test('capabilities: partial overlap between filter and step capabilities claims', () => {
  const overlapDef = def(
    'overlap',
    [input('proposal')],
    [step({ name: 'runner', consumes: ['proposal'], produces: ['out'], capabilities: ['b', 'c'] })],
  );
  const { engine } = makeEngine([overlapDef]);
  const wf = engine.createInstance('overlap');

  const t = engine.tick(wf, { now: 0, capabilities: ['a', 'b'] });
  assert.equal(t.orders.length, 1);
  assert.equal(t.orders[0]!.step, 'runner');
});

// ---- Test 4: a disjoint firing is deferred, then claimed by a matching caller -

test('capabilities: disjoint firing defers, then a matching caller claims it', () => {
  const soloDef = def(
    'solo',
    [input('proposal')],
    [step({ name: 'beta', consumes: ['proposal'], produces: ['b'], capabilities: ['y'] })],
  );
  const { engine } = makeEngine([soloDef]);
  const wf = engine.createInstance('solo');

  // A caller/Shift serving only 'x' must not claim the 'y' step.
  const t1 = engine.tick(wf, { now: 0, capabilities: ['x'] });
  assert.equal(t1.orders.length, 0, 'disjoint caller claims nothing');
  const mismatch = t1.deferred.find((d) => d.reason === 'capability-mismatch');
  assert.ok(mismatch, 'the firing is reported as capability-mismatch, not silently dropped');
  assert.equal(mismatch!.step, 'beta');

  // A caller/Shift serving 'y' claims the same firing on a later tick.
  const t2 = engine.tick(wf, { now: 1, capabilities: ['y'] });
  assert.equal(t2.orders.length, 1);
  assert.equal(t2.orders[0]!.step, 'beta');
});

// ---- Test 5: an empty caller list matches ONLY capability-silent steps --------

test('capabilities: an empty caller list claims only capability-silent steps', () => {
  // The A2 caller-side close. Presenting `[]` is a crew that serves nothing —
  // previously it bypassed the filter entirely and could claim every step,
  // including compounds its shift cannot resolve, at one claim/release cycle
  // each. It now matches only steps that authored no capabilities.
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0, capabilities: [] });
  assert.deepEqual(t.orders.map((o) => o.step), ['gamma'], 'only the capability-silent step');
  assert.deepEqual(
    t.deferred.filter((d) => d.reason === 'capability-mismatch').map((d) => d.step).sort(),
    ['alpha', 'beta'],
  );
});

test('capabilities: omitting the filter is NOT the same as passing an empty list', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  // No key at all — a local operator ticking their own instance.
  const t = engine.tick(wf, { now: 0 });
  assert.equal(t.orders.length, 3, 'an absent filter still claims everything');
});

// ---- Test 6: deep tick threads the filter into a calls: child ----------------

// A labeled child step, and a parent that calls it with an empty gate (spawns on
// the first tick). The parent's own calls: step never emits a worker order.
const childLabeledDef: WorkflowDef = {
  ...def(
    'childLabeled',
    [],
    [step({ name: 'runner', produces: ['outcome'], capabilities: ['claude'] })],
  ),
  outputs: ['outcome'],
};

const parentCallsDef: WorkflowDef = def(
  'parentCalls',
  [],
  [
    {
      ...step({ name: 'deliver', produces: ['delivered'] }),
      calls: 'childLabeled',
      callsInputs: {},
      consumes: [],
    } as StepDef,
  ],
);

test('capabilities: deep tick threads the filter into a calls: child — no cross-claim', () => {
  const { engine, store } = makeEngine([childLabeledDef, parentCallsDef]);
  const parentWf = engine.createInstance('parentCalls');

  // A Shift serving only 'codex' ticks deep. The child spawns (machine-
  // handled, filter-independent) but its 'claude' runner must NOT be claimed.
  const t1 = engine.tick(parentWf, { now: 0, capabilities: ['codex'] });
  const child = store.findChildByParent(parentWf, 'delivered');
  assert.ok(child, 'child instance is spawned regardless of the capability filter');
  assert.ok(t1.orders.every((o) => o.step !== 'runner'), 'mismatched Shift does not cross-claim the child runner');
  const childMismatch = t1.deferred.find((d) => d.reason === 'capability-mismatch' && d.step === 'runner');
  assert.ok(childMismatch, 'the child runner is reported deferred');
  assert.equal(childMismatch!.workflow, child!.id, 'the deferral is stamped with the child workflow id');

  // A Shift serving 'claude' claims the child runner on a later deep tick.
  const t2 = engine.tick(parentWf, { now: 1, capabilities: ['claude'] });
  const runnerOrder = t2.orders.find((o) => o.step === 'runner');
  assert.ok(runnerOrder, 'matching Shift claims the child runner');
  assert.equal(runnerOrder!.workflow, child!.id);
});

// ---- composition: authored capabilities + the run's modifier ----------------
//
// `composeCapabilities` and `claimMatches` are pure and tested directly here;
// the engine tests below prove the same rules through a real tick, which is the
// only path that can prove the ORDER carries what the filter matched against.

test('composeCapabilities suffixes every authored capability with the modifier', () => {
  assert.deepEqual(composeCapabilities(['wise', 'build'], 'deep'), ['wise:deep', 'build:deep']);
});

test('composeCapabilities returns the authored list unchanged for an unmodified run', () => {
  // Not a copy-by-reference detail: an unmodified run must offer exactly what
  // the def authored, byte for byte, so every pre-modifier binding still matches.
  assert.deepEqual(composeCapabilities(['wise'], undefined), ['wise']);
});

test('composeCapabilities leaves a capability-silent step silent, modifier or not', () => {
  // A lone ':deep' would be a capability no crew could ever bind meaningfully.
  assert.deepEqual(composeCapabilities([], 'deep'), []);
  assert.deepEqual(composeCapabilities(undefined, 'deep'), []);
});

test('capabilityName splits on the FIRST separator', () => {
  assert.equal(capabilityName('wise'), 'wise');
  assert.equal(capabilityName('wise:deep'), 'wise');
  // An authored name can never contain the separator, so a second colon is part
  // of the modifier, never a second name boundary.
  assert.equal(capabilityName('wise:deep:extra'), 'wise');
});

test('claimMatches: exact mode rejects a crew bound to the name part only', () => {
  // Scenario A. A crew is bound to `wise:deep`, so the order belongs to crews
  // that opted into that slice; a bare-`wise` crew must not take it.
  assert.equal(claimMatches(['wise:deep'], ['wise'], { 'wise:deep': 'exact' }), false);
  assert.equal(claimMatches(['wise:deep'], ['wise:deep'], { 'wise:deep': 'exact' }), true);
});

test('claimMatches: name mode accepts any crew sharing the name part', () => {
  // Scenario B. No binding exists for the compound, so the modifier is ignored
  // on both sides.
  const modes = { 'wise:deep': 'name' } as const;
  assert.equal(claimMatches(['wise:deep'], ['wise'], modes), true);
  assert.equal(claimMatches(['wise:deep'], ['wise:standard'], modes), true);
  assert.equal(claimMatches(['wise:deep'], ['build:deep'], modes), false, 'a different name part never matches');
});

test('claimMatches: an unlisted capability defaults to name mode', () => {
  assert.equal(claimMatches(['wise:deep'], ['wise']), true);
});

test('claimMatches: the mode is looked up per offered capability', () => {
  // A two-capability step whose compounds have different bindings: `build:deep`
  // is exactly bound, `wise:deep` is not. A bare-`wise` crew still claims via
  // the name-mode capability; a bare-`build` crew does not.
  const modes = { 'build:deep': 'exact', 'wise:deep': 'name' } as const;
  assert.equal(claimMatches(['build:deep', 'wise:deep'], ['wise'], modes), true);
  assert.equal(claimMatches(['build:deep'], ['build'], modes), false);
});

// ---- the engine composes at offer time, and matches on what it composed -----

const gradedDef = (): WorkflowDef => ({
  ...def(
    'graded',
    [input('proposal')],
    [step({ name: 'builder', consumes: ['proposal'], produces: ['pr'], capabilities: ['build', 'wise'] })],
    ['express', 'deep'],
  ),
});

test('an order carries the composed capabilities and the run modifier', () => {
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  const t = engine.tick(wf, { now: 0, capabilities: ['build:deep'] });
  assert.equal(t.orders.length, 1);
  assert.deepEqual(t.orders[0]!.capabilities, ['build:deep', 'wise:deep']);
  assert.equal(t.orders[0]!.modifier, 'deep');
});

test('an unmodified run offers the authored capabilities and stamps no modifier', () => {
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded');

  const t = engine.tick(wf, { now: 0, capabilities: ['build'] });
  assert.equal(t.orders.length, 1);
  assert.deepEqual(t.orders[0]!.capabilities, ['build', 'wise']);
  assert.equal(t.orders[0]!.modifier, undefined);
});

test('a modified run stamps the modifier on a capability-silent step, with no capabilities', () => {
  // The two order fields are independent: the brief surfaces the run's grade of
  // service even where the step itself expresses no routing preference.
  const silent = def(
    'silentGraded',
    [input('proposal')],
    [step({ name: 'runner', consumes: ['proposal'], produces: ['out'] })],
    ['deep'],
  );
  const { engine } = makeEngine([silent]);
  const wf = engine.createInstance('silentGraded', { modifier: 'deep' });

  const t = engine.tick(wf, { now: 0 });
  assert.equal(t.orders.length, 1);
  assert.equal(t.orders[0]!.capabilities, undefined, 'nothing to compose onto');
  assert.equal(t.orders[0]!.modifier, 'deep');
});

test('a crew bound to the bare capability is refused an exactly-bound compound', () => {
  // Scenario A end to end: the hub stamps `exact` for `build:deep`, so the
  // bare-`build` crew is deferred rather than claiming a compound its shift may
  // not resolve the same way.
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  const t = engine.tick(wf, {
    now: 0,
    capabilities: ['build'],
    matchModes: { 'build:deep': 'exact', 'wise:deep': 'exact' },
  });
  assert.equal(t.orders.length, 0);
  assert.equal(t.deferred.filter((d) => d.reason === 'capability-mismatch').length, 1);

  // The exactly-bound crew claims the same firing.
  const t2 = engine.tick(wf, {
    now: 1,
    capabilities: ['wise:deep'],
    matchModes: { 'build:deep': 'exact', 'wise:deep': 'exact' },
  });
  assert.equal(t2.orders.length, 1);
  assert.deepEqual(t2.orders[0]!.capabilities, ['build:deep', 'wise:deep']);
});

test('with no binding for the compound, a bare-capability crew claims it (name-match)', () => {
  // Scenario B: no mode stamped at all, so the default (name) applies.
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  const t = engine.tick(wf, { now: 0, capabilities: ['build'] });
  assert.equal(t.orders.length, 1);
  assert.deepEqual(t.orders[0]!.capabilities, ['build:deep', 'wise:deep'], 'the offer is still the compound');
});

test('a claimed order is never recomposed — the stamped offer is the record', () => {
  // The order persisted with the run is the routing snapshot the shift resolved
  // against. Republishing or re-ticking must not rewrite it.
  const { engine, store } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  const order = engine.tick(wf, { now: 0, capabilities: ['build:deep'] }).orders[0]!;
  const stored = store.getRun(order.run)?.order;
  assert.deepEqual(stored?.capabilities, ['build:deep', 'wise:deep']);
  assert.equal(stored?.modifier, 'deep');

  // A second tick finds the claim in flight and issues nothing new.
  const t2 = engine.tick(wf, { now: 1, capabilities: ['build:deep'] });
  assert.equal(t2.orders.length, 0);
  assert.ok(t2.deferred.some((d) => d.reason === 'in-flight'));
});

test('crew stamps are copied onto the offered order and absent without caller input', () => {
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  const stamped = engine.tick(wf, {
    now: 0,
    capabilities: ['build:deep'],
    crewStamps: { 'build:deep': ['openai'] },
  }).orders[0]!;
  assert.deepEqual(stamped.crews, ['openai']);

  const { engine: unstampedEngine } = makeEngine([gradedDef()]);
  const unstampedWf = unstampedEngine.createInstance('graded', { modifier: 'deep' });
  const unstamped = unstampedEngine.tick(unstampedWf, { now: 0, capabilities: ['build:deep'] }).orders[0]!;
  assert.equal(unstamped.crews, undefined);
});

test('crew stamps union each offered capability in offer order without duplicates', () => {
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });
  const order = engine.tick(wf, {
    now: 0,
    capabilities: ['build:deep'],
    crewStamps: {
      'build:deep': ['openai', 'shared'],
      'wise:deep': ['shared', 'anthropic'],
    },
  }).orders[0]!;

  assert.deepEqual(order.capabilities, ['build:deep', 'wise:deep']);
  assert.deepEqual(order.crews, ['openai', 'shared', 'anthropic']);
});

// ---- capability rewrites: the caller reroutes, the engine substitutes -------

test('applyCapabilityRewrites: no matching rule leaves the offer untouched', () => {
  const r = applyCapabilityRewrites(['build:express'], { 'wise:express': 'wise:standard' });
  assert.deepEqual(r.offered, ['build:express']);
  assert.equal(r.reroutedFrom, undefined, 'absent when nothing changed');
});

test('applyCapabilityRewrites: a rule substitutes and records what it replaced', () => {
  const r = applyCapabilityRewrites(['build:express', 'wise:express'], {
    'build:express': 'build:standard',
  });
  assert.deepEqual(r.offered, ['build:standard', 'wise:express']);
  assert.deepEqual(r.reroutedFrom, ['build:express', 'wise:express'], 'the whole original offer');
});

test('applyCapabilityRewrites: a rewrite is a single hop, never chased', () => {
  // `b` also has a rule, but a target is never itself looked up: the caller is
  // responsible for resolving a chain before handing the map over.
  const r = applyCapabilityRewrites(['a:x'], { 'a:x': 'b:x', 'b:x': 'c:x' });
  assert.deepEqual(r.offered, ['b:x']);
});

test('applyCapabilityRewrites: two capabilities rerouted onto one target collapse', () => {
  const r = applyCapabilityRewrites(['build:express', 'wise:express'], {
    'build:express': 'utility',
    'wise:express': 'utility',
  });
  assert.deepEqual(r.offered, ['utility']);
});

test('applyCapabilityRewrites: an identity rule is not a reroute', () => {
  const r = applyCapabilityRewrites(['build:express'], { 'build:express': 'build:express' });
  assert.deepEqual(r.offered, ['build:express']);
  assert.equal(r.reroutedFrom, undefined);
});

test('applyCapabilityRewrites: an untouched offer is returned verbatim, duplicates included', () => {
  // Dedup is a consequence of REROUTING, not a tidy-up applied on the way past.
  // `defs.ts` validates each authored capability but never rejects a duplicate,
  // and `composeCapabilities` preserves that multiplicity — so deduplicating an
  // offer no rule touched would silently change `order.capabilities` for a
  // caller that supplied no rewrites at all.
  const none = applyCapabilityRewrites(['a:x', 'a:x'], {});
  assert.deepEqual(none.offered, ['a:x', 'a:x'], 'byte-for-byte when no rule fires');
  assert.equal(none.reroutedFrom, undefined);

  const identity = applyCapabilityRewrites(['a:x', 'a:x'], { 'a:x': 'a:x' });
  assert.deepEqual(identity.offered, ['a:x', 'a:x'], 'an identity rule is not a change either');
  assert.equal(identity.reroutedFrom, undefined);

  // ...but once a rule DOES fire, collapsing onto one target is the point.
  const fired = applyCapabilityRewrites(['a:x', 'a:x'], { 'a:x': 'b:x' });
  assert.deepEqual(fired.offered, ['b:x'], 'the rewritten offer still collapses');
  assert.deepEqual(fired.reroutedFrom, ['a:x', 'a:x'], 'the whole original offer, duplicates and all');
});

test('a step authoring a duplicate capability stamps it unchanged when no rewrites are supplied', () => {
  // The observable half of the rule above: adding the rewrite pass to the stamp
  // path must not alter what an ordinary tick records. Without the verbatim
  // return this stamps ['dup:deep'] and the order's routing snapshot silently
  // stops matching what the def asked for.
  const dupDef = def(
    'dupGraded',
    [input('proposal')],
    [step({ name: 'builder', consumes: ['proposal'], produces: ['pr'], capabilities: ['dup', 'dup'] })],
    ['deep'],
  );
  const { engine } = makeEngine([dupDef]);
  const wf = engine.createInstance('dupGraded', { modifier: 'deep' });

  const t = engine.tick(wf, { now: 0 });
  assert.equal(t.orders.length, 1);
  assert.deepEqual(t.orders[0]!.capabilities, ['dup:deep', 'dup:deep'], 'multiplicity preserved');
  assert.equal(t.orders[0]!.reroutedFrom, undefined, 'no rule fired, so no reroute record');
});

test('a rewritten offer is matched and stamped as the reroute target', () => {
  // The whole point: a crew serving only `build:standard`/`wise:standard` claims
  // an `express` run, and the ORDER says `standard` — which is what the shift
  // resolves its model against.
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });

  const rewrites = { 'build:express': 'build:standard', 'wise:express': 'wise:standard' };
  const t = engine.tick(wf, {
    now: 0,
    capabilities: ['build:standard', 'wise:standard'],
    matchModes: { 'build:standard': 'exact', 'wise:standard': 'exact' },
    capabilityRewrites: rewrites,
  });

  assert.equal(t.orders.length, 1);
  const order = t.orders[0]!;
  assert.deepEqual(order.capabilities, ['build:standard', 'wise:standard'], 'served capability');
  assert.deepEqual(order.reroutedFrom, ['build:express', 'wise:express'], 'requested capability');
  assert.deepEqual(order.crews, undefined, 'no stamps supplied');
});

test('crew stamps key on the post-rewrite served capability', () => {
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });

  const order = engine.tick(wf, {
    now: 0,
    capabilities: ['build:standard'],
    capabilityRewrites: { 'build:express': 'build:standard', 'wise:express': 'wise:standard' },
    crewStamps: {
      'build:express': ['wrong'],
      'build:standard': ['openai'],
    },
  }).orders[0]!;

  assert.deepEqual(order.capabilities, ['build:standard', 'wise:standard']);
  assert.deepEqual(order.crews, ['openai']);
});

test('a reroute never rewrites the run modifier', () => {
  // The instance keeps the grade of service it was started with. Only the offer
  // moved, and the order still reports the modifier that was asked for.
  const { engine, store } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });

  const t = engine.tick(wf, {
    now: 0,
    capabilities: ['build:standard'],
    capabilityRewrites: { 'build:express': 'build:standard' },
  });
  assert.equal(t.orders[0]!.modifier, 'express');
  assert.equal(store.getWorkflow(wf)?.modifier, 'express', 'the stored run record is untouched');
});

test('the filter and the stamped order apply the same rewrite', () => {
  // A crew presenting only the PRE-rewrite capability must not claim: what is
  // matched is what gets stamped, or a shift would receive an order whose
  // capability it never agreed to serve.
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });

  const t = engine.tick(wf, {
    now: 0,
    capabilities: ['build:express'],
    matchModes: { 'build:standard': 'exact', 'wise:standard': 'exact' },
    capabilityRewrites: { 'build:express': 'build:standard', 'wise:express': 'wise:standard' },
  });
  assert.equal(t.orders.length, 0);
  assert.equal(t.deferred.filter((d) => d.reason === 'capability-mismatch').length, 1);
});

test('no rewrites supplied is byte-for-byte the pre-rewrite behavior', () => {
  const { engine } = makeEngine([gradedDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  const t = engine.tick(wf, { now: 0, capabilities: ['build:deep'] });
  assert.deepEqual(t.orders[0]!.capabilities, ['build:deep', 'wise:deep']);
  assert.equal(t.orders[0]!.reroutedFrom, undefined);
});
