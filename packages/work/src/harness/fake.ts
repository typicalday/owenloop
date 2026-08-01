/**
 * `FakeAdapter` — a scripted `HarnessAdapter` with no I/O, no child process, and
 * no real timers. It exists so Phase 3's runner and the drills can be developed
 * and tested before any real adapter lands, and so failure modes that are hard
 * to provoke against a real provider (an unresumable session, a death mid-turn)
 * are one fixture field away.
 *
 * TEST-ONLY EXPORT — meaning NO PRODUCTION CALLER, not "not shipped". Three
 * mechanisms enforce that, all of them live today:
 *  1. This module has ZERO import side effects — in particular it does NOT call
 *     `register(...)`. A test constructs an adapter and registers it explicitly,
 *     then unregisters it in `afterEach`.
 *  2. No file under `src/` imports this module, and there is no barrel/index
 *     under `src/harness/` through which it could leak. Do not add one.
 *  3. `test/harness-isolation.test.ts` asserts (2) mechanically, by walking
 *     `src/` and failing on any import of `fake.ts` from outside this file.
 *
 * It IS compiled into `dist/` by `tsconfig.build.json`'s `src/**` include. That
 * is accepted deliberately: carving it out would desynchronize `tsc --noEmit`
 * from the build, and the no-caller rule is what actually matters.
 *
 * Failure stance: total and deterministic. Everything it does is drive the
 * script it was handed; the only failures are the ones a script asks for.
 */
import { ResumeUnavailableError } from './contract.ts';
import type {
  AgentEvent,
  DeliverArgs,
  HarnessAdapter,
  HarnessSessionRef,
  ResumeTier,
  StartArgs,
} from './contract.ts';

/** One scripted call — what `start` or a single `deliver` does. */
export interface FakeScript {
  /** Events emitted, in order, before the call settles. `start` emits its own
   *  `started` first unless the script already supplies one. */
  events?: AgentEvent[];
  /** Reject with `ResumeUnavailableError` INSTEAD of running — no events at all.
   *  This is the "provider forgot the session" case the resume fallback needs. */
  resumeUnavailable?: boolean;
  /** Emit the events, THEN reject with a plain `Error` carrying this message —
   *  death mid-turn. Combine with a partial `events` list to model a session
   *  that died with work in flight. */
  dieWith?: string;
}

/** The fixture a fake adapter is built from. Every field has a default. */
export interface FakeSpec {
  /** Adapter id and `HarnessSessionRef.harness`. Default `'fake'`. */
  id?: string;
  /** Default `'native-token'`. Declarative only — nothing branches on it yet. */
  resumeTier?: ResumeTier;
  /** The session token handed back. Default `'fake-token-1'`. */
  token?: string;
  start?: FakeScript;
  /** One script, or an array consumed one script per successive `deliver` call
   *  (the LAST entry repeats once the array is exhausted). */
  deliver?: FakeScript | FakeScript[];
}

/** One recorded method call, so a test can assert WHICH method ran with what. */
export type FakeCall =
  | { kind: 'start'; args: StartArgs }
  /** `args` is recorded from Phase 4 on: the widened `DeliverArgs` carries the
   *  `permissions` a resumed turn must run under, and "did the resume keep the
   *  original permission context?" is only assertable if the fake keeps it. */
  | { kind: 'deliver'; ref: HarnessSessionRef; message: string; args: DeliverArgs }
  | { kind: 'stop'; ref: HarnessSessionRef };

/**
 * A `HarnessAdapter` plus an inspectable call log.
 *
 * The log is what lets a drill assert, for example, that a re-armed step called
 * `deliver` (resume) and NOT `start` (cold replay), carrying the rejection
 * reasons as its message — the exact assertion Phase 4 needs.
 */
export interface FakeAdapter extends HarnessAdapter {
  readonly calls: FakeCall[];
}

const EMPTY_SCRIPT: FakeScript = {};

/** Pick the script for the Nth `deliver`; the last entry repeats forever. */
function scriptAt(spec: FakeScript | FakeScript[] | undefined, index: number): FakeScript {
  if (spec === undefined) return EMPTY_SCRIPT;
  if (!Array.isArray(spec)) return spec;
  if (spec.length === 0) return EMPTY_SCRIPT;
  const clamped = index < spec.length ? index : spec.length - 1;
  return spec[clamped] ?? EMPTY_SCRIPT; // noUncheckedIndexedAccess
}

/** Emit the script's events with a microtask hop between them, so an observer
 *  sees them arrive asynchronously the way a real stream delivers them. */
async function emit(events: AgentEvent[], onEvent: (e: AgentEvent) => void): Promise<void> {
  for (const e of events) {
    await Promise.resolve();
    onEvent(e);
  }
}

/**
 * Build a fake adapter from a fixture. Registers nothing — the caller decides
 * whether it goes into the registry.
 */
export function createFakeAdapter(spec: FakeSpec = {}): FakeAdapter {
  const id = spec.id ?? 'fake';
  const token = spec.token ?? 'fake-token-1';
  const ref: HarnessSessionRef = { harness: id, token };
  const calls: FakeCall[] = [];
  let deliverIndex = 0;

  return {
    id,
    resumeTier: spec.resumeTier ?? 'native-token',
    calls,

    async start(args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
      calls.push({ kind: 'start', args });
      const script = spec.start ?? EMPTY_SCRIPT;
      if (script.resumeUnavailable === true) {
        throw new ResumeUnavailableError(`fake adapter '${id}': session '${token}' is not resumable`);
      }
      const scripted = script.events ?? [];
      const hasStarted = scripted.some((e) => e.kind === 'started');
      const events: AgentEvent[] = hasStarted ? scripted : [{ kind: 'started', ref }, ...scripted];
      await emit(events, onEvent);
      if (script.dieWith !== undefined) throw new Error(script.dieWith);
      return ref;
    },

    async deliver(
      target: HarnessSessionRef,
      message: string,
      args: DeliverArgs,
      onEvent: (e: AgentEvent) => void,
    ): Promise<void> {
      calls.push({ kind: 'deliver', ref: target, message, args });
      const script = scriptAt(spec.deliver, deliverIndex);
      deliverIndex += 1;
      if (script.resumeUnavailable === true) {
        throw new ResumeUnavailableError(
          `fake adapter '${id}': session '${target.token}' is not resumable`,
        );
      }
      // `deliver` resumes an existing session, so it never re-emits `started`.
      await emit(script.events ?? [], onEvent);
      if (script.dieWith !== undefined) throw new Error(script.dieWith);
    },

    async stop(target: HarnessSessionRef): Promise<void> {
      calls.push({ kind: 'stop', ref: target });
    },
  };
}
