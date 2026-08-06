import { createHash } from 'node:crypto';

/**
 * Serialize a JSON value deterministically for value-level trust records.
 * Object keys are sorted recursively; array order is preserved. The output is
 * separator-tight JSON encoded as UTF-8 bytes.
 */
export function canonicalValueBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalValueJson(value));
}

/** Compute the lowercase SHA-256 digest of a canonical JSON value. */
export function valueDigestHex(value: unknown): string {
  return createHash('sha256').update(canonicalValueBytes(value)).digest('hex');
}

function canonicalValueJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('cannot canonicalize a non-finite number');
      return JSON.stringify(value);
    }
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new TypeError(`cannot canonicalize ${typeof value}`);
    case 'bigint':
      throw new TypeError('cannot canonicalize bigint');
    case 'object':
      break;
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalValueJson(entry)).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValueJson(object[key])}`).join(',')}}`;
}
