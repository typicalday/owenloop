import { createHash } from 'node:crypto';

/**
 * Serialize a JSON value deterministically for value-level trust records.
 * Object keys are sorted recursively; array order is preserved. The output is
 * separator-tight JSON encoded as UTF-8 bytes.
 */
export function canonicalValueBytes(value: unknown): Uint8Array {
  const json = canonicalValueJson(value);
  if (json === undefined) throw new TypeError('cannot canonicalize a value that serializes to undefined');
  return new TextEncoder().encode(json);
}

/** Compute the lowercase SHA-256 digest of a canonical JSON value. */
export function valueDigestHex(value: unknown): string {
  return createHash('sha256').update(canonicalValueBytes(value)).digest('hex');
}

type CanonicalPosition = 'root' | 'object' | 'array';

/**
 * Apply the same `toJSON(key)` hook that JSON.stringify applies before a value
 * crosses the submit transport. Objects without JSON-compatible prototypes are
 * rejected instead of being treated as empty records.
 */
function canonicalValueJson(
  value: unknown,
  key = '',
  stack = new Set<object>(),
  position: CanonicalPosition = 'root',
): string | undefined {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      if (stack.has(value)) throw new TypeError('cannot canonicalize a circular value');
      stack.add(value);
      try {
        const replacement = Reflect.apply(toJSON, value, [key]);
        return canonicalValueJson(replacement, key, stack, position);
      } finally {
        stack.delete(value);
      }
    }
  }

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
      if (position === 'object') return undefined;
      if (position === 'array') return 'null';
      throw new TypeError(`cannot canonicalize ${typeof value}`);
    case 'bigint':
      throw new TypeError('cannot canonicalize bigint');
    case 'object':
      break;
    default:
      throw new TypeError(`cannot canonicalize ${typeof value}`);
  }

  if (stack.has(value)) throw new TypeError('cannot canonicalize a circular value');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        entries.push(canonicalValueJson(value[index], String(index), stack, 'array') ?? 'null');
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('cannot canonicalize a non-plain object without toJSON');
    }

    const object = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const property of Object.keys(object).sort()) {
      const serialized = canonicalValueJson(object[property], property, stack, 'object');
      if (serialized !== undefined) entries.push(`${JSON.stringify(property)}:${serialized}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}
