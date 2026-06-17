/**
 * Tests for buildGraph, graphToDot, graphToMermaid (§spatial view).
 *
 * Coverage:
 *  - node/edge derivation for linear and collection/map/reduce defs
 *  - overlay state annotation (Engine-driven instances)
 *  - stall annotation
 *  - determinism of both the builder and both renderers
 *  - DOT and Mermaid content assertions
 *  - dangling-consume resilience
 *  - static (no-artifact) mode
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { buildGraph, graphToDot, graphToMermaid } from '../src/model.ts';
import { def, input, loop } from './helpers.ts';

// ---- fixture defs ------------------------------------------------------------

// delivery: linear chain — proposal → planner → builder → reviewer → merger
const delivery = def('delivery', [input('proposal')], [
  loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
  loop({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
  loop({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
  loop({ name: 'merger', consumes: ['verdict'], produces: ['merge'], terminal: true }),
]);

// research: collection + map + reduce
const research = def('research', [input('question')], [
  loop({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
  loop({ name: 'formatcheck', consumes: ['gather.source[$i]'], produces: ['gather.source[$i].formatcheck'] }),
  loop({ name: 'synthesize', consumes: ['gather.source[*]'], produces: ['draft'] }),
]);

// ---- buildGraph: structure ---------------------------------------------------

test('buildGraph: nodes = loops + inputs, all present', () => {
  const g = buildGraph(delivery);
  const ids = g.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['builder', 'merger', 'planner', 'proposal', 'reviewer']);
  assert.equal(g.nodes.find((n) => n.id === 'proposal')!.kind, 'input');
  assert.equal(g.nodes.find((n) => n.id === 'merger')!.terminal, true);
  assert.equal(g.nodes.find((n) => n.id === 'planner')!.kind, 'loop');
  assert.equal(g.hasOverlay, false);
});

test('buildGraph: edges reflect producer→consumer direction', () => {
  const g = buildGraph(delivery);
  // proposal -> planner (plain, stem=proposal)
  const e1 = g.edges.find((e) => e.from === 'proposal' && e.to === 'planner');
  assert.ok(e1, 'proposal → planner edge exists');
  assert.equal(e1!.mode, 'plain');
  assert.equal(e1!.stem, 'proposal');
  // planner -> builder (plan), builder -> reviewer (pr), reviewer -> merger (verdict)
  assert.ok(g.edges.find((e) => e.from === 'planner' && e.to === 'builder'));
  assert.ok(g.edges.find((e) => e.from === 'builder' && e.to === 'reviewer'));
  assert.ok(g.edges.find((e) => e.from === 'reviewer' && e.to === 'merger'));
  assert.equal(g.edges.length, 4);
});

test('buildGraph: map consume produces map-mode edge, reduce produces reduce-mode edge', () => {
  const g = buildGraph(research);
  // gather → formatcheck: map mode (gather.source[$i])
  const mapEdge = g.edges.find((e) => e.from === 'gather' && e.to === 'formatcheck');
  assert.ok(mapEdge, 'map edge exists');
  assert.equal(mapEdge!.mode, 'map');
  assert.equal(mapEdge!.stem, 'gather.source');
  assert.equal(mapEdge!.binder, 'i');
  // gather → synthesize: reduce mode (gather.source[*])
  const reduceEdge = g.edges.find((e) => e.from === 'gather' && e.to === 'synthesize');
  assert.ok(reduceEdge, 'reduce edge exists');
  assert.equal(reduceEdge!.mode, 'reduce');
  assert.equal(reduceEdge!.stem, 'gather.source');
});

test('buildGraph: terminal loop is flagged on the node', () => {
  const g = buildGraph(delivery);
  assert.equal(g.nodes.find((n) => n.id === 'merger')!.terminal, true);
  assert.equal(g.nodes.find((n) => n.id === 'planner')!.terminal, undefined);
});

test('buildGraph: dangling consume renders without crashing', () => {
  const d = def('broken', [input('seed')], [
    loop({ name: 'a', consumes: ['seed'], produces: ['mid'] }),
    loop({ name: 'b', consumes: ['ghost'], produces: ['out'] }), // ghost has no producer
  ]);
  const g = buildGraph(d);
  // There should be a dangling edge for ghost
  const danglingEdge = g.edges.find((e) => e.to === 'b' && e.stem === 'ghost');
  assert.ok(danglingEdge, 'dangling edge exists');
  assert.ok(danglingEdge!.from.startsWith('__dangling__'), 'dangling from-id has sentinel prefix');
  // Renderers should not throw
  assert.doesNotThrow(() => graphToDot(g));
  assert.doesNotThrow(() => graphToMermaid(g));
});

// ---- buildGraph: overlay -----------------------------------------------------

test('buildGraph overlay: mixed artifact state annotates nodes correctly', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);

  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });

  // Green planner's output (plan)
  const tick1 = engine.tick(wf);
  const plannerOrder = tick1.orders[0]!;
  engine.green(wf, plannerOrder.run, 'plan', { plan: 'v1' });
  engine.close(wf, plannerOrder.run, 'ok');

  // Do NOT advance further — builder's 'pr' is still owed
  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(delivery, artifacts);

  assert.equal(g.hasOverlay, true);

  // proposal input was provided at create: should be green
  const proposalNode = g.nodes.find((n) => n.id === 'proposal');
  assert.ok(proposalNode, 'proposal node exists');
  assert.equal(proposalNode!.state, 'green');

  // planner produced plan (green)
  const plannerNode = g.nodes.find((n) => n.id === 'planner');
  assert.equal(plannerNode!.state, 'green');

  // builder's pr is owed
  const builderNode = g.nodes.find((n) => n.id === 'builder');
  assert.equal(builderNode!.state, 'owed');

  store.close();
});

test('buildGraph overlay: stalled artifact sets node.stalled = true and state = stalled', () => {
  const store = new Store(':memory:');
  // Use maxAttempts=1 so one reject immediately stalls
  const d = def('small', [input('seed')], [
    loop({ name: 'worker', consumes: ['seed'], produces: ['out'], maxAttempts: 1 }),
  ]);
  const engine = new Engine(store, () => d);
  const wf = engine.createInstance('small', { provide: { seed: {} } });

  // Worker fires, produces out, gets judged rejected → stall immediately
  const tick = engine.tick(wf);
  const order = tick.orders[0]!;
  engine.green(wf, order.run, 'out', { v: 1 });
  engine.close(wf, order.run, 'ok');
  engine.reject(wf, 'out', 'human', 'bad quality');

  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(d, artifacts);

  const workerNode = g.nodes.find((n) => n.id === 'worker');
  assert.equal(workerNode!.state, 'stalled');
  assert.equal(workerNode!.stalled, true);

  store.close();
});

// ---- determinism -------------------------------------------------------------

test('buildGraph + renderers are deterministic (calling twice yields identical output)', () => {
  const g1 = buildGraph(research);
  const g2 = buildGraph(research);
  assert.deepEqual(g1.nodes, g2.nodes);
  assert.deepEqual(g1.edges, g2.edges);

  const dot1 = graphToDot(g1);
  const dot2 = graphToDot(g2);
  assert.equal(dot1, dot2, 'DOT output is identical across calls');

  const mmd1 = graphToMermaid(g1);
  const mmd2 = graphToMermaid(g2);
  assert.equal(mmd1, mmd2, 'Mermaid output is identical across calls');
});

// ---- renderer content assertions --------------------------------------------

test('graphToDot: contains digraph, node ids, and -> edges', () => {
  const g = buildGraph(delivery);
  const dot = graphToDot(g);
  assert.match(dot, /digraph/, 'contains digraph keyword');
  assert.match(dot, /"planner"/, 'planner node present');
  assert.match(dot, /"proposal"/, 'proposal node present');
  assert.match(dot, /->/, 'has at least one edge');
  // ellipse for input node
  assert.match(dot, /shape=ellipse/, 'input node has ellipse shape');
  // doublecircle for terminal
  assert.match(dot, /shape=doublecircle/, 'terminal loop has doublecircle shape');
});

test('graphToMermaid: contains flowchart and edge arrow', () => {
  const g = buildGraph(delivery);
  const mmd = graphToMermaid(g);
  assert.match(mmd, /flowchart/, 'starts with flowchart keyword');
  assert.match(mmd, /-->/, 'has at least one edge arrow');
});

test('graphToDot: overlay fill colors appear in output when artifacts are supplied', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);
  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });
  const tick = engine.tick(wf);
  const order = tick.orders[0]!;
  engine.green(wf, order.run, 'plan', { plan: 'v1' });
  engine.close(wf, order.run, 'ok');

  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(delivery, artifacts);
  const dot = graphToDot(g);
  assert.match(dot, /fillcolor/, 'overlay colors present in DOT');
  assert.match(dot, /style=filled/, 'style=filled present for colored nodes');
  store.close();
});

test('graphToMermaid: classDef and class assignments appear when overlay present', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);
  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });
  const tick = engine.tick(wf);
  const order = tick.orders[0]!;
  engine.green(wf, order.run, 'plan', { plan: 'v1' });
  engine.close(wf, order.run, 'ok');

  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(delivery, artifacts);
  const mmd = graphToMermaid(g);
  assert.match(mmd, /classDef/, 'Mermaid classDef present');
  assert.match(mmd, /class /, 'class assignment present');
  store.close();
});

// ---- static (no-artifact) mode ----------------------------------------------

test('buildGraph with no artifacts: hasOverlay=false, no node.state fields', () => {
  const g = buildGraph(delivery);
  assert.equal(g.hasOverlay, false);
  for (const n of g.nodes) {
    assert.equal(n.state, undefined, `${n.id} should have no state in static mode`);
  }
});
