/**
 * `owenloop work lint <workflow-name | path>` — validate the `x.harness` option bags
 * in a workflow def or cached bundle and report actionable, per-step/per-field
 * findings.
 *
 * WHICH HARNESS CHECKS A STEP. Each step names its harness (`x.harness.id`, or a
 * top-level `harness` key, which wins), and lint asks THAT adapter's optional
 * `lintStep(bag, step)`. A step that names no harness is checked by the DEFAULT
 * adapter — `defaultHarnessId()`, the registry head — because that is the adapter
 * that will actually run it. A step naming an unregistered harness is an error
 * finding, not silence: the def selects something this build cannot run.
 *
 * WHERE THE ADAPTERS COME FROM (Phase 6). This module used to be the SECOND
 * composition root, carrying its own copy of the adapter imports in an order
 * that had to match `src/roles/agent-run.ts` exactly — because the first id
 * registered is what `defaultHarnessId()` returns, and lint must judge a
 * harness-less step by the same default that will run it. Both roots are now the
 * one module `src/harnesses.ts`, imported below for its side effect, so that
 * order has a single owner and the two files can no longer disagree.
 *
 * Target resolution (D9):
 *   `*.yaml` / `*.yml` — a raw owenloop def, parsed with `yaml`. Only what lint
 *                        needs is read (a `steps` list with `name` + optional
 *                        `x`); this does NOT reimplement owenloop's validator.
 *   `*.json`           — a cached/exported bundle (`CachedBundle` or a bare
 *                        `FetchedDef`).
 *   bare name          — the latest cached bundle for that workflow (error with
 *                        "run `owenloop work prepare <name>` first" when absent).
 *
 * Exit codes: 0 clean or warnings-only · 1 any error finding (or a load
 * failure) · 2 usage. (Exit 1 is new for lint but consistent: 0 ok / 1 real
 * failure / 2 usage / 3 stub.)
 */
import '../harnesses.ts';

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import type { FetchedStep } from '../bundle/types.ts';
import type { LintFinding } from '../harness/types.ts';
import { adapterFor, defaultHarnessId } from '../harness/registry.ts';
import {
  normalizeStepPermissions,
  preflightStepPermissions,
  validateHarnessOptions,
} from '../harness/permissions.ts';
import { parseHarnessCarrier } from '../bundle/fetch.ts';
import { readLatestBundle, resolveCacheDir } from '../bundle/cache.ts';
import { loadSettings } from '../settings/settings.ts';

export async function run(args: string[]): Promise<number> {
  const positional = args.filter((a) => !a.startsWith('-'));
  const unknownFlag = args.find((a) => a.startsWith('-'));
  if (unknownFlag !== undefined) {
    process.stderr.write(`owenloop work lint: unknown option '${unknownFlag}'\n`);
    process.stderr.write('usage: owenloop work lint <workflow-name | path>\n');
    return 2;
  }
  if (positional.length === 0) {
    process.stderr.write('owenloop work lint: missing required <workflow-name | path>\n');
    process.stderr.write('usage: owenloop work lint <workflow-name | path>\n');
    return 2;
  }
  if (positional.length > 1) {
    process.stderr.write(`owenloop work lint: unexpected argument '${positional[1]}'\n`);
    return 2;
  }
  const target = positional[0]!;

  let steps: FetchedStep[];
  try {
    steps = loadSteps(target);
  } catch (err) {
    process.stderr.write(`owenloop work lint: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const findings: LintFinding[] = [];
  for (const step of steps) {
    findings.push(...lintOneStep(step));
  }

  const out = process.stdout;
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else warnings++;
    const loc = f.field !== undefined ? `x.harness.${f.field}` : 'x.harness';
    out.write(`${f.severity}  step ${f.step}: ${loc}: ${f.message}\n`);
  }
  out.write(`lint: ${steps.length} step(s), ${errors} error(s), ${warnings} warning(s)\n`);

  return errors > 0 ? 1 : 0;
}

/**
 * Findings for ONE step: resolve which adapter would run it, then hand that
 * adapter the step's option bag.
 *
 * A step that omits both the harness id and the `x.harness` bag is silent — lint
 * has no explicit selection or options to judge. An explicit id is checked even
 * when no option bag exists, because dispatch would still try to resolve that id.
 *
 * ONE finding is raised HERE rather than by the adapter: the bag-`model` /
 * first-class-`model` conflict. The harness contract's `lintStep(bag, step)`
 * receives only the bag and the step NAME, so no adapter can see `step.model`;
 * this function still holds the whole `FetchedStep`. Raising it here is also the
 * neutral home for it, because the precedence it warns about is implemented by
 * the NEUTRAL normalizer (`normalizeStepPermissions` in
 * `src/harness/permissions.ts`: `step.model` wins over `bag.model`), not by any
 * one adapter.
 *
 * Exported for tests: the alternative is asserting on `run()`'s stdout, which
 * would test the printer instead of the resolution logic.
 */
export function lintOneStep(step: FetchedStep): LintFinding[] {
  const bag = step.harnessOptions;
  const id = step.harness ?? defaultHarnessId();

  // An explicit id is independently lintable: naming an adapter this build does
  // not have is an error even when the step carries no adapter option fields.
  // Omission with no bag remains clean because there is nothing to validate.
  if (step.harness !== undefined && adapterFor(step.harness) === undefined) {
    return [{
      severity: 'error',
      step: step.name,
      message: `unknown harness '${step.harness}' — this build cannot run it`,
      field: 'id',
    }];
  }
  if (bag === undefined) return [];
  if (id === undefined) {
    return [{
      severity: 'error',
      step: step.name,
      message: 'no harness is registered in this build, so nothing can check these options',
    }];
  }
  const adapter = adapterFor(id);
  if (adapter === undefined) {
    return [{
      severity: 'error',
      step: step.name,
      message: `unknown harness '${id}' — this build cannot run it`,
      field: 'id',
    }];
  }
  const permissions = normalizeStepPermissions(bag, step);
  const findings: LintFinding[] = [
    ...validateHarnessOptions(bag, step.name),
    ...preflightStepPermissions(permissions).map((issue) => ({
      severity: 'error' as const,
      step: step.name,
      message: issue.message,
      ...(issue.field !== undefined ? { field: issue.field } : {}),
    })),
    ...adapter.preflight(permissions).map((issue) => ({
      severity: 'error' as const,
      step: step.name,
      message: issue.message,
      ...(issue.field !== undefined ? { field: issue.field } : {}),
    })),
    ...(adapter.lintStep?.(bag, step.name) ?? []),
  ];

  if (step.model !== undefined && 'model' in bag) {
    findings.push({
      severity: 'warning',
      step: step.name,
      field: 'model',
      message: `bag sets model but the step's first-class model wins (step model: '${step.model}')`,
    });
  }

  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.severity}\0${finding.step}\0${finding.field ?? ''}\0${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Load the steps to lint from a yaml def, a json bundle, or a bare name. */
function loadSteps(target: string): FetchedStep[] {
  if (target.endsWith('.yaml') || target.endsWith('.yml')) {
    if (!existsSync(target)) throw new Error(`no such file: ${target}`);
    const parsed = parseYaml(readFileSync(target, 'utf8')) as unknown;
    return stepsFromDefLike(parsed, target);
  }
  if (target.endsWith('.json')) {
    if (!existsSync(target)) throw new Error(`no such file: ${target}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'));
    } catch (err) {
      throw new Error(`malformed JSON in ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A CachedBundle wraps the def under `def`; a bare FetchedDef is the def.
    const p = parsed as Record<string, unknown>;
    const defLike = p && typeof p === 'object' && 'def' in p ? p['def'] : parsed;
    return stepsFromDefLike(defLike, target);
  }
  // Bare workflow name — read the latest cached bundle.
  const cacheDir = resolveCacheDir(process.env, loadSettings(process.env).cacheDir);
  const bundle = readLatestBundle(cacheDir, target);
  if (bundle === null) {
    throw new Error(`no cached bundle for '${target}' — run \`owenloop work prepare ${target}\` first`);
  }
  return bundle.def.steps;
}

/**
 * Pull a loose `FetchedStep[]` out of a def-like object (only name + model +
 * executor + the harness carrier are needed).
 *
 * The carrier is lifted by `parseHarnessCarrier`, the SAME function the def
 * parser uses, so lint and prepare cannot disagree about what `x.harness` means.
 * A malformed carrier throws there and surfaces as a load failure (exit 1),
 * which is right: lint cannot check options it cannot parse.
 */
function stepsFromDefLike(defLike: unknown, source: string): FetchedStep[] {
  if (typeof defLike !== 'object' || defLike === null) {
    throw new Error(`${source}: not a workflow def (expected an object with a steps list)`);
  }
  const rawSteps = (defLike as Record<string, unknown>)['steps'];
  if (!Array.isArray(rawSteps)) {
    throw new Error(`${source}: missing a steps list`);
  }
  return rawSteps.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`${source}: step[${i}] is not an object`);
    }
    const s = raw as Record<string, unknown>;
    const name = typeof s['name'] === 'string' ? (s['name'] as string) : `step[${i}]`;
    return {
      name,
      model: typeof s['model'] === 'string' ? (s['model'] as string) : undefined,
      executor: typeof s['executor'] === 'string' ? (s['executor'] as string) : undefined,
      ...parseHarnessCarrier(s, source, name),
      x: (typeof s['x'] === 'object' && s['x'] !== null ? (s['x'] as Record<string, unknown>) : undefined),
    };
  });
}
