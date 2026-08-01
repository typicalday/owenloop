import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { isResumeUnavailable, type AgentEvent, type DeliverArgs, type StartArgs } from '../src/harness/contract.ts';
import { createFakeAdapter } from '../src/harness/fake.ts';
import { adapterFor, register, registeredHarnessIds, unregister } from '../src/harness/registry.ts';

const startArgs = (over: Partial<StartArgs> = {}): StartArgs => ({
  brief: 'do the thing',
  cwd: '/tmp/wt',
  owenworkMcp: { command: 'owenloop', args: ['work', 'hold', '--order', 'wf_1/run_1', '--mcp'] },
  permissions: { extensions: {} },
  ...over,
});

/**
 * PHASE 4 — `deliver` now takes a full `DeliverArgs`, not the two-field bag it
 * used to. `permissions` is REQUIRED and authoritative: the adapter builds its
 * resume options from these args, never from an in-process map, so a caller that
 * omitted them would be re-introducing the very silent degrade the widening was
 * meant to remove.
 */
const deliverArgs = (over: Partial<DeliverArgs> = {}): DeliverArgs => ({
  cwd: '/tmp/wt',
  owenworkMcp: { command: 'owenloop', args: ['work', ] },
  permissions: { extensions: {} },
  ...over,
});

const collector = (): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } => {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
};

test('start emits started, then the scripted events, and resolves with the ref', async () => {
  const fake = createFakeAdapter({
    id: 'fake',
    token: 'tok-9',
    start: { events: [{ kind: 'progress', text: 'thinking' }, { kind: 'turn_ended' }] },
  });
  const { events, onEvent } = collector();
  const args = startArgs({ brief: 'build it' });

  const ref = await fake.start(args, onEvent);

  assert.deepEqual(ref, { harness: 'fake', token: 'tok-9' });
  assert.deepEqual(events, [
    { kind: 'started', ref: { harness: 'fake', token: 'tok-9' } },
    { kind: 'progress', text: 'thinking' },
    { kind: 'turn_ended' },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.kind, 'start');
  assert.deepEqual(fake.calls[0]?.kind === 'start' ? fake.calls[0].args : null, args);
});

test('a script that supplies its own started is not given a second one', async () => {
  const own: AgentEvent = { kind: 'started', ref: { harness: 'fake', token: 'scripted' } };
  const fake = createFakeAdapter({ start: { events: [own, { kind: 'turn_ended' }] } });
  const { events, onEvent } = collector();

  await fake.start(startArgs(), onEvent);

  assert.deepEqual(events, [own, { kind: 'turn_ended' }]);
});

test('deliver replays its script, never re-emits started, and logs the message', async () => {
  const fake = createFakeAdapter({
    deliver: { events: [{ kind: 'progress', text: 'fixing' }, { kind: 'turn_ended' }] },
  });
  const ref = await fake.start(startArgs(), () => {});
  const { events, onEvent } = collector();

  await fake.deliver(ref, 'reviewer says: fix the null check', deliverArgs(), onEvent);

  assert.deepEqual(events, [{ kind: 'progress', text: 'fixing' }, { kind: 'turn_ended' }]);
  assert.ok(!events.some((e) => e.kind === 'started'), 'deliver resumes; it never re-emits started');
  const last = fake.calls[fake.calls.length - 1];
  assert.equal(last?.kind, 'deliver');
  assert.equal(last?.kind === 'deliver' ? last.message : null, 'reviewer says: fix the null check');
  assert.deepEqual(last?.kind === 'deliver' ? last.ref : null, ref);
});

test('a deliver array advances one script per call and repeats the last once exhausted', async () => {
  const fake = createFakeAdapter({
    deliver: [
      { events: [{ kind: 'progress', text: 'first' }] },
      { events: [{ kind: 'progress', text: 'second' }] },
    ],
  });
  const ref = await fake.start(startArgs(), () => {});
  const args = deliverArgs();

  const texts: string[] = [];
  const grab = (e: AgentEvent): void => {
    if (e.kind === 'progress') texts.push(e.text);
  };
  await fake.deliver(ref, 'one', args, grab);
  await fake.deliver(ref, 'two', args, grab);
  await fake.deliver(ref, 'three', args, grab);

  assert.deepEqual(texts, ['first', 'second', 'second']);
  assert.equal(fake.calls.filter((c) => c.kind === 'deliver').length, 3);
});

test('deliver on an unresumable session rejects with a ResumeUnavailableError (checked via the guard)', async () => {
  const fake = createFakeAdapter({ deliver: { resumeUnavailable: true } });
  const ref = await fake.start(startArgs(), () => {});
  const { events, onEvent } = collector();

  const err = await fake
    .deliver(ref, 'resume me', deliverArgs(), onEvent)
    .then(() => null)
    .catch((e: unknown) => e);

  assert.ok(isResumeUnavailable(err), 'the guard, not instanceof, is the supported check');
  assert.deepEqual(events, [], 'resumeUnavailable rejects instead of running the script');
  // The call is still logged, so a drill can assert deliver was ATTEMPTED.
  assert.equal(fake.calls.filter((c) => c.kind === 'deliver').length, 1);
});

test('start can also refuse as unresumable', async () => {
  const fake = createFakeAdapter({ start: { resumeUnavailable: true } });
  const err = await fake.start(startArgs(), () => {}).then(() => null).catch((e: unknown) => e);
  assert.ok(isResumeUnavailable(err));
});

test('mid-turn death: the events emitted before the failure are observed, then the promise rejects', async () => {
  const fake = createFakeAdapter({
    start: {
      events: [{ kind: 'progress', text: 'halfway' }],
      dieWith: 'harness died mid-turn',
    },
  });
  const { events, onEvent } = collector();

  const err = await fake.start(startArgs(), onEvent).then(() => null).catch((e: unknown) => e);

  assert.ok(err instanceof Error);
  assert.equal((err as Error).message, 'harness died mid-turn');
  assert.ok(!isResumeUnavailable(err), 'a death is not a resume failure');
  assert.deepEqual(events, [
    { kind: 'started', ref: { harness: 'fake', token: 'fake-token-1' } },
    { kind: 'progress', text: 'halfway' },
  ]);
});

test('defaults: id fake, native-token tier, fake-token-1, and empty scripts settle quietly', async () => {
  const fake = createFakeAdapter();
  assert.equal(fake.id, 'fake');
  assert.equal(fake.resumeTier, 'native-token');

  const { events, onEvent } = collector();
  const ref = await fake.start(startArgs(), onEvent);
  assert.deepEqual(ref, { harness: 'fake', token: 'fake-token-1' });
  assert.deepEqual(events, [{ kind: 'started', ref }]);

  await fake.deliver(ref, 'nothing scripted', deliverArgs(), onEvent);
  await fake.stop(ref);
  assert.deepEqual(fake.calls.map((c) => c.kind), ['start', 'deliver', 'stop']);
});

test('events arrive asynchronously, not synchronously inside the call', async () => {
  const fake = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { events, onEvent } = collector();
  const pending = fake.start(startArgs(), onEvent);
  assert.deepEqual(events, [], 'nothing is emitted before the first microtask hop');
  await pending;
  assert.equal(events.length, 2);
});

// ---- the runtime registry, driven by the fake --------------------------------
//
// The fake is what the registry is exercised with: it is the only adapter that
// exists in this phase, and `unregister` exists precisely so a test can put it
// in and take it back out.

const registered: string[] = [];
const registerTracked = (id: string): void => {
  register(createFakeAdapter({ id }));
  registered.push(id);
};
afterEach(() => {
  while (registered.length > 0) unregister(registered.pop()!);
});

/**
 * The registry module itself holds no adapters. Registration is a side effect
 * of importing the COMPOSITION ROOT (`src/roles/agent-run.ts`, which Phase 4
 * wired to statically import the real adapters) — never a side effect of
 * importing `src/harness/registry.ts` or an adapter module on its own. This
 * file imports neither the composition root nor anything that pulls it in, so
 * the registry it sees is empty until this file registers something itself.
 */
test('importing the registry registers nothing — only the composition root does that', () => {
  assert.deepEqual(registeredHarnessIds(), [], 'no adapter self-registers on import');
  assert.equal(adapterFor('fake'), undefined);
});

test('register then look up by id, and unregister removes it', () => {
  registerTracked('fake-a');
  registerTracked('fake-b');
  assert.deepEqual(registeredHarnessIds(), ['fake-a', 'fake-b'], 'registration order');
  assert.equal(adapterFor('fake-a')?.id, 'fake-a');
  assert.equal(adapterFor('fake-c'), undefined);

  assert.equal(unregister('fake-a'), true);
  assert.equal(unregister('fake-a'), false, 'unregistering twice is not an error, just false');
  assert.equal(adapterFor('fake-a'), undefined);
  registered.splice(registered.indexOf('fake-a'), 1);
});

test('a duplicate id throws — a second adapter claiming one id is a wiring bug', () => {
  registerTracked('fake-dup');
  assert.throws(
    () => register(createFakeAdapter({ id: 'fake-dup' })),
    /harness adapter 'fake-dup' is already registered/,
  );
});

test('importing fake.ts has no registration side effect', () => {
  // createFakeAdapter must NOT register what it builds — the caller decides.
  createFakeAdapter({ id: 'never-registered' });
  assert.equal(adapterFor('never-registered'), undefined);
});
