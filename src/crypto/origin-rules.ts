/**
 * Pure namespace-scoped origin-rule parsing and evaluation.
 *
 * A rule is a minimum provenance strength. The namespace is one flat coordinate
 * component, so matching uses exact keys and ordered prefixes rather than a
 * general path-glob implementation. This module performs no filesystem,
 * settings, or network I/O.
 */

import type { OriginVerdict } from './verify-origin.ts';
import type { DefPolicy } from './verify-publication.ts';

/** The local policy vocabulary used for origin-rule enforcement. */
export type OriginPolicy = DefPolicy;

/** The accepted minimum provenance strengths for one namespace rule. */
export type OriginRuleValue = 'git' | 'console' | 'agent' | 'any';

/** A parsed namespace-to-minimum-strength map. */
export type OriginRules = Readonly<Record<string, OriginRuleValue>>;

/** A named configuration error for malformed origin rules. */
export class OriginRulesError extends Error {
  readonly code = 'origin-rules-invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'OriginRulesError';
  }
}

/** Provenance strength ordering. A git origin is strongest. */
export const ORIGIN_SOURCE_RANK: Readonly<Record<'git' | 'console' | 'agent', number>> = Object.freeze({
  git: 3,
  console: 2,
  agent: 1,
});

/** The rule selected for one recovered namespace. */
export interface OriginRuleMatch {
  /** The original settings key that selected the rule. */
  key: string;
  /** The minimum provenance strength required by the selected rule. */
  value: OriginRuleValue;
}

/** The result of evaluating one origin verdict against one selected rule. */
export type OriginRuleEvaluation =
  | { ok: true }
  | {
      ok: false;
      kind: 'absent' | 'unverifiable' | 'invalid' | 'weaker';
      detail: string;
    };

interface NormalizedRule {
  key: string;
  value: OriginRuleValue;
  pattern: string;
  exact: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRuleKey(key: string): { pattern: string; exact: boolean } {
  if (key.length === 0) {
    throw new OriginRulesError("invalid originRules key '': the namespace key must not be empty");
  }
  if (/\p{Cc}/u.test(key)) {
    throw new OriginRulesError(`invalid originRules key ${JSON.stringify(key)}: control characters are not allowed`);
  }

  // The specification's namespace/name spelling is accepted as sugar. Rules
  // are evaluated only against the namespace, so the trailing name wildcard
  // disappears before exact/prefix selection.
  const withoutNameSugar = key.endsWith('/*') ? key.slice(0, -2) : key;
  if (withoutNameSugar.length === 0) {
    throw new OriginRulesError(`invalid originRules key ${JSON.stringify(key)}: the namespace key must not be empty`);
  }
  if (withoutNameSugar.includes('/')) {
    throw new OriginRulesError(`invalid originRules key ${JSON.stringify(key)}: only a trailing '/*' is allowed`);
  }
  if (/[?\[]/.test(withoutNameSugar)) {
    throw new OriginRulesError(`invalid originRules key ${JSON.stringify(key)}: '?', and '[' are not supported`);
  }

  if (withoutNameSugar === '*') return { pattern: '', exact: false };
  if (withoutNameSugar.includes('*') && !withoutNameSugar.endsWith('*')) {
    throw new OriginRulesError(`invalid originRules key ${JSON.stringify(key)}: '*' is only allowed at the end`);
  }
  if (withoutNameSugar.endsWith('*')) {
    const pattern = withoutNameSugar.slice(0, -1);
    if (pattern.includes('*')) {
      throw new OriginRulesError(`invalid originRules key ${JSON.stringify(key)}: repeated '*' is not supported`);
    }
    return { pattern, exact: false };
  }
  return { pattern: withoutNameSugar, exact: true };
}

function normalizedRules(rules: OriginRules): NormalizedRule[] {
  if (!isPlainObject(rules)) {
    throw new OriginRulesError('originRules must be a JSON object mapping namespace keys to git, console, agent, or any');
  }

  const normalized: NormalizedRule[] = [];
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(rules)) {
    if (value !== 'git' && value !== 'console' && value !== 'agent' && value !== 'any') {
      throw new OriginRulesError(
        `invalid originRules value for key ${JSON.stringify(key)}: expected 'git', 'console', 'agent', or 'any', got ${JSON.stringify(value)}`,
      );
    }
    const shape = normalizeRuleKey(key);
    const identity = `${shape.exact ? 'exact' : 'prefix'}:${shape.pattern}`;
    const previous = seen.get(identity);
    if (previous !== undefined) {
      throw new OriginRulesError(
        `originRules keys ${JSON.stringify(previous)} and ${JSON.stringify(key)} have equal specificity after normalization; choose one`,
      );
    }
    seen.set(identity, key);
    normalized.push({ key, value, pattern: shape.pattern, exact: shape.exact });
  }
  return normalized;
}

/**
 * Parse and validate the settings-file representation of origin rules.
 * Malformed keys and values throw a named error instead of degrading to an
 * empty rule set.
 */
export function parseOriginRules(raw: unknown): OriginRules {
  if (raw === undefined) return Object.freeze({});
  const rules = normalizedRules(raw as OriginRules);
  const output: Record<string, OriginRuleValue> = Object.create(null) as Record<string, OriginRuleValue>;
  for (const rule of rules) output[rule.key] = rule.value;
  return Object.freeze(output);
}

/**
 * Select one rule for a namespace. Exact keys win over every prefix; among
 * prefixes, the longest matching prefix wins. The parser's equal-specificity
 * error keeps this selection deterministic.
 */
export function matchOriginRule(rules: OriginRules, namespace: string): OriginRuleMatch | undefined {
  const normalized = normalizedRules(rules);
  const exact = normalized.find((rule) => rule.exact && rule.pattern === namespace);
  if (exact !== undefined) return { key: exact.key, value: exact.value };

  let best: NormalizedRule | undefined;
  for (const rule of normalized) {
    if (rule.exact || !namespace.startsWith(rule.pattern)) continue;
    if (best === undefined || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best === undefined ? undefined : { key: best.key, value: best.value };
}

/**
 * Evaluate a verified or failed origin verdict against a minimum rule.
 * `any` is no requirement; an invalid present sidecar remains a hard failure
 * because a malformed signed statement is an attack signal, not absence.
 */
export function evaluateOriginRule(
  rule: OriginRuleValue,
  verdict: OriginVerdict,
): OriginRuleEvaluation {
  if (verdict.kind === 'invalid') return { ok: false, kind: 'invalid', detail: verdict.reason };
  if (verdict.kind === 'absent') {
    return rule === 'any'
      ? { ok: true }
      : { ok: false, kind: 'absent', detail: 'no origin was recorded' };
  }
  if (verdict.kind === 'unverifiable') {
    return rule === 'any'
      ? { ok: true }
      : { ok: false, kind: 'unverifiable', detail: verdict.reason };
  }
  if (rule === 'any') return { ok: true };

  const actual = ORIGIN_SOURCE_RANK[verdict.source.kind];
  const required = ORIGIN_SOURCE_RANK[rule];
  if (actual >= required) return { ok: true };
  return {
    ok: false,
    kind: 'weaker',
    detail: `origin source '${verdict.source.kind}' is weaker than the required '${rule}' origin`,
  };
}
