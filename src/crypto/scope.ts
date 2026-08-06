/**
 * Pure enrollment-scope attenuation arithmetic.
 *
 * This module decides whether a child enrollment grant is no wider than the
 * scope already held by its signer, and whether an effective scope permits one
 * requested pool, label, or namespace. The module deliberately does not read
 * keys, verify signatures, or perform filesystem or network I/O; chain.ts owns
 * those concerns.
 */

import type { GrantDelegation, GrantScope } from './records.ts';

/** One scope axis: an explicit allow-list or the all-values identity. */
export type ScopeAxis = string[] | '*';

/** Whether a child axis is contained by a parent's effective axis. */
export function axisPermits(parent: ScopeAxis, child: ScopeAxis): boolean {
  if (parent === '*') return true;
  if (child === '*') return false;
  const allowed = new Set(parent);
  return child.every((value) => allowed.has(value));
}

/**
 * Check whether a child delegation declaration is permitted by its parent.
 * `maxDepth: N` means a grant signed by that key may delegate at most N - 1
 * further levels; zero therefore permits only non-delegating child grants.
 */
export function delegationPermits(
  parent: GrantDelegation,
  child: GrantDelegation,
): { ok: true } | { ok: false; reason: string } {
  if (!parent.allowed) {
    return { ok: false, reason: 'parent delegation is not allowed to sign grants' };
  }
  if (parent.maxDepth === 'unbounded') return { ok: true };
  if (!child.allowed) return { ok: true };
  if (child.maxDepth === 'unbounded') {
    return {
      ok: false,
      reason: `child delegation is unbounded but parent permits at most ${parent.maxDepth - 1} further level(s)`,
    };
  }
  if (child.maxDepth > parent.maxDepth - 1) {
    return {
      ok: false,
      reason: `child delegation depth ${child.maxDepth} exceeds parent limit ${parent.maxDepth - 1}`,
    };
  }
  return { ok: true };
}

/** Check every axis and the delegation limit in one attenuation decision. */
export function attenuate(
  parent: GrantScope,
  child: GrantScope,
): { ok: true } | { ok: false; reason: string } {
  for (const axis of ['pools', 'labels', 'namespaces'] as const) {
    if (!axisPermits(parent[axis], child[axis])) {
      const parentText = parent[axis] === '*' ? '*' : `[${parent[axis].join(', ')}]`;
      const childText = child[axis] === '*' ? '*' : `[${child[axis].join(', ')}]`;
      return { ok: false, reason: `${axis} scope widens from ${parentText} to ${childText}` };
    }
  }
  return delegationPermits(parent.delegation, child.delegation);
}

/** The identity scope held by the local organization root anchor. */
export const ORG_ROOT_SCOPE: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: true, maxDepth: 'unbounded' },
};

function axisContains(axis: ScopeAxis, value: string): boolean {
  return axis === '*' || axis.includes(value);
}

/**
 * Check whether a producer demand is contained by an effective grant scope.
 * Omitted demand fields are not constrained; present fields must be allowed by
 * their corresponding axis.
 */
export function scopePermits(
  scope: GrantScope,
  demand: { pool?: string; label?: string; namespace?: string },
): { ok: true } | { ok: false; reason: string } {
  if (demand.pool !== undefined && !axisContains(scope.pools, demand.pool)) {
    return { ok: false, reason: `pool '${demand.pool}' is outside the granted scope` };
  }
  if (demand.label !== undefined && !axisContains(scope.labels, demand.label)) {
    return { ok: false, reason: `label '${demand.label}' is outside the granted scope` };
  }
  if (demand.namespace !== undefined && !axisContains(scope.namespaces, demand.namespace)) {
    return { ok: false, reason: `namespace '${demand.namespace}' is outside the granted scope` };
  }
  return { ok: true };
}
