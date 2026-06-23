/**
 * The pure dataflow model — eligibility, fingerprints, and cascade decisions.
 *
 * Everything here is a pure function of (workflow definition, current artifact
 * set). No IO, no clock, no store — so the firing rule (§3), the collection
 * eligibility (§11.4), the forward cascade (§11.8), and the level-triggered
 * re-derivation (§12.3) can all be unit-tested in isolation. The engine
 * (engine.ts) is the only thing that turns these decisions into writes.
 *
 * The artifact set for one workflow instance is passed as a `Map<path, data>`.
 */

import {
  bindProduce,
  elementPath,
  isMemberOf,
  parseElement,
  sealPath,
} from './paths.ts';
import { DEBT_STATES, SETTLED_STATES } from './types.ts';
import type {
  Acceptance,
  ArtifactBiography,
  ArtifactData,
  CheckOptions,
  CheckReport,
  CheckStep,
  ConsumePattern,
  FiringTrigger,
  Fingerprint,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  InvariantPredicate,
  LoopDef,
  ProducePattern,
  RunData,
  TimelineEvent,
  WorkflowDef,
  WorkflowGraph,
  WorkflowTrace,
} from './types.ts';

export type ArtifactMap = ReadonlyMap<string, ArtifactData>;

/**
 * Clock and quiescence facts needed for idle-trigger eligibility.
 * Passed as an explicit parameter — model.ts is pure (no Date, no nowMs).
 */
export interface TimeFacts {
  /** Current time (ms since epoch). */
  now: number;
  /** Timestamp of the most recent artifact state change for this workflow. */
  lastProgressMs: number;
  /** Whether any run is genuinely in flight (claimed + lease fresh). */
  inFlight: boolean;
  /** Per-loop alarm_at values: loop name → alarm_at in ms (if set). */
  alarms: Map<string, number>;
}

/** A candidate run: a loop bound to a particular key, with its concrete edges. */
export interface Firing {
  loop: string;
  key: string; // "" for plain/reduce, the element path for a map element
  index?: number; // the bound element index, for map firings
  inputs: string[]; // concrete consumed input paths (all green) — the claim fingerprint domain
  outputs: string[]; // concrete owed/rejected output paths this firing discharges
  /** The trigger that made this firing eligible (§21). Absent means 'inputsGreen'. */
  cause?: FiringTrigger;
}

/** A structural maintenance op the engine should apply (level-triggered). */
export type CascadeOp =
  | { kind: 'reject'; path: string; reason: string; held?: true } // green→rejected, value kept; held=true for escalate
  | { kind: 'retract'; path: string; reason: string } // tombstone a map child of a retracted element
  | { kind: 'skip'; path: string; reason: string } // cascade skip down a dead branch
  | { kind: 'rearm'; path: string; reason: string } // skipped→owed when the branch revives
  | { kind: 'pin'; path: string; reason: string } // stays green, fingerprint re-pointed to current inputs
  | { kind: 'arm'; handlerLoop: string; reason: string; path?: undefined }; // arm a handler loop on invalidation of L

// ---- loop shape classification ----------------------------------------------

export function mapConsume(loop: LoopDef): ConsumePattern | undefined {
  return loop.consumes.find((c) => c.mode === 'map');
}
export function reduceConsume(loop: LoopDef): ConsumePattern | undefined {
  return loop.consumes.find((c) => c.mode === 'reduce');
}
export function plainConsumes(loop: LoopDef): ConsumePattern[] {
  return loop.consumes.filter((c) => c.mode === 'plain');
}

export type LoopMode = 'plain' | 'map' | 'reduce';
export function loopMode(loop: LoopDef): LoopMode {
  if (mapConsume(loop)) return 'map';
  if (reduceConsume(loop)) return 'reduce';
  return 'plain';
}

export function mapProduce(loop: LoopDef): ProducePattern | undefined {
  return loop.produces.find((p) => p.kind === 'map');
}
/**
 * The concrete input artifact a map element binds on for index `i`. Normally the
 * bare collection member `stem[i]`. But when the map consume carries a suffix
 * (`stem[$i].sub` — the loop chains off *another* map's per-element output), the
 * gate is that suffixed per-element child `stem[i].sub`, not the bare member.
 * The bare member set still fixes the index space (cardinality, §11.1); the
 * suffix only moves where the greenness/fingerprint gate points.
 */
export function mapInputPath(mc: ConsumePattern, index: number): string {
  return elementPath(mc.stem, index, mc.suffix);
}
/** The collection stem a loop produces (`gather.source` for `gather.source[]`), if any. */
export function collectionStem(loop: LoopDef): string | undefined {
  return loop.produces.find((p) => p.kind === 'collection')?.stem;
}
export function singletonProduces(loop: LoopDef): ProducePattern[] {
  return loop.produces.filter((p) => p.kind === 'singleton');
}
export function collectionProduces(loop: LoopDef): ProducePattern[] {
  return loop.produces.filter((p) => p.kind === 'collection');
}

// ---- small predicates --------------------------------------------------------

export function isDebt(a: ArtifactData | undefined): boolean {
  return !!a && DEBT_STATES.has(a.acceptance);
}
export function isGreen(a: ArtifactData | undefined): boolean {
  return !!a && a.acceptance === 'green';
}
/**
 * §6 liveness: a judgment-rejected artifact that has been knocked back `cap`
 * times has *stalled*. It stays a debt (so it surfaces as stuck), but the engine
 * stops re-arming it — no firing is eligible to rebuild it until a human clears
 * the stall (`retry` resets the count, or `retract` drops a collection member).
 * Only *judgment* rejects count toward `judgmentRejects` (structural cascade /
 * born-rejected / level-trigger churn never bump it), so this bounds genuine
 * verdict-thrash without tripping on bookkeeping (§11.9).
 */
export function isStalled(a: ArtifactData | undefined, cap: number): boolean {
  return !!a && a.acceptance === 'rejected' && a.judgmentRejects >= cap;
}
/**
 * §18 liveness: an output that has failed its declared JSON Schema `cap` times
 * has stalled the same way (it stays a debt but stops re-arming). Tracked on a
 * *separate* counter from judgment rejects — a schema failure is the engine
 * refusing a malformed value, not a consumer's verdict — so the two stalls are
 * tuned independently (`maxSchemaFailures` vs `maxAttempts`) and a `retry`
 * clears both. A `cap` of 0 disables the schema stall (unbounded retries).
 */
export function isSchemaStalled(a: ArtifactData | undefined, cap: number): boolean {
  return !!a && cap > 0 && a.acceptance === 'rejected' && a.schemaRejects >= cap;
}
/**
 * True if the artifact is held (non-idempotent escalate) — rejected-and-held,
 * producer not auto-eligible to re-fire. Detected by the last reasons entry
 * having kind='invalidated-irreversible'. A retry call appends a 'structural'
 * entry, which clears the held condition automatically.
 */
export function isHeld(a: ArtifactData | undefined): boolean {
  if (!a || a.acceptance !== 'rejected') return false;
  return a.reasons.length > 0 && a.reasons[a.reasons.length - 1]!.kind === 'invalidated-irreversible';
}

/** An artifact is frozen (no firing re-arms it) when either stall trips or it is held. */
function frozen(a: ArtifactData | undefined, loop: LoopDef): boolean {
  return isStalled(a, loop.maxAttempts) || isSchemaStalled(a, loop.maxSchemaFailures) || isHeld(a);
}

/** Resolve the effective effect contract for a loop. Defaults: idempotent=true. */
function resolvedEffect(loop: LoopDef | undefined): { idempotent: boolean; onInvalidate: 'pin' | 'escalate' | string } {
  const idempotent = loop?.effect?.idempotent ?? true;
  const onInvalidate = loop?.effect?.onInvalidate ?? 'escalate';
  return { idempotent, onInvalidate };
}

/** The effective set of firing triggers for a loop. Defaults to ['inputsGreen']. */
function resolvedTriggers(loop: LoopDef): FiringTrigger[] {
  return loop.on ?? ['inputsGreen'];
}

/**
 * Returns true when every artifact in `arts` is NOT a debt, excluding any
 * artifact whose path is in `excludePaths`. Used for the allGreen trigger's
 * bootstrap exclusion (the evaluator's own outputs are excluded from the check
 * so that 'all-green except for the evaluator itself' can be true).
 */
function allArtifactsGreen(arts: ArtifactMap, excludePaths: ReadonlySet<string>): boolean {
  for (const [path, a] of arts) {
    if (excludePaths.has(path)) continue;
    if (DEBT_STATES.has(a.acceptance)) return false;
  }
  return true;
}

function isSettledOut(a: ArtifactData): boolean {
  // retracted/skipped members drop out of a set; they don't block a reduce.
  return a.acceptance === 'retracted' || a.acceptance === 'skipped';
}

/** Bare elements (no further suffix) of a collection stem, in index order. */
export function members(arts: ArtifactMap, stem: string): ArtifactData[] {
  const out: ArtifactData[] = [];
  for (const a of arts.values()) if (isMemberOf(stem, a.path)) out.push(a);
  out.sort((x, y) => (parseElement(x.path)?.index ?? 0) - (parseElement(y.path)?.index ?? 0));
  return out;
}

function loopByName(def: WorkflowDef, name: string): LoopDef | undefined {
  return def.loops.find((l) => l.name === name);
}

// ---- required inputs & fingerprints -----------------------------------------

/**
 * The concrete artifact paths `art` must rest on (all green) to legitimately be
 * green. This is the domain of its build fingerprint and the level-trigger's
 * standing check (§12.3). It is derived from the producer loop's consume
 * patterns and the artifact's own role (seal / element / map child / singleton).
 */
export function requiredInputs(def: WorkflowDef, arts: ArtifactMap, art: ArtifactData): string[] {
  const loop = loopByName(def, art.producer);
  if (!loop) return [];
  const plain = plainConsumes(loop).map((c) => c.stem);

  // a seal or a bare collection element rests only on the producer's plain inputs
  if (art.sealOf) return plain;
  const el = parseElement(art.path);
  if (el && el.suffix === '') return plain;

  // a map child (src[i].suffix) rests on its actual consumed per-element input
  // + plain gates. With a bare map consume (`src[$i]`) that input is the bare
  // member; with a suffixed map consume (`src[$i].dossier`, chaining off another
  // map) it is that suffixed child — so a stale dossier cascades to its assets.
  if (el && el.suffix !== '') {
    const mc = mapConsume(loop);
    if (mc) return [mapInputPath(mc, el.index), ...plain];
    return [elementPath(el.stem, el.index), ...plain];
  }

  // a singleton: a reduce output rests on the whole live set + seal; a plain
  // output rests only on its plain inputs
  const rc = reduceConsume(loop);
  if (rc) {
    const live = members(arts, rc.stem).filter((m) => !isSettledOut(m));
    return [...live.map((m) => m.path), sealPath(rc.stem), ...plain];
  }
  return plain;
}

/** The {path → version} snapshot over a set of input paths. */
export function computeFingerprint(arts: ArtifactMap, paths: readonly string[]): Fingerprint {
  const fp: Fingerprint = {};
  for (const p of paths) fp[p] = arts.get(p)?.version ?? -1;
  return fp;
}

/** Does `fp` exactly match the current versions of `paths` (same keys, same versions)? */
export function fingerprintMatches(
  arts: ArtifactMap,
  paths: readonly string[],
  fp: Fingerprint,
): boolean {
  const keys = Object.keys(fp);
  if (keys.length !== paths.length) return false;
  for (const p of paths) {
    if (!(p in fp)) return false;
    if ((arts.get(p)?.version ?? -1) !== fp[p]) return false;
  }
  return true;
}

// ---- materialization: which owed outputs must exist -------------------------

/**
 * The owed output artifacts that should exist but don't yet. Singletons and
 * collection seals are owed from instance start; a map child becomes owed the
 * moment its bound element greens (dynamic cardinality, §11.1).
 */
export function pendingOwed(def: WorkflowDef, arts: ArtifactMap): ArtifactData[] {
  const out: ArtifactData[] = [];
  const ensure = (path: string, producer: string, sealOf?: string): void => {
    if (arts.has(path)) return;
    if (out.some((o) => o.path === path)) return;
    const a: ArtifactData = {
      workflow: '',
      path,
      producer,
      acceptance: 'owed',
      version: 0,
      reasons: [],
      judgmentRejects: 0,
      schemaRejects: 0,
    };
    if (sealOf) a.sealOf = sealOf;
    out.push(a);
  };

  // D-A: handler loops are dormant at creation — exclude their outputs from normal seeding.
  // A loop H is a handler iff some other loop L declares effect.onInvalidate === H.name.
  const handlerLoopNames = new Set<string>();
  for (const loop of def.loops) {
    const oi = loop.effect?.onInvalidate;
    if (oi && oi !== 'pin' && oi !== 'escalate') handlerLoopNames.add(oi);
  }

  for (const loop of def.loops) {
    if (handlerLoopNames.has(loop.name)) continue; // handler: dormant, skip normal seeding
    const mode = loopMode(loop);
    if (mode === 'map') {
      const mc = mapConsume(loop);
      const mp = mapProduce(loop);
      if (!mc || !mp) continue;
      // the bare members fix the index space; a child is owed only once that
      // index's actual consumed input (bare member, or its suffixed child) greens
      for (const m of members(arts, mc.stem)) {
        const el = parseElement(m.path);
        if (!el) continue;
        if (!isGreen(arts.get(mapInputPath(mc, el.index)))) continue;
        ensure(bindProduce(mp, el.index), loop.name);
      }
    } else {
      for (const p of singletonProduces(loop)) ensure(p.stem, loop.name);
      for (const p of collectionProduces(loop)) ensure(sealPath(p.stem), loop.name, p.stem);
    }
  }
  return out;
}

// ---- eligibility (§3 / §11.4) ------------------------------------------------

/**
 * Returns true if the idle trigger is eligible for this loop.
 * Pure — takes only explicit parameters; no Date, no nowMs.
 *
 * Eligibility: now >= (alarm_at ?? last_progress + idleAfterMs)
 *   AND workflow is NOT done (has debts excluding evaluator outputs)
 *   AND no run is in-flight for this loop
 */
function idleEligible(
  loop: LoopDef,
  arts: ArtifactMap,
  time: TimeFacts,
): boolean {
  const { now, lastProgressMs, inFlight, alarms } = time;
  if (inFlight) return false; // R12: in-flight ≠ idle

  const idleAfterMs = loop.idleAfterMs!; // validated: idle requires idleAfter
  const alarmAt = alarms.get(loop.name);
  const threshold = alarmAt ?? (lastProgressMs + idleAfterMs);
  if (now < threshold) return false;

  // Compute evaluator's own outputs to exclude from all-green check.
  const evaluatorOutputs = new Set<string>(plainOutputs(loop));

  // Not-done gate: idle fires only when there ARE non-evaluator debts.
  // (If the workflow is all-green → allGreen fires, not idle.)
  const wfAllGreen = allArtifactsGreen(arts, evaluatorOutputs);
  if (wfAllGreen) return false; // allGreen owns this condition

  return true;
}

/**
 * Every firing eligible *right now* — inputs satisfied AND an owed/rejected
 * output to discharge. This is the scheduling gate (§11.4): necessary, not
 * sufficient; the commit fingerprint (§12.2) is the correctness boundary.
 * Assumes `pendingOwed` has already been materialized into `arts`.
 */
export function eligibleFirings(def: WorkflowDef, arts: ArtifactMap, time?: TimeFacts): Firing[] {
  const firings: Firing[] = [];

  for (const loop of def.loops) {
    // M2: calls: loops are machine-handled (PR5b spawns the child); never emit a worker firing.
    if (loop.calls) continue;

    const triggers = resolvedTriggers(loop);
    const hasInputsGreen = triggers.includes('inputsGreen');
    const hasAllGreen = triggers.includes('allGreen');
    const hasIdle = triggers.includes('idle');

    if (hasInputsGreen) {
      const mode = loopMode(loop);
      const plain = plainConsumes(loop);
      const plainPaths = plain.map((c) => c.stem);
      const plainSatisfied = plainPaths.every((p) => isGreen(arts.get(p)));

      if (mode === 'plain') {
        if (plainSatisfied) {
          const outs = plainOutputs(loop).filter((p) => {
            const a = arts.get(p);
            return isDebt(a) && !frozen(a, loop);
          });
          if (outs.length) {
            firings.push({ loop: loop.name, key: '', inputs: plainPaths, outputs: outs });
          }
        }
      } else if (mode === 'map') {
        if (plainSatisfied) {
          const mc = mapConsume(loop);
          const mp = mapProduce(loop);
          if (mc && mp) {
            for (const m of members(arts, mc.stem)) {
              const el = parseElement(m.path);
              if (!el) continue;
              // gate on the actual per-element input: the bare member, or its
              // suffixed child when this map chains off another map's output.
              const inPath = mapInputPath(mc, el.index);
              if (!isGreen(arts.get(inPath))) continue;
              const outPath = bindProduce(mp, el.index);
              const outArt = arts.get(outPath);
              if (!isDebt(outArt) || frozen(outArt, loop)) continue;
              firings.push({
                loop: loop.name,
                key: m.path,
                index: el.index,
                inputs: [inPath, ...plainPaths],
                outputs: [outPath],
              });
            }
          }
        }
      } else {
        // reduce
        const rc = reduceConsume(loop);
        if (rc && plainSatisfied) {
          const seal = arts.get(sealPath(rc.stem));
          if (isGreen(seal)) {
            const mem = members(arts, rc.stem);
            const live = mem.filter((m) => !isSettledOut(m));
            if (!live.some((m) => !isGreen(m))) {
              const outs = singletonProduces(loop)
                .map((p) => p.stem)
                .filter((p) => {
                  const a = arts.get(p);
                  return isDebt(a) && !frozen(a, loop);
                });
              if (outs.length) {
                firings.push({
                  loop: loop.name,
                  key: '',
                  inputs: [...live.map((m) => m.path), sealPath(rc.stem), ...plainPaths],
                  outputs: outs,
                });
              }
            }
          }
        }
      }
    }

    if (hasAllGreen) {
      // Compute the set of output paths this evaluator loop produces.
      // These are excluded from the all-green check (bootstrap exclusion).
      const evaluatorOutputs = new Set<string>(plainOutputs(loop));

      // The workflow is all-green (excluding the evaluator's own outputs).
      const wfAllGreen = allArtifactsGreen(arts, evaluatorOutputs);
      if (wfAllGreen) {
        // Workflow IS all-green. Check if the evaluator still has a debt to discharge.
        const outs = plainOutputs(loop).filter((p) => {
          const a = arts.get(p);
          return isDebt(a) && !frozen(a, loop);
        });
        if (outs.length > 0) {
          firings.push({
            loop: loop.name,
            key: '',
            inputs: [], // allGreen loop has no consumed inputs to fingerprint
            outputs: outs,
            cause: 'allGreen',
          });
        }
      }
    }

    if (hasIdle && time) {
      if (idleEligible(loop, arts, time)) {
        const outs = plainOutputs(loop).filter((p) => {
          const a = arts.get(p);
          return isDebt(a) && !frozen(a, loop);
        });
        if (outs.length > 0) {
          firings.push({
            loop: loop.name,
            key: '',
            inputs: [],
            outputs: outs,
            cause: 'idle',
          });
        }
      }
    }
  }

  return firings;
}

/** The concrete output paths a plain loop drives eligibility from (singletons + seals). */
function plainOutputs(loop: LoopDef): string[] {
  const out: string[] = [];
  for (const p of singletonProduces(loop)) out.push(p.stem);
  for (const p of collectionProduces(loop)) out.push(sealPath(p.stem));
  return out;
}

// ---- level-triggered maintenance (§11.8, §12.3) -----------------------------

/**
 * The standing guard: re-derive the invariant "an artifact is green only while
 * every artifact it directly consumed is green and unmoved" and report the
 * structural ops needed to restore it. Pure — the engine applies the ops and
 * re-runs to a fixpoint. Covers the forward reject cascade, retract/skip
 * tombstoning of map children, skip-propagation down dead branches, and the
 * re-arm of a skipped subtree when its branch revives.
 */
export function maintainDecisions(def: WorkflowDef, arts: ArtifactMap, time?: TimeFacts): CascadeOp[] {
  const ops: CascadeOp[] = [];

  for (const art of arts.values()) {
    if (art.acceptance === 'retracted') continue; // terminal — nothing to maintain

    const el = parseElement(art.path);
    const isMapChild = !!el && el.suffix !== '';

    // A skipped artifact is settled-but-re-armable. It stays skipped while the
    // routing decision that produced it still holds — i.e. while its inputs are
    // unmoved from the fingerprint captured at skip time. It re-arms only when
    // those inputs come back green *and have moved* (the branch was re-decided).
    // Re-arming on "inputs are green" alone would thrash, since the skip itself
    // was made on green inputs (§16.1).
    if (art.acceptance === 'skipped') {
      const req = requiredInputs(def, arts, art);
      const allGreen = req.length > 0 && req.every((p) => isGreen(arts.get(p)));
      const moved = !fingerprintMatches(arts, req, art.fingerprint ?? {});
      if (allGreen && moved) {
        ops.push({ kind: 'rearm', path: art.path, reason: 'branch revived: inputs moved since skip' });
      }
      continue;
    }

    const req = requiredInputs(def, arts, art);
    if (req.length === 0) continue; // a seeded input with no producer-inputs: nothing to rest on

    // the first input that is not green (settled-dead or merely in-flight)
    let offender: ArtifactData | undefined;
    let offenderPath: string | undefined;
    for (const p of req) {
      const dep = arts.get(p);
      if (!isGreen(dep)) {
        offender = dep;
        offenderPath = p;
        break;
      }
    }

    // A non-terminal green is subject to the forward reject cascade: it may only
    // stay green while every input is green *and unmoved* from its build (§11.8).
    if (art.acceptance === 'green' && !art.terminal) {
      const versionsOk = fingerprintMatches(arts, req, art.fingerprint ?? {});
      if (!offender && versionsOk) continue; // invariant holds

      // Dead/settled input: structural cascade (retract or skip). NOT gated by effect:
      // (§17.5 — dead-input cascade for non-idempotent loops is unconditionally structural).
      if (offender && offenderPath) {
        ops.push(cascadeFromDeadInput(art.path, offender, offenderPath, isMapChild));
        continue;
      }

      // All inputs are green but at least one moved (version changed). Route on effect:.
      const moved = req.find((p) => (arts.get(p)?.version ?? -1) !== (art.fingerprint ?? {})[p]);
      const producerLoop = loopByName(def, art.producer);
      const effect = resolvedEffect(producerLoop);

      if (effect.idempotent) {
        // Default (idempotent=true): re-arm as before. No behavior change for existing defs.
        ops.push({ kind: 'reject', path: art.path, reason: `auto-invalidated: ${moved ?? 'an input'} moved version` });
      } else if (effect.onInvalidate === 'pin') {
        // Pin: keep green, re-point fingerprint to current input versions. Producer does not re-fire.
        ops.push({ kind: 'pin', path: art.path, reason: `pinned: ${moved ?? 'an input'} moved; held green per effect.onInvalidate=pin` });
      } else if (effect.onInvalidate !== 'escalate') {
        // Named handler (D-B): pin the original L + arm the handler H.
        // Pin re-points fingerprint so the next pass sees invariant holds (no thrash, D-C).
        ops.push({ kind: 'pin', path: art.path, reason: `pinned: ${moved ?? 'an input'} moved; original kept green, handler '${effect.onInvalidate}' armed` });
        ops.push({ kind: 'arm', handlerLoop: effect.onInvalidate, reason: `handler '${effect.onInvalidate}' armed: L='${art.producer}' artifact pinned on input move` });
      } else {
        // Escalate: reject-and-hold — producer must not auto-fire; surfaces as stalled.
        ops.push({ kind: 'reject', path: art.path, held: true, reason: `held: ${moved ?? 'an input'} moved; irreversible — escalate to human (effect.onInvalidate=escalate)` });
      }
      continue;
    }

    // A debt (owed/rejected) resting on a *settled-dead* input can never be
    // discharged — no producer firing is eligible while the input is non-green,
    // and a retracted/skipped input will not green on its own. Settle it the same
    // way (retract a dead map child terminally; skip a dead-branch dependent,
    // which re-arms if the branch later revives). A debt on a merely in-flight
    // input (owed/rejected) is just blocked, not dead — leave it.
    if (isDebt(art) && offender && offenderPath && isSettledOut(offender)) {
      ops.push(cascadeFromDeadInput(art.path, offender, offenderPath, isMapChild));
    }
  }

  // Terminal-settle invariant (§15.2): once any terminal artifact is green,
  // the instance is sealed — no completion evaluator should re-arm.
  const anyTerminalGreen = [...arts.values()].some(
    (a) => a.acceptance === 'green' && a.terminal === true,
  );

  // allGreen re-arm: a green outcome of an allGreen-triggered loop is re-armed
  // when the workflow is no longer all-green (excluding the evaluator's own outputs).
  // This ensures the evaluator re-fires if the workflow later falls out of done.
  for (const loop of def.loops) {
    const triggers = resolvedTriggers(loop);
    if (!triggers.includes('allGreen')) continue;
    if (anyTerminalGreen) continue; // sealed — terminal artifact already green

    // Compute this evaluator's output paths.
    const evaluatorOutputPaths = plainOutputs(loop);
    const evaluatorOutputSet = new Set<string>(evaluatorOutputPaths);

    // Check workflow all-green status excluding this evaluator's outputs.
    const wfAllGreen = allArtifactsGreen(arts, evaluatorOutputSet);
    if (wfAllGreen) continue; // workflow is all-green — no re-arm needed (stable)

    // Workflow is NOT all-green. Re-arm any green (non-terminal) evaluator output.
    for (const path of evaluatorOutputPaths) {
      const art = arts.get(path);
      if (!art || art.acceptance !== 'green' || art.terminal) continue;
      ops.push({
        kind: 'reject',
        path,
        reason: 'allGreen-rearm: workflow fell out of done — re-evaluating',
      });
    }
  }

  // idle heartbeat re-arm: if an idle evaluator's outcome is green AND the idle
  // threshold has elapsed again (alarm set by the evaluator), re-arm outcome.
  if (time) {
    for (const loop of def.loops) {
      const triggers = resolvedTriggers(loop);
      if (!triggers.includes('idle')) continue;
      if (!idleEligible(loop, arts, time)) continue; // threshold not reached
      if (anyTerminalGreen) continue; // sealed — terminal artifact already green

      const evaluatorOutputPaths = plainOutputs(loop);
      for (const path of evaluatorOutputPaths) {
        const art = arts.get(path);
        if (!art || art.acceptance !== 'green' || art.terminal) continue;
        ops.push({
          kind: 'reject',
          path,
          reason: 'idle-rearm: alarm elapsed again — re-evaluating idle condition',
        });
      }
    }
  }

  return ops;
}

/** Classify the cascade op for an artifact whose input `offender` is non-green. */
function cascadeFromDeadInput(
  path: string,
  offender: ArtifactData,
  offenderPath: string,
  isMapChild: boolean,
): CascadeOp {
  if (offender.acceptance === 'retracted' && isMapChild) {
    return { kind: 'retract', path, reason: `auto-retracted: ${offenderPath} was retracted` };
  }
  if (offender.acceptance === 'skipped') {
    return { kind: 'skip', path, reason: `skipped: ${offenderPath} not taken` };
  }
  return { kind: 'reject', path, reason: `auto-invalidated: ${offenderPath} changed` };
}

// ---- observability (§17) -----------------------------------------------------

export interface Blocker {
  loop: string;
  blockedOn: string[]; // non-green inputs holding the loop back
}

export interface WorkflowStatus {
  done: boolean;
  debts: Array<{
    path: string;
    acceptance: Acceptance;
    kind: 'judgment' | 'structural' | 'validation' | 'unbuilt' | 'invalidated-irreversible';
    /** §6/§18/held: rejected past its producer's cap, or held — the engine won't re-arm it */
    stalled: boolean;
    reason?: string;
    /**
     * Consecutive trailing `failed` runs for this debt's producer (crash-loop
     * signal). Enriched by `engine.status()` from the run log — `workflowStatus`
     * is pure and never sets it. Absent when zero or unknown.
     */
    failedRuns?: number;
    /**
     * Reaper strikes (lease churn) for this step — how many times the task has
     * been reaped and re-armed. Enriched by `engine.status()` from the task row.
     * Absent when zero or unknown.
     */
    attempts?: number;
  }>;
  eligible: Firing[];
  blocked: Blocker[];
}

/** Derive the operator view purely from artifact state (§17) — never stored. */
export function workflowStatus(def: WorkflowDef, arts: ArtifactMap): WorkflowStatus {
  const debts: WorkflowStatus['debts'] = [];
  for (const a of arts.values()) {
    if (!DEBT_STATES.has(a.acceptance)) continue;
    const last = a.reasons[a.reasons.length - 1];
    const kind: 'judgment' | 'structural' | 'validation' | 'unbuilt' | 'invalidated-irreversible' = last
      ? last.kind === 'judgment'
        ? 'judgment'
        : last.kind === 'validation'
          ? 'validation'
          : last.kind === 'invalidated-irreversible'
            ? 'invalidated-irreversible'
            : 'structural'
      : 'unbuilt';
    const prod = loopByName(def, a.producer);
    // Held artifacts (isHeld) surface as stalled: true — they require human intervention.
    const stalled =
      !!prod && (isStalled(a, prod.maxAttempts) || isSchemaStalled(a, prod.maxSchemaFailures) || isHeld(a));
    const entry: WorkflowStatus['debts'][number] = { path: a.path, acceptance: a.acceptance, kind, stalled };
    if (last) entry.reason = last.text;
    debts.push(entry);
  }
  debts.sort((x, y) => x.path.localeCompare(y.path));

  const eligible = eligibleFirings(def, arts);
  const eligibleLoops = new Set(eligible.map((f) => f.loop));

  const blocked: Blocker[] = [];
  for (const loop of def.loops) {
    if (eligibleLoops.has(loop.name)) continue;
    if (!loopOwesSomething(def, loop, arts)) continue; // owes nothing → done, not blocked
    const blockedOn = blockingInputs(def, loop, arts);
    if (blockedOn.length) blocked.push({ loop: loop.name, blockedOn });
  }

  const done = ![...arts.values()].some((a) => DEBT_STATES.has(a.acceptance));
  return { done, debts, eligible, blocked };
}

function loopOwesSomething(def: WorkflowDef, loop: LoopDef, arts: ArtifactMap): boolean {
  const mode = loopMode(loop);
  if (mode === 'map') {
    const mc = mapConsume(loop);
    const mp = mapProduce(loop);
    if (!mc || !mp) return false;
    return members(arts, mc.stem).some((m) => {
      const el = parseElement(m.path);
      return el ? isDebt(arts.get(bindProduce(mp, el.index))) : false;
    });
  }
  return plainOutputs(loop).some((p) => isDebt(arts.get(p)));
}

function blockingInputs(def: WorkflowDef, loop: LoopDef, arts: ArtifactMap): string[] {
  const out: string[] = [];
  for (const c of plainConsumes(loop)) if (!isGreen(arts.get(c.stem))) out.push(c.stem);
  const rc = reduceConsume(loop);
  if (rc) {
    const seal = sealPath(rc.stem);
    if (!isGreen(arts.get(seal))) out.push(seal);
    for (const m of members(arts, rc.stem)) {
      if (!isSettledOut(m) && !isGreen(m)) out.push(m.path);
    }
  }
  // a map child that owes but can't fire is blocked on its per-element input
  // (its bare member, or — for a chained map — the suffixed child upstream owes)
  const mc = mapConsume(loop);
  const mp = mapProduce(loop);
  if (mc && mp) {
    for (const m of members(arts, mc.stem)) {
      const el = parseElement(m.path);
      if (!el) continue;
      if (!isDebt(arts.get(bindProduce(mp, el.index)))) continue;
      const inPath = mapInputPath(mc, el.index);
      if (!isGreen(arts.get(inPath))) out.push(inPath);
    }
  }
  return out;
}

export { SETTLED_STATES };

// ---- invariant evaluation ---------------------------------------------------

/** A trivially-true predicate sentinel for `when` defaulting ({all:[]} = empty AND = true). */
const ALWAYS_TRUE: InvariantPredicate = { all: [] };

/**
 * Pure evaluation of a structured invariant predicate against artifact state.
 * Total — never throws on well-formed (validated) predicates.
 */
export function evalInvariantPredicate(
  pred: InvariantPredicate,
  arts: ReadonlyMap<string, ArtifactData>,
  status: WorkflowStatus,
): boolean {
  if ('path' in pred) {
    const { path, is } = pred;
    if (is === 'present') return arts.has(path);
    if (is === 'absent') return !arts.has(path);
    return arts.get(path)?.acceptance === is;
  }
  if ('state' in pred) return status.done;
  if ('all' in pred) return pred.all.every((p) => evalInvariantPredicate(p, arts, status));
  if ('any' in pred) return pred.any.some((p) => evalInvariantPredicate(p, arts, status));
  return !evalInvariantPredicate(pred.not, arts, status); // 'not'
}

// ---- trace builder (§17 derived temporal view) --------------------------------

/**
 * Build a causal timeline and per-artifact biographies for one workflow
 * instance. Pure — no DB, no clock, no IO. Same purity contract as
 * workflowStatus.
 *
 * Causality gap: a successful run does not append a ReasonEntry and there is
 * no stored FK from an artifact version back to its producing run. The
 * produced→consumed edges are therefore inferred (see WorkflowTrace.inferenceNote),
 * not stored facts. We represent this honestly: producedStems is derived from
 * the def (structural, not temporal) and consumedInputs is from the run
 * fingerprint (a stored fact at claim time).
 */
export function buildTrace(
  def: WorkflowDef,
  artifacts: ReadonlyArray<ArtifactData & { updatedAt?: number }>,
  runs: ReadonlyArray<RunData & { id: string; createdAt: number; updatedAt: number }>,
): WorkflowTrace {
  // --- step 1: build an ArtifactMap for workflowStatus reuse ---
  const artMap: ArtifactMap = new Map(artifacts.map((a) => [a.path, a]));

  // --- step 2: build the loop → producedStems map from the def ---
  // For map loops: the raw produce pattern string (e.g. "gather.source[$i].formatcheck")
  // For collection producers: the collection stem (e.g. "gather.source")
  // For singletons: the stem name (e.g. "plan", "pr")
  const loopProducedStems = new Map<string, string[]>();
  for (const loop of def.loops) {
    const stems: string[] = [];
    for (const p of singletonProduces(loop)) stems.push(p.stem);
    for (const p of collectionProduces(loop)) stems.push(p.stem);
    const mp = mapProduce(loop);
    if (mp) stems.push(mp.raw); // use the raw pattern (e.g. "gather.source[$i].check")
    loopProducedStems.set(loop.name, stems);
  }

  // --- step 3: build the timeline ---
  // Runs are already ordered by (created_at, rowid) from store.listRuns.
  // We re-sort here defensively in case caller passes unsorted input.
  const sortedRuns = [...runs].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id tiebreak (lexicographic, stable)
  });

  const timeline: TimelineEvent[] = sortedRuns.map((run, idx) => ({
    seq: idx + 1,
    at: run.createdAt,
    endedAt: run.updatedAt,
    loop: run.loop,
    key: run.key ?? '',
    outcome: run.outcome,
    summary: run.summary,
    sessionId: run.sessionId,
    consumedInputs: run.fingerprint,
    producedStems: loopProducedStems.get(run.loop) ?? [],
  }));

  // --- step 4: build artifact biographies ---
  // Count actions across all artifact reason threads for the summary.
  let totalRejects = 0;
  let totalRetries = 0;
  const stalledArtifacts: string[] = [];

  const biographies: ArtifactBiography[] = [...artifacts]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((art) => {
      for (const e of art.reasons) {
        if (e.action === 'reject' || e.action === 'born-rejected' || e.action === 'schema-reject') {
          totalRejects++;
        }
        if (e.action === 'retry') totalRetries++;
      }

      // Check stall: need the producer loop's caps
      const producerLoop = def.loops.find((l) => l.name === art.producer);
      if (producerLoop) {
        const stallJ = isStalled(art, producerLoop.maxAttempts);
        const stallS = isSchemaStalled(art, producerLoop.maxSchemaFailures);
        if (stallJ || stallS) stalledArtifacts.push(art.path);
      }

      return {
        path: art.path,
        producer: art.producer,
        terminal: art.terminal ?? false,
        acceptance: art.acceptance,
        version: art.version,
        judgmentRejects: art.judgmentRejects,
        schemaRejects: art.schemaRejects,
        events: art.reasons, // already chronological (append-only thread)
      };
    });

  // --- step 5: summary ---
  const byOutcome: Record<string, number> = {};
  for (const run of sortedRuns) {
    const k = run.outcome ?? 'open';
    byOutcome[k] = (byOutcome[k] ?? 0) + 1;
  }

  const status = workflowStatus(def, artMap);

  return {
    workflow: artifacts[0]?.workflow ?? '',
    timeline,
    artifacts: biographies,
    summary: {
      totalRuns: sortedRuns.length,
      byOutcome,
      totalRejects,
      totalRetries,
      stalledArtifacts,
      done: status.done,
    },
    inferenceNote:
      'producedStems is derived from the workflow definition (structural) and ' +
      'identifies which stems a loop is responsible for, not which version it ' +
      'produced in a specific run. consumedInputs is the run fingerprint (a ' +
      'stored fact at claim time). The causal edge run→artifact-version is an ' +
      'inference: the Nth ok run of loop L corresponds to version N of its ' +
      "output stems. This is a heuristic — no stored FK exists (by design, " +
      "to avoid schema changes).",
  };
}

// ---- graph builder (§spatial view: wiring + live-state overlay) ---------------

/**
 * Build a structural wiring graph for a workflow definition.
 * When `artifacts` are provided, annotate each node with the live acceptance
 * state derived from the artifact set (overlay mode).
 *
 * Pure — no IO, no clock, no DB. Same purity contract as buildTrace.
 *
 * Edge derivation replicates validateDef's producerOf map exactly:
 *   inputs → input node id (= input name)
 *   singleton/collection produces → the loop that produces them
 *   map produces (per-element) are NOT registered in producerOf —
 *     they live under the collection they annotate
 *
 * A dangling consume (nothing produces the stem) yields an edge with
 * from = '__dangling__' + stem — it renders visually (shows the missing
 * wiring) and never crashes. This can only occur on an invalid def that
 * lint already errors on; graph never validates.
 */
export function buildGraph(
  def: WorkflowDef,
  artifacts?: ReadonlyArray<ArtifactData>,
): WorkflowGraph {
  // --- 1. Build producerOf exactly as validateDef does ---
  const producerOf = new Map<string, string>(); // stem → node id (input name or loop name)
  const collectionStems = new Set<string>();

  for (const inp of def.inputs) {
    producerOf.set(inp.name, inp.name); // input node id = input name
  }
  for (const l of def.loops) {
    for (const p of l.produces) {
      if (p.kind === 'collection') {
        collectionStems.add(p.stem);
        if (!producerOf.has(p.stem)) producerOf.set(p.stem, l.name);
      } else if (p.kind === 'singleton') {
        if (!producerOf.has(p.stem)) producerOf.set(p.stem, l.name);
      }
      // map produces (p.kind === 'map') are per-element children; not registered
    }
  }

  // --- 2. Build nodes ---
  const nodes: GraphNode[] = [];

  // Input nodes
  for (const inp of def.inputs) {
    nodes.push({ id: inp.name, kind: 'input', label: inp.name });
  }

  // Loop nodes — overlay state computed below
  for (const l of def.loops) {
    const node: GraphNode = {
      id: l.name,
      kind: 'loop',
      label: l.name,
    };
    if (l.terminal) node.terminal = true;
    if (l.parallel !== undefined) node.parallel = l.parallel;
    if (l.model !== undefined) node.model = l.model;
    nodes.push(node);
  }

  // --- 3. Build edges ---
  const edges: GraphEdge[] = [];

  for (const l of def.loops) {
    for (const c of l.consumes) {
      // Resolve producer: look up c.stem in producerOf
      const producerNode = producerOf.get(c.stem) ?? `__dangling__${c.stem}`;

      // Skip self-edges (should never occur in a valid def, but guard gracefully)
      if (producerNode === l.name) continue;

      const edge: GraphEdge = {
        from: producerNode,
        to: l.name,
        stem: c.stem,
        mode: c.mode,
      };
      if (c.binder !== undefined) edge.binder = c.binder;
      edges.push(edge);
    }
  }

  // --- 4. Overlay: annotate nodes with live artifact state ---
  const hasOverlay = artifacts !== undefined && artifacts.length > 0;
  if (artifacts && artifacts.length > 0) {
    // Build a loop name → LoopDef map for cap lookup
    const loopMap = new Map<string, LoopDef>(def.loops.map((l) => [l.name, l]));
    // Build a set of input names for membership test
    const inputNames = new Set<string>(def.inputs.map((i) => i.name));

    // Group artifacts for node lookup:
    //   - loop nodes:  match by a.producer (= loop name)
    //   - input nodes: match by a.path (= input name), since inputs have producer = 'human'
    const byProducer = new Map<string, ArtifactData[]>();
    const byPath = new Map<string, ArtifactData>();
    for (const a of artifacts) {
      const existing = byProducer.get(a.producer) ?? [];
      existing.push(a);
      byProducer.set(a.producer, existing);
      byPath.set(a.path, a);
    }

    for (const node of nodes) {
      // For input nodes, look up by path; for loop nodes, look up by producer name.
      const nodeArts: ArtifactData[] =
        node.kind === 'input'
          ? (inputNames.has(node.id) && byPath.has(node.id) ? [byPath.get(node.id)!] : [])
          : (byProducer.get(node.id) ?? []);
      if (nodeArts.length === 0) {
        node.state = 'none';
        continue;
      }

      const loop = loopMap.get(node.id);
      const maxAttempts = loop?.maxAttempts ?? 3;
      const maxSchema = loop?.maxSchemaFailures ?? 5;

      // Determine worst-state using priority: stalled > rejected > owed > skipped/retracted > green
      let worstState: GraphNodeState = 'green';
      let anyStalled = false;

      for (const a of nodeArts) {
        const stallJ = isStalled(a, maxAttempts);
        const stallS = isSchemaStalled(a, maxSchema);
        if (stallJ || stallS) {
          anyStalled = true;
          worstState = 'stalled';
          break; // stalled is the worst; short-circuit
        }
      }

      if (!anyStalled) {
        for (const a of nodeArts) {
          if (a.acceptance === 'rejected') {
            worstState = 'rejected';
            break;
          }
        }
        if (worstState !== 'rejected') {
          for (const a of nodeArts) {
            if (a.acceptance === 'owed') {
              worstState = 'owed';
              break;
            }
          }
          if (worstState !== 'owed') {
            const allSkipped = nodeArts.every((a) => a.acceptance === 'skipped');
            const allRetracted = nodeArts.every((a) => a.acceptance === 'retracted');
            if (allSkipped) worstState = 'skipped';
            else if (allRetracted) worstState = 'retracted';
            // else: all green
          }
        }
      }

      node.state = worstState;
      if (anyStalled) node.stalled = true;
    }
  }

  // --- 5. Sort for determinism ---
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => {
    const f = a.from.localeCompare(b.from);
    if (f !== 0) return f;
    const t = a.to.localeCompare(b.to);
    if (t !== 0) return t;
    return a.stem.localeCompare(b.stem);
  });

  return { def: def.name, nodes, edges, hasOverlay };
}

// ---- graph renderers ----------------------------------------------------------

const STATE_FILL_COLORS: Record<string, string> = {
  green: '#c8e6c9',
  owed: '#e0e0e0',
  rejected: '#ffcc80',
  stalled: '#ef9a9a',
  skipped: '#f5f5f5',
  retracted: '#eeeeee',
};

function dotEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Render a WorkflowGraph as a Graphviz DOT string.
 * Pure — no IO, no side effects. Deterministic (nodes/edges already sorted).
 */
export function graphToDot(g: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push(`digraph "${dotEscape(g.def)}" {`);
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Helvetica"];');
  lines.push('');

  // Collect dangling node ids from edges
  const danglingIds = new Set(
    g.edges
      .filter((e) => e.from.startsWith('__dangling__'))
      .map((e) => e.from),
  );

  // Emit dangling phantom nodes (before real nodes)
  for (const id of [...danglingIds].sort()) {
    const stem = id.slice('__dangling__'.length);
    lines.push(`  "${dotEscape(id)}" [label="(missing: ${dotEscape(stem)})", shape=plaintext, color=red];`);
  }

  // Emit real nodes
  for (const node of g.nodes) {
    const shape =
      node.kind === 'input' ? 'ellipse' : node.terminal ? 'doublecircle' : 'box';
    const attrs: string[] = [`shape=${shape}`, `label="${dotEscape(node.label)}"`];
    if (g.hasOverlay && node.state && node.state !== 'none') {
      const fillcolor = STATE_FILL_COLORS[node.state];
      const style =
        node.state === 'skipped' || node.state === 'retracted'
          ? '"filled,dashed"'
          : 'filled';
      attrs.push(`style=${style}`);
      if (fillcolor) attrs.push(`fillcolor="${fillcolor}"`);
    }
    lines.push(`  "${dotEscape(node.id)}" [${attrs.join(', ')}];`);
  }

  lines.push('');

  // Emit edges
  for (const edge of g.edges) {
    const edgeAttrs: string[] = [];
    if (edge.mode === 'map') {
      edgeAttrs.push(`label="map [${dotEscape(edge.binder ?? '$i')}]"`);
      edgeAttrs.push('style=dashed');
    } else if (edge.mode === 'reduce') {
      edgeAttrs.push('label="reduce [*]"');
      edgeAttrs.push('style=bold');
    } else {
      edgeAttrs.push('style=solid');
    }
    const attrStr = edgeAttrs.length ? ` [${edgeAttrs.join(', ')}]` : '';
    lines.push(`  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}"${attrStr};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function mmdSafeId(id: string): string {
  if (id.startsWith('__dangling__')) {
    return 'dangling_' + id.slice('__dangling__'.length).replace(/[^a-zA-Z0-9]/g, '_');
  }
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function mmdEscape(s: string): string {
  return s.replace(/"/g, '#quot;');
}

/**
 * Render a WorkflowGraph as a Mermaid flowchart string.
 * Pure — no IO, no side effects. Deterministic (nodes/edges already sorted).
 */
export function graphToMermaid(g: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push('flowchart LR');

  // Collect dangling ids
  const danglingIds = new Set(
    g.edges.filter((e) => e.from.startsWith('__dangling__')).map((e) => e.from),
  );

  // Emit dangling phantom nodes
  for (const id of [...danglingIds].sort()) {
    const stem = id.slice('__dangling__'.length);
    const mid = mmdSafeId(id);
    lines.push(`  ${mid}["(missing: ${mmdEscape(stem)})"]`);
    lines.push(`  style ${mid} stroke:red`);
  }

  // Emit real nodes
  for (const node of g.nodes) {
    const mid = mmdSafeId(node.id);
    const lbl = mmdEscape(node.label);
    if (node.kind === 'input') {
      lines.push(`  ${mid}(("${lbl}"))`);
    } else if (node.terminal) {
      lines.push(`  ${mid}(["${lbl}"])`);
    } else {
      lines.push(`  ${mid}["${lbl}"]`);
    }
  }

  lines.push('');

  // Emit classDefs (only when overlay present)
  if (g.hasOverlay) {
    lines.push('  classDef green fill:#c8e6c9,stroke:#333;');
    lines.push('  classDef owed fill:#e0e0e0,stroke:#333;');
    lines.push('  classDef rejected fill:#ffcc80,stroke:#333;');
    lines.push('  classDef stalled fill:#ef9a9a,stroke:#333;');
    lines.push('  classDef skipped fill:#f5f5f5,stroke:#333,stroke-dasharray:5 5;');
    lines.push('  classDef retracted fill:#eeeeee,stroke:#333,stroke-dasharray:5 5;');
    lines.push('');
  }

  // Emit edges
  for (const edge of g.edges) {
    const from = mmdSafeId(edge.from);
    const to = mmdSafeId(edge.to);
    if (edge.mode === 'map') {
      lines.push(`  ${from} -->|"map [${mmdEscape(edge.binder ?? '$i')}]"| ${to}`);
    } else if (edge.mode === 'reduce') {
      lines.push(`  ${from} -->|"reduce [*]"| ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  lines.push('');

  // Emit class assignments
  if (g.hasOverlay) {
    for (const node of g.nodes) {
      if (node.state && node.state !== 'none') {
        lines.push(`  class ${mmdSafeId(node.id)} ${node.state}`);
      }
    }
  }

  return lines.join('\n');
}

// ---- model checker (§check) ---------------------------------------------------
//
// A pure bounded BFS over the workflow state space. No store, no engine, no IO.
// A differential conformance test (test/check.test.ts) pins settleInMemory and
// applyOutcome to the real Engine field-by-field.

/**
 * Internal helper — mirrors Engine.applyOp field-spread EXACTLY.
 * The `reasons` thread is NOT maintained (irrelevant to reachability).
 * born-rejected (CAS race) omitted — single-threaded exploration.
 */
function applyOpInMemory(
  arts: Map<string, ArtifactData>,
  def: WorkflowDef,
  op: CascadeOp,
): void {
  if (op.kind === 'arm') {
    // Arm the handler: materialize each of its singleton/collection outputs as owed
    // if absent, or re-arm to owed if currently green (re-invalidation, D-C re-arm).
    const handlerLoop = def.loops.find((l) => l.name === op.handlerLoop);
    if (!handlerLoop) return;
    for (const p of handlerLoop.produces.filter((pp) => pp.kind === 'singleton')) {
      const existing = arts.get(p.stem);
      if (!existing) {
        arts.set(p.stem, {
          workflow: '',
          path: p.stem,
          producer: handlerLoop.name,
          acceptance: 'owed',
          version: 0,
          reasons: [],
          judgmentRejects: 0,
          schemaRejects: 0,
        });
      } else if (existing.acceptance === 'green') {
        // Re-invalidation: H already fired once; re-arm it.
        arts.set(p.stem, { ...existing, acceptance: 'owed' });
      }
      // If owed or rejected already, no change needed (already a debt).
    }
    // Collection seals: same pattern on sealPath(stem).
    for (const p of handlerLoop.produces.filter((pp) => pp.kind === 'collection')) {
      const sealKey = p.stem + '.sealed';
      const existing = arts.get(sealKey);
      if (!existing) {
        arts.set(sealKey, {
          workflow: '',
          path: sealKey,
          producer: handlerLoop.name,
          acceptance: 'owed',
          version: 0,
          reasons: [],
          judgmentRejects: 0,
          schemaRejects: 0,
          sealOf: p.stem,
        });
      } else if (existing.acceptance === 'green') {
        arts.set(sealKey, { ...existing, acceptance: 'owed' });
      }
    }
    return;
  }
  const art = arts.get(op.path);
  if (!art) return;
  if (op.kind === 'rearm') {
    // mirrors Engine.applyOp rearm branch: acceptance → 'owed'
    arts.set(op.path, { ...art, acceptance: 'owed' });
    return;
  }
  if (op.kind === 'skip') {
    // mirrors Engine.applyOp skip branch: acceptance → 'skipped' + fingerprint
    arts.set(op.path, {
      ...art,
      acceptance: 'skipped',
      fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)),
    });
    return;
  }
  if (op.kind === 'pin') {
    // Pin: artifact stays green; fingerprint re-pointed to current input versions.
    // Does NOT change acceptance, does NOT bump version, does NOT reset stall counters.
    const req = requiredInputs(def, arts, art);
    arts.set(op.path, {
      ...art,
      fingerprint: computeFingerprint(arts, req),
      reasons: [
        ...art.reasons,
        {
          // E-PURITY: the pure in-memory twin (applyOpInMemory / settleInMemory) must not
          // read wall-clock time.  reason.at is non-semantic in the model layer — the
          // conformance test compares cascade state (acceptance/version/fingerprint), not
          // reasons — so a deterministic sentinel (0) keeps model.ts clock-free.
          at: 0,
          action: 'pinned',
          kind: 'structural',
          by: 'engine',
          text: op.reason,
          fromVersion: art.version,
        },
      ],
    });
    return;
  }
  // reject and retract
  const acceptance: Acceptance = op.kind === 'reject' ? 'rejected' : 'retracted';
  const newArt: ArtifactData = { ...art, acceptance };
  if (op.kind === 'reject' && op.held) {
    // Append a reason entry with kind='invalidated-irreversible' to mark this as held.
    // The held condition is detected by isHeld() via the last reasons entry's kind.
    newArt.reasons = [
      ...art.reasons,
      {
        // E-PURITY sentinel — same reasoning as the pin case above: reason.at is
        // non-semantic in the model layer; 0 keeps model.ts clock-free.
        at: 0,
        action: 'reject',
        kind: 'invalidated-irreversible',
        by: 'engine',
        text: op.reason,
        fromVersion: art.version,
      },
    ];
  }
  arts.set(op.path, newArt);
}

/**
 * Pure in-memory fixpoint: mirror Engine.settle() without any store or IO.
 * Clones `arts`, materializes pendingOwed, applies every maintainDecisions op,
 * repeats until no more changes. Throws on non-convergence (>1000 iterations),
 * matching the engine's guard. The conformance test pins this to the real Engine.
 */
export function settleInMemory(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
): Map<string, ArtifactData> {
  const limit = 1000;
  for (let i = 0; i < limit; i++) {
    const owed = pendingOwed(def, arts);
    for (const a of owed) arts.set(a.path, a);

    const ops = maintainDecisions(def, arts);
    if (owed.length === 0 && ops.length === 0) return arts;
    for (const op of ops) {
      applyOpInMemory(arts, def, op);
    }
  }
  throw new Error(`settleInMemory did not converge (possible cascade cycle)`);
}

/** Internal: seed the initial artifact map exactly as Engine.createInstance does. */
function seedArts(def: WorkflowDef): Map<string, ArtifactData> {
  const arts = new Map<string, ArtifactData>();
  for (const input of def.inputs) {
    // seedOwed=false → seed green (version 1); seedOwed=true → seed owed (version 0)
    // The checker has no runtime `provide` values, so seedOwed inputs start owed.
    const seedGreen = !input.seedOwed;
    arts.set(input.name, {
      workflow: '',
      path: input.name,
      producer: input.producer,
      acceptance: seedGreen ? 'green' : 'owed',
      version: seedGreen ? 1 : 0,
      reasons: [],
      judgmentRejects: 0,
      schemaRejects: 0,
    });
  }
  return settleInMemory(def, arts);
}

/** Internal: the eligible outcomes for a given firing. */
function eligibleOutcomes(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
  firing: Firing,
): CheckStep['outcome'][] {
  const loop = def.loops.find((l) => l.name === firing.loop);
  if (!loop) return ['green'];
  const stem = collectionStem(loop);
  const outPath = firing.outputs[0] ?? '';
  const el = parseElement(outPath);
  const isMember = !!el && el.suffix === '';

  const outcomes: CheckStep['outcome'][] = [];
  if (stem && !el) {
    // collection producer (plain loop with collection output) — emit-seal path
    outcomes.push('emit-seal');
    return outcomes;
  }

  outcomes.push('green');

  // judgment-reject is only valid when the firing has at least one consumed input
  // from a loop producer (not 'human'). A loop can only invalidate artifacts it
  // didn't originally seed — rejecting a human-provided input is not modeled here
  // (the engine's assertAuthority enforces this at runtime).
  const hasRejectableInput = firing.inputs.some((p) => {
    const a = arts.get(p);
    return a && a.producer !== 'human' && a.acceptance === 'green';
  });
  if (hasRejectableInput) {
    outcomes.push('judgment-reject');
  }

  outcomes.push('schema-reject');
  // skip is valid for any non-retracted output (producer can route dead branch)
  outcomes.push('skip');
  // retract only for bare collection members
  if (isMember) outcomes.push('retract');
  return outcomes;
}

/** Internal: emit-seal branches — one map per element count 0..maxCollectionSize. */
function applyEmitSeal(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
  firing: Firing,
  maxCollectionSize: number,
): Array<Map<string, ArtifactData>> {
  const loop = def.loops.find((l) => l.name === firing.loop);
  if (!loop) return [];
  const stem = collectionStem(loop);
  if (!stem) return [];
  const sealP = sealPath(stem);
  const sealArt = arts.get(sealP);
  if (!sealArt) return [];

  const fp = computeFingerprint(arts, firing.inputs);
  const results: Array<Map<string, ArtifactData>> = [];

  for (let count = 0; count <= maxCollectionSize; count++) {
    const next = new Map(arts);
    // determine starting index from existing members
    let nextIdx = 0;
    for (const a of arts.values()) {
      const el = parseElement(a.path);
      if (el && el.stem === stem && el.suffix === '') nextIdx = Math.max(nextIdx, el.index + 1);
    }
    for (let j = 0; j < count; j++) {
      const p = elementPath(stem, nextIdx + j);
      next.set(p, {
        workflow: '',
        path: p,
        producer: firing.loop,
        acceptance: 'green',
        version: 1,
        fingerprint: fp,
        reasons: [],
        judgmentRejects: 0,
        schemaRejects: 0,
      });
    }
    // seal it
    next.set(sealP, {
      ...sealArt,
      acceptance: 'green',
      version: sealArt.version + 1,
      fingerprint: fp,
    });
    results.push(settleInMemory(def, next));
  }
  return results;
}

/**
 * Given a firing and a nondeterministic outcome, produce the post-commit
 * in-memory state (cloned from arts) then run settleInMemory.
 *
 * Outcomes modeled (single-threaded; born-rejected CAS races omitted):
 *   'green'           — singleton/map output: acceptance green, version+1,
 *                       fingerprint = computeFingerprint(arts, firing.inputs)
 *   'judgment-reject' — reject the primary consumed input (the green artifact
 *                       the loop consumes that it has authority to invalidate),
 *                       bumping judgmentRejects+1
 *   'schema-reject'   — acceptance rejected, schemaRejects+1 on the output
 *   'skip'            — acceptance skipped + fingerprint of requiredInputs
 *   'retract'         — acceptance retracted (collection member only)
 *   'emit-seal'       — collection producer: emit 1..maxCollectionSize green elements,
 *                       then seal; forks into (maxCollectionSize+1) successor states
 *
 * Returns an array of successor states (>1 only for emit-seal). Each successor
 * is already settled.
 */
export function applyOutcome(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
  firing: Firing,
  outcome: CheckStep['outcome'],
  opts: { maxCollectionSize: number },
): Array<Map<string, ArtifactData>> {
  // emit-seal branches: return one map per element count 0..maxCollectionSize
  if (outcome === 'emit-seal') {
    return applyEmitSeal(def, arts, firing, opts.maxCollectionSize);
  }

  // all other outcomes: single successor
  const next = new Map(arts);
  const outPath = firing.outputs[0];

  if (outcome === 'judgment-reject') {
    // judgment-reject is a CONSUMER action on a CONSUMED artifact, not on the output.
    // Identify the "reject target" — the primary consumed artifact that this
    // firing loop can invalidate. This is the first input that has a loop producer
    // (not 'human') and is currently green. If no such input exists, this outcome
    // is a no-op (eligibleOutcomes guards against this case).
    const rejectTarget = firing.inputs.find((p) => {
      const a = next.get(p);
      return a && a.producer !== 'human' && a.acceptance === 'green';
    });

    if (rejectTarget !== undefined) {
      const targetArt = next.get(rejectTarget);
      if (targetArt) {
        next.set(rejectTarget, {
          ...targetArt,
          acceptance: 'rejected',
          judgmentRejects: targetArt.judgmentRejects + 1,
        });
      }
    }
    return [settleInMemory(def, next)];
  }

  if (!outPath) return [settleInMemory(def, next)];
  const art = next.get(outPath);
  if (!art) return [settleInMemory(def, next)];

  const loop = def.loops.find((l) => l.name === firing.loop);

  if (outcome === 'green') {
    const fp = computeFingerprint(arts, firing.inputs);
    const updated: ArtifactData = {
      ...art,
      acceptance: 'green',
      version: art.version + 1,
      fingerprint: fp,
    };
    if (loop?.terminal) updated.terminal = true;
    next.set(outPath, updated);
  } else if (outcome === 'schema-reject') {
    next.set(outPath, {
      ...art,
      acceptance: 'rejected',
      schemaRejects: art.schemaRejects + 1,
    });
  } else if (outcome === 'skip') {
    next.set(outPath, {
      ...art,
      acceptance: 'skipped',
      fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)),
    });
  } else if (outcome === 'retract') {
    next.set(outPath, { ...art, acceptance: 'retracted' });
  }

  return [settleInMemory(def, next)];
}

/**
 * Canonical key for a state map — used by the BFS visited-set.
 *
 * Normalization rules (so equivalent states deduplicate):
 *   acceptance: stored as-is (5 values)
 *   version: NORMALIZED to rank:
 *     0 = never-green (version 0, acceptance != green)
 *     1 = currently green (version >= 1, acceptance == green)
 *     2 = was-green-now-moved (version >= 1, acceptance != green)
 *   judgmentRejects: BUCKETED to min(count, maxAttempts) so that e.g. 0, 1, 2
 *     are distinct but anything >= cap is the same (frozen state)
 *   schemaRejects: BUCKETED to min(count, maxSchemaFailures) similarly
 *
 * For 'skipped' artifacts, the fingerprint is encoded as sorted "inputPath:versionRank"
 * pairs to capture rearm eligibility correctly.
 */
function canonicalKey(def: WorkflowDef, arts: Map<string, ArtifactData>): string {
  const parts: string[] = [];
  const loopMap = new Map(def.loops.map((l) => [l.name, l]));

  for (const [path, art] of [...arts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const loop = loopMap.get(art.producer);
    const maxAttempts = loop?.maxAttempts ?? 3;
    const maxSchema = loop?.maxSchemaFailures ?? 5;

    const vRank = art.version === 0 ? 0 : art.acceptance === 'green' ? 1 : 2;
    const jBucket = Math.min(art.judgmentRejects, maxAttempts);
    const sBucket = Math.min(art.schemaRejects, maxSchema);

    let entry = `${path}:${art.acceptance}:${vRank}:${jBucket}:${sBucket}`;

    // For skipped: encode fingerprint as sorted "fPath:fRank" pairs
    if (art.acceptance === 'skipped' && art.fingerprint) {
      const fpParts = Object.entries(art.fingerprint)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => {
          const dep = arts.get(k);
          const depRank = v === 0 ? 0 : dep?.acceptance === 'green' ? 1 : 2;
          return `${k}@${depRank}`;
        })
        .join(',');
      entry += `|fp:${fpParts}`;
    }
    parts.push(entry);
  }
  return parts.join(';');
}

/**
 * Bounded reachability / liveness checker over a workflow definition.
 *
 * Explores the full (or depth/state-bounded) state space via BFS to find:
 * - deadlocks: reachable states that are not done and have no eligible firings
 * - stuck states: reachable states with a stalled debt
 * - completability: whether any reachable state is done (with an example path)
 * - dead loops: loops whose name never appears as a firing in any explored transition
 *
 * Pure — no store, no engine, no IO.
 */
export function modelCheck(def: WorkflowDef, opts: CheckOptions = {}): CheckReport {
  const maxDepth = opts.maxDepth ?? 50;
  const maxStates = opts.maxStates ?? 5000;
  const maxCollectionSize = opts.maxCollectionSize ?? 2;

  const initial = seedArts(def);
  const initialKey = canonicalKey(def, initial);

  type StateNode = {
    arts: Map<string, ArtifactData>;
    path: CheckStep[];
    depth: number;
  };

  const visited = new Map<string, CheckStep[]>(); // key → path to reach it
  visited.set(initialKey, []);
  const queue: StateNode[] = [{ arts: initial, path: [], depth: 0 }];

  const report: CheckReport = {
    def: def.name,
    bounded: false,
    boundsHit: [],
    deadlocks: [],
    stuck: [],
    completable: false,
    completePath: undefined,
    deadLoops: [],
    invariantViolations: [],
    stats: { statesExplored: 0, depthReached: 0 },
  };

  /** Invariant names already recorded (BFS → first hit is the shortest path). */
  const reportedInvariants = new Set<string>();
  const firedLoops = new Set<string>();
  let depthReached = 0;
  const boundsHit = new Set<'maxDepth' | 'maxStates'>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    report.stats.statesExplored++;
    if (node.depth > depthReached) depthReached = node.depth;

    const status = workflowStatus(def, node.arts);

    // ---- invariant checking -------------------------------------------------
    // A state violates an invariant iff eval(when ?? ALWAYS_TRUE) && !eval(requires).
    // Checked BEFORE the `done` continue so terminal properties ("when done,
    // merge must be green") are verified.
    //
    // Soundness under bounds: a reported counterexample path was produced by real
    // applyOutcome/settleInMemory transitions (the same transitions the conformance
    // test pins to the live Engine). Bounds only cause MISSES, never fabrications —
    // which is why invariant violations exit non-zero even when bounded (unlike
    // deadlocks/stuck, which the maxCollectionSize cap can spuriously manufacture).
    if (def.invariants) {
      for (const inv of def.invariants) {
        if (reportedInvariants.has(inv.name)) continue;
        const whenHolds = evalInvariantPredicate(inv.when ?? ALWAYS_TRUE, node.arts, status);
        if (whenHolds && !evalInvariantPredicate(inv.requires, node.arts, status)) {
          report.invariantViolations.push({ invariant: inv.name, path: node.path });
          reportedInvariants.add(inv.name);
        }
      }
    }
    // -------------------------------------------------------------------------

    // Check done
    if (status.done) {
      if (!report.completable) {
        report.completable = true;
        report.completePath = node.path;
      }
      continue; // done states have no successors
    }

    // Check stuck (any debt.stalled)
    if (status.debts.some((d) => d.stalled)) {
      report.stuck.push({ path: node.path });
      // continue exploring (there may be other paths)
    }

    const firings = status.eligible;

    // Check deadlock: non-done, no eligible firings
    if (firings.length === 0 && !status.done) {
      report.deadlocks.push({ path: node.path });
      continue;
    }

    // Respect maxDepth
    if (node.depth >= maxDepth) {
      boundsHit.add('maxDepth');
      continue;
    }

    // Expand successors
    outer: for (const firing of firings) {
      firedLoops.add(firing.loop);
      const outcomes = eligibleOutcomes(def, node.arts, firing);

      for (const outcome of outcomes) {
        // Check state count before expanding
        if (visited.size >= maxStates) {
          boundsHit.add('maxStates');
          break outer;
        }

        const step: CheckStep = { loop: firing.loop, key: firing.key, outcome };
        const successors = applyOutcome(def, node.arts, firing, outcome, { maxCollectionSize });

        for (const suc of successors) {
          const key = canonicalKey(def, suc);
          if (!visited.has(key)) {
            const newPath = [...node.path, step];
            visited.set(key, newPath);
            queue.push({ arts: suc, path: newPath, depth: node.depth + 1 });
          }
        }
      }
    }
    if (boundsHit.has('maxStates')) break;
  }

  report.stats.depthReached = depthReached;
  report.boundsHit = [...boundsHit];
  report.bounded = boundsHit.size > 0;

  // Dead loops: loops in the def that never appeared as a firing.loop
  report.deadLoops = def.loops
    .filter((l) => !firedLoops.has(l.name))
    .map((l) => l.name);

  return report;
}
