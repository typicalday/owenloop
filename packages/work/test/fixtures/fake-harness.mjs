/**
 * A registrable fake harness for the DRILLS, loaded by a spawned `owenloop work
 * agent-run` child through the `OWENWORK_HARNESS_MODULE` test seam.
 *
 * WHY A SEPARATE `.mjs` RATHER THAN THE UNIT TESTS' IN-PROCESS FAKE: a drill
 * spawns a REAL detached child, so the child has its own module graph and the
 * parent cannot hand it an object. The seam takes a module specifier, the child
 * `import()`s it, and the module's side effect is to `register(...)` an adapter.
 * This file therefore imports from `dist/` (what the packaged bin actually
 * loads) rather than from `src/` — `npm run predrills` builds `dist/` first.
 *
 * TEST-ONLY, and it stays that way for the same reason `src/harness/fake.ts`
 * does: nothing under `src/` imports it, and the only thing that names it is a
 * drill's env.
 *
 * CONFIGURATION — everything arrives through the child's env, since there is no
 * other channel into a detached process:
 *   OWENWORK_FAKE_SCRIPT  JSON. `{ id?, token?, hang?, start?, deliver? }`.
 *                         `start`/`deliver` are `FakeScript`s (see
 *                         src/harness/fake.ts). `hang: true` makes `start` emit
 *                         its events and then NEVER settle — a turn that is
 *                         still running, which is what the kill drill needs.
 *   OWENWORK_FAKE_TRACE   path to a JSONL file; one line per adapter call
 *                         (`start` / `deliver` / `stop`), so the parent drill
 *                         can observe a child whose stdio is 'ignore'.
 *
 * Failure stance: if the script is missing or malformed, register an adapter
 * that emits `started` + `turn_ended` and settles. A drill that cares asserts on
 * the trace, so a silent default cannot make a drill pass by accident.
 */
import { appendFileSync } from 'node:fs';

import { createFakeAdapter } from '../../../../dist/packages/work/src/harness/fake.js';
import { register } from '../../../../dist/packages/work/src/harness/registry.js';

function readScript() {
  const raw = process.env['OWENWORK_FAKE_SCRIPT'];
  if (raw === undefined || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const spec = readScript();
const tracePath = process.env['OWENWORK_FAKE_TRACE'];

/** Append one traced call. Fail-open — a trace write must never fail a run. */
function trace(entry) {
  if (tracePath === undefined || tracePath === '') return;
  try {
    appendFileSync(tracePath, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
  } catch {
    // best effort
  }
}

const inner = createFakeAdapter({
  ...(spec.id !== undefined ? { id: spec.id } : {}),
  ...(spec.token !== undefined ? { token: spec.token } : {}),
  start: spec.start ?? { events: [{ kind: 'turn_ended' }] },
  ...(spec.deliver !== undefined ? { deliver: spec.deliver } : {}),
});

/**
 * The registered adapter: `inner` plus tracing, plus the `hang` behaviour.
 *
 * `hang` is NOT a `FakeScript` field because it is not a scripted outcome — it
 * is the ABSENCE of one. `inner.start` still runs (so `started` and any scripted
 * events reach the runner, and the runner learns the session ref it needs to
 * call `stop`), and only the returned promise is withheld. That is the precise
 * shape of a live turn: the session exists, the model has not finished.
 */
const adapter = {
  id: inner.id,
  resumeTier: inner.resumeTier,

  async start(args, onEvent) {
    trace({
      call: 'start',
      harnessId: inner.id,
      cwd: args.cwd ?? null,
      brief: args.brief,
      mcp: args.owenworkMcp,
      model: args.model ?? null,
      permissions: args.permissions,
    });
    const started = inner.start(args, (e) => {
      trace({ call: 'event', kind: e.kind });
      onEvent(e);
    });
    if (spec.hang === true) {
      await started; // let the events land, then never settle
      trace({ call: 'hanging' });
      return new Promise(() => {});
    }
    return started;
  },

  /**
   * FOUR parameters, matching `HarnessAdapter.deliver(ref, message, args,
   * onEvent)`. It was three until Phase 4, which meant the real `onEvent` landed
   * in the adapter's `args` slot and `undefined` landed in `onEvent`, so any
   * deliver script with events threw a TypeError inside `emit`. Nothing called
   * `deliver` in a drill before Phase 4, which is the only reason it stayed
   * invisible.
   *
   * `args.cwd` and `args.permissions` are traced because the widened third
   * parameter is exactly what a drill needs to prove crossed the process
   * boundary: it is what makes a cross-process resume keep the permission
   * context its `start` ran under.
   *
   * `ref.token` is traced for the sibling reason: it is the ONLY evidence that a
   * SECOND `agent-run` process resumed the session the FIRST one created, rather
   * than minting a new one that happens to behave the same way.
   */
  async deliver(ref, message, args, onEvent) {
    trace({
      call: 'deliver',
      token: ref?.token ?? null,
      message,
      cwd: args?.cwd ?? null,
      permissions: args?.permissions ?? null,
      model: args?.model ?? null,
    });
    return inner.deliver(ref, message, args, (e) => {
      trace({ call: 'event', kind: e.kind });
      onEvent(e);
    });
  },

  async stop(ref) {
    trace({ call: 'stop', token: ref.token });
    return inner.stop(ref);
  },
};

register(adapter);
