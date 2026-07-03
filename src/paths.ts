/**
 * Path addressing and pattern matching (design §11.1, §11.2).
 *
 * An artifact id is a dot-notation provenance path: `plan`, `gather.source[3]`,
 * `gather.source[3].formatcheck`, `gather.source.sealed`. A consumer's
 * `consumes`/`produces` entries are *patterns* over those paths:
 *
 *   plain     plan                       — exact singleton
 *   map       gather.source[$i]          — binds per element (fires once per element)
 *   reduce    gather.source[*]           — globs the whole set (fires once)
 *   collection (produces)  gather.source[]   — declares the step emits a collection
 *   map output (produces)  gather.source[$i].formatcheck  — one output per element
 *
 * A path carries at most one index token `[n]`; that is sufficient for every
 * shape in the design. Everything here is pure — no IO — so it unit-tests
 * cleanly.
 */

import type { ConsumePattern, ProducePattern, ConsumeMode, ProduceKind } from './types.ts';

const ELEMENT_RE = /^(.*?)\[(\d+)\](.*)$/; // stem [index] suffix
const SEAL_SUFFIX = '.sealed';

export interface ElementParts {
  stem: string;
  index: number;
  suffix: string; // text after the ] (e.g. ".formatcheck"), "" if none
}

/** Split `gather.source[3].formatcheck` → {stem:"gather.source", index:3, suffix:".formatcheck"}. */
export function parseElement(path: string): ElementParts | null {
  const m = ELEMENT_RE.exec(path);
  if (!m) return null;
  return { stem: m[1] as string, index: Number(m[2]), suffix: m[3] as string };
}

/** Is this an element of a collection (has an index token)? */
export function isElement(path: string): boolean {
  return ELEMENT_RE.test(path);
}

/** The seal path for a collection stem. */
export function sealPath(stem: string): string {
  return `${stem}${SEAL_SUFFIX}`;
}

/** If `path` is a seal, return the collection stem it seals, else null. */
export function sealStem(path: string): string | null {
  return path.endsWith(SEAL_SUFFIX) ? path.slice(0, -SEAL_SUFFIX.length) : null;
}

// ---- pattern parsing ---------------------------------------------------------

const MAP_RE = /^(.*?)\[\$(\w+)\](.*)$/; // stem [$binder] suffix
const REDUCE_RE = /^(.*?)\[\*\](.*)$/; // stem [*] suffix
const COLLECTION_RE = /^(.*?)\[\](.*)$/; // stem [] suffix
// A suffixed reduce (`src[*].child`) fans in one level deeper — see
// reduceInputPath in model.ts. "" (bare reduce) or a single ".identifier"
// segment only; multi-level (".a.b") or malformed suffixes are a parse error.
const REDUCE_SUFFIX_RE = /^(?:|\.[A-Za-z_][\w-]*)$/;

/** Parse a consume pattern. */
export function parseConsume(raw: string): ConsumePattern {
  const r = raw.trim();
  let m = MAP_RE.exec(r);
  if (m) {
    return { raw: r, mode: 'map', stem: m[1] as string, binder: m[2] as string, suffix: m[3] as string };
  }
  m = REDUCE_RE.exec(r);
  if (m) {
    const suffix = m[2] as string;
    if (!REDUCE_SUFFIX_RE.test(suffix)) {
      throw new Error(`reduce suffix must be empty or a single '.child' level: '${raw}'`);
    }
    return { raw: r, mode: 'reduce' as ConsumeMode, stem: m[1] as string, suffix };
  }
  if (COLLECTION_RE.test(r) || ELEMENT_RE.test(r)) {
    throw new Error(`consume pattern may not be a collection-decl or literal index: '${raw}'`);
  }
  return { raw: r, mode: 'plain', stem: r, suffix: '' };
}

/** Parse a produce declaration. */
export function parseProduce(raw: string): ProducePattern {
  const r = raw.trim();
  let m = MAP_RE.exec(r);
  if (m) {
    return { raw: r, kind: 'map' as ProduceKind, stem: m[1] as string, binder: m[2] as string, suffix: m[3] as string };
  }
  m = COLLECTION_RE.exec(r);
  if (m) {
    if ((m[2] as string) !== '') {
      throw new Error(`collection-decl must end in []: '${raw}'`);
    }
    return { raw: r, kind: 'collection', stem: m[1] as string, suffix: '' };
  }
  if (REDUCE_RE.test(r)) {
    throw new Error(`a step cannot 'produce' a reduce glob: '${raw}'`);
  }
  if (ELEMENT_RE.test(r)) {
    throw new Error(`produce must not hardcode an index: '${raw}'`);
  }
  return { raw: r, kind: 'singleton', stem: r, suffix: '' };
}

// ---- matching ----------------------------------------------------------------

/**
 * Does a concrete artifact `path` match a consume pattern? Returns the binding
 * (the element index for a map match) or an empty binding, or null for no match.
 */
export function matchConsume(
  pat: ConsumePattern,
  path: string,
): { index?: number } | null {
  if (pat.mode === 'plain') {
    return path === pat.stem ? {} : null;
  }
  const el = parseElement(path);
  if (!el || el.stem !== pat.stem) return null;
  if (pat.mode === 'map') {
    return el.suffix === pat.suffix ? { index: el.index } : null;
  }
  // reduce: matches every member whose suffix matches the pattern's suffix
  // (bare reduce: both sides ""; suffixed reduce: matches the child lane).
  return el.suffix === pat.suffix ? { index: el.index } : null;
}

/** Concrete path for a map produce given the bound element index. */
export function bindProduce(pat: ProducePattern, index: number): string {
  if (pat.kind === 'map') return `${pat.stem}[${index}]${pat.suffix}`;
  throw new Error(`bindProduce called on non-map produce '${pat.raw}'`);
}

/** Concrete element path for a collection stem + index. */
export function elementPath(stem: string, index: number, suffix = ''): string {
  return `${stem}[${index}]${suffix}`;
}

/**
 * Is `path` a member of the collection `stem` (a bare element, no further
 * suffix)? Used by reduce eligibility and the seal.
 */
export function isMemberOf(stem: string, path: string): boolean {
  const el = parseElement(path);
  return !!el && el.stem === stem && el.suffix === '';
}
