/**
 * Command-order routing (plan decision 5). owenloop owns the `x.owenloop` bag
 * on a step — owenloop treats `x` as opaque — and this module defines its one
 * field so far: `routing: 'shift' | 'manual'`.
 *
 * The knob answers ONE question for a `executor: 'command'` step: does THIS shift
 * auto-dispatch it, or leave it for a human/session to pick up? Two inputs feed
 * the decision — the machine-level `commandRouting` setting (default `'shift'`)
 * and the per-step `x.owenloop.routing` override — and MOST RESTRICTIVE WINS:
 * if either says `'manual'`, the shift does not auto-run the command. An
 * invalid/unknown value anywhere fails CLOSED to `'manual'` plus a warning —
 * we never auto-run a command step on a value we could not parse.
 *
 * Agent orders are NOT routed through this knob (decision 5) — only command
 * steps. Pure functions; no I/O, no side effects beyond the returned warnings.
 */
import type { FetchedStep } from '../bundle/types.ts';

export type Routing = 'shift' | 'manual';

/** True for a `executor: 'command'` step (owenloop RAW_STEP_KEYS `executor`). */
export function isCommandStep(step: FetchedStep): boolean {
  return step.executor === 'command';
}

export interface RoutingResolution {
  /** The resolved routing after applying most-restrictive-wins. */
  routing: Routing;
  /** Convenience: whether the shift should auto-dispatch this command order. */
  autoDispatch: boolean;
  /** Human-readable warnings (invalid values that failed closed). */
  warnings: string[];
}

/**
 * Coerce an unknown into a `Routing`. `undefined` maps to `absentDefault` with
 * no warning (the field simply wasn't set); any other non-`Routing` value is an
 * error that fails closed to `'manual'` and appends a warning.
 */
function coerceRouting(raw: unknown, absentDefault: Routing, label: string, warnings: string[]): Routing {
  if (raw === undefined) return absentDefault;
  if (raw === 'shift' || raw === 'manual') return raw;
  warnings.push(`invalid ${label} '${String(raw)}' — failing closed to 'manual' (command not auto-run)`);
  return 'manual';
}

/** Read `x.owenloop.routing` off a step, distinguishing a malformed bag. */
function stepRoutingRaw(step: FetchedStep): { raw: unknown; malformedBag: boolean } {
  const x = step.x;
  if (x === undefined || typeof x !== 'object' || x === null) return { raw: undefined, malformedBag: false };
  const bag = (x as Record<string, unknown>)['owenloop'];
  if (bag === undefined) return { raw: undefined, malformedBag: false };
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) return { raw: undefined, malformedBag: true };
  return { raw: (bag as Record<string, unknown>)['routing'], malformedBag: false };
}

/**
 * Resolve whether the shift auto-dispatches a command step. `machineRaw` is the
 * `commandRouting` setting value (unknown — it came from a JSON file); the step
 * override is read from `x.owenloop.routing`. Most restrictive wins; invalid
 * anywhere ⇒ manual + warning.
 */
export function resolveCommandRouting(machineRaw: unknown, step: FetchedStep): RoutingResolution {
  const warnings: string[] = [];
  const machine = coerceRouting(machineRaw, 'shift', 'commandRouting setting', warnings);

  const { raw: overrideRaw, malformedBag } = stepRoutingRaw(step);
  let override: Routing;
  if (malformedBag) {
    warnings.push(`step '${step.name}' has a malformed x.owenloop bag — failing closed to 'manual'`);
    override = 'manual';
  } else {
    override = coerceRouting(overrideRaw, 'shift', `x.owenloop.routing on step '${step.name}'`, warnings);
  }

  const routing: Routing = machine === 'manual' || override === 'manual' ? 'manual' : 'shift';
  return { routing, autoDispatch: routing === 'shift', warnings };
}
