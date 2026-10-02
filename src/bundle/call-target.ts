/** Exact bundle-call syntax, separate from filesystem and YAML manifest loading. */
import { BundleError } from './error.ts';

/** Workflow map keys: lowercase-start, lowercase alphanumeric and hyphen. */
export const WORKFLOW_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** Historical explicit-coordinate spelling; store parsing excludes ambiguous separators. */
const VERSIONED_REF_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[!-~]+$/;

/** Parse an exact call. `#` cannot occur in a store coordinate. */
export function parseVersionedCallTarget(
  text: string,
  validateCoordinate: (coordinate: string) => unknown,
): { coordinate: string; workflow?: string } {
  const hash = text.indexOf('#');
  const coordinate = hash < 0 ? text : text.slice(0, hash);
  if (!VERSIONED_REF_RE.test(coordinate)) {
    throw new BundleError('MANIFEST_ERROR', `invalid exact versioned call target '${text}'`);
  }
  validateCoordinate(coordinate);
  if (hash < 0) return { coordinate };
  const workflow = text.slice(hash + 1);
  if (!WORKFLOW_NAME_RE.test(workflow)) {
    throw new BundleError('MANIFEST_ERROR', `invalid named workflow selector '${text}'`);
  }
  return { coordinate, workflow };
}

/** True for a well-formed exact package call, optionally selecting a named workflow. */
export function isVersionedReference(
  text: string,
  validateCoordinate: (coordinate: string) => unknown,
): boolean {
  try {
    parseVersionedCallTarget(text, validateCoordinate);
    return true;
  } catch {
    return false;
  }
}
