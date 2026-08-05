/**
 * Parser for the stock OpenSSH `allowed_signers` file format (ssh-keygen(1)
 * SSH SIGNATURES). The parser is STRUCTURAL only: it extracts principals,
 * options, key type, key blob, and trailing comment with line numbers. It does
 * NOT implement OpenSSH pattern matching, timestamp policy, certificate
 * validation, or authorization — `ssh-keygen -Y verify` remains the policy
 * authority (this repo's `SshSigner` delegates to it).
 *
 * Line structure:
 *
 *   principals[,principal...] [options] keytype base64key [comment...]
 *
 * - principals: comma-separated pattern list (no spaces);
 * - options (optional): one comma-separated `name` / `name="value"` field.
 *   Quoted values may contain commas, spaces, and `\"` / `\\` escapes.
 *   Recognized stock options: `cert-authority`, `namespaces=`, `valid-after=`,
 *   `valid-before=`. Principal/namespace pattern text is
 *   retained verbatim.
 * - keytype: e.g. `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`;
 * - base64key: the key blob, standard Base64;
 * - comment: everything after the key blob (may contain spaces).
 *
 * Blank lines and full-line `#` comments are ignored; LF and CRLF both
 * accepted. All parse errors carry their 1-indexed line number and never
 * include secret material (the format carries only public keys).
 */

/** Structured options recognized on an allowed_signers line. */
export interface AllowedSignerOptions {
  /** `cert-authority` singleton. */
  certAuthority: boolean;
  /** `namespaces="a,b"` — retained pattern text, one entry per comma item. */
  namespaces: string[] | undefined;
  /** `valid-after="..."` — retained verbatim (no timestamp policy here). */
  validAfter: string | undefined;
  /** `valid-before="..."` — retained verbatim. */
  validBefore: string | undefined;
}

/** One parsed allowed_signers entry. */
export interface AllowedSignerEntry {
  /** The principal pattern list (split on unquoted commas). */
  principals: string[];
  options: AllowedSignerOptions;
  keyType: string;
  /** The raw Base64 key text as written in the file. */
  keyBase64: string;
  /** The decoded key blob. */
  keyBlob: Buffer;
  /** Trailing comment (may be empty). */
  comment: string;
  /** 1-indexed source line. */
  line: number;
}

/** A line-numbered parse error. Non-secret by construction. */
export interface AllowedSignersParseError {
  line: number;
  message: string;
}

/** The parse result: every well-formed entry plus every error. */
export interface AllowedSignersFile {
  entries: AllowedSignerEntry[];
  errors: AllowedSignersParseError[];
}

/** Key types the parser recognizes syntactically (any stock type is accepted). */
const KEYTYPE_RE = /^(?:ssh-[a-z0-9@._+-]+|ecdsa-[a-z0-9@._+-]+|sk-[a-z0-9@._+-]+)$/i;

/** Singleton option names (no `=value`). */
const SINGLETON_OPTIONS = new Set(['cert-authority']);
/** Assignment option names (`name="value"`). */
const ASSIGN_OPTIONS = new Set(['namespaces', 'valid-after', 'valid-before']);

/** Split a single options field on commas outside quoted spans. */
function tokenizeOptions(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) throw new Error('dangling escape in option value');
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      // OpenSSH tolerates empty option slots between commas. A trailing comma
      // is different: stock reports an unexpected end-of-options error.
      tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuotes) throw new Error('unterminated quoted option value');
  if (current === '') throw new Error('empty option');
  tokens.push(current);
  return tokens;
}

/** Split the principals field on commas (patterns carry no quoting). */
function splitPrincipals(text: string): string[] {
  return text.split(',').map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * Read the fields needed to identify one line, then treat the rest as opaque
 * comment text. OpenSSH only applies quote rules to the optional options field;
 * quotes in a trailing comment must never turn a valid line into a parse error.
 */
function splitLineTokens(line: string): string[] {
  const tokens: string[] = [];
  let offset = 0;

  const skipWhitespace = (): void => {
    while (offset < line.length && (line[offset] === ' ' || line[offset] === '\t')) offset += 1;
  };

  const readToken = (): string => {
    skipWhitespace();
    if (offset >= line.length) return '';
    let token = '';
    let inQuotes = false;
    while (offset < line.length) {
      const ch = line[offset]!;
      if (ch === '\\' && inQuotes) {
        const next = line[offset + 1];
        if (next === undefined) throw new Error('dangling escape in quoted token');
        token += ch + next;
        offset += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = !inQuotes;
        token += ch;
        offset += 1;
        continue;
      }
      if (!inQuotes && (ch === ' ' || ch === '\t')) break;
      token += ch;
      offset += 1;
    }
    if (inQuotes) throw new Error('unterminated quoted option value');
    return token;
  };

  const first = readToken();
  if (first === '') return tokens;
  tokens.push(first);

  const second = readToken();
  if (second === '') return tokens;
  tokens.push(second);

  // A bare line needs principals, key type, and key blob. An options line
  // needs one additional field. Stop scanning immediately after the blob.
  const requiredFields = KEYTYPE_RE.test(second) ? 3 : 4;
  while (tokens.length < requiredFields) {
    const before = offset;
    const token = readToken();
    if (token === '' && before === offset) break;
    tokens.push(token);
  }

  skipWhitespace();
  if (offset < line.length) tokens.push(line.slice(offset));
  return tokens;
}

/** Decode only standard RFC 4648 Base64, which is what OpenSSH accepts. */
function decodeStandardBase64(text: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('bad base64');
  const body = text.replace(/=+$/, '');
  const expectedPadding = body.length % 4 === 0 ? 0 : 4 - (body.length % 4);
  if (text.length - body.length !== expectedPadding) throw new Error('bad base64 padding');
  return Buffer.from(text, 'base64');
}

/** Parse and unescape one stock quoted assignment value. */
function parseQuotedValue(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) throw new Error('assignment value must be quoted');
  let value = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i]!;
    if (ch !== '\\') {
      if (ch === '"') throw new Error('unescaped quote in assignment value');
      value += ch;
      continue;
    }
    const next = raw[++i];
    if (next !== '"' && next !== '\\') throw new Error('unsupported escape in assignment value');
    value += next;
  }
  return value;
}

/**
 * Parse stock `allowed_signers` text. Returns every well-formed entry plus
 * line-numbered errors for malformed lines; parsing never throws. Blank lines
 * and full-line comments are skipped silently.
 */
export function parseAllowedSigners(text: string): AllowedSignersFile {
  const entries: AllowedSignerEntry[] = [];
  const errors: AllowedSignersParseError[] = [];
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx]!;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const fail = (message: string): null => {
      errors.push({ line: lineNo, message });
      return null;
    };
    let tokens: string[];
    try {
      tokens = splitLineTokens(trimmed);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    if (tokens.length < 3) {
      fail('missing fields: expected principals, key type, and base64 key');
      continue;
    }
    const principals = splitPrincipals(tokens[0]!);
    if (principals.length === 0) {
      fail('missing principals');
      continue;
    }

    const options: AllowedSignerOptions = {
      certAuthority: false,
      namespaces: undefined,
      validAfter: undefined,
      validBefore: undefined,
    };
    let keyIndex = 1;
    if (!KEYTYPE_RE.test(tokens[1]!)) {
      // Stock grammar has exactly one options field. If the next token is not
      // the key type, whitespace-separated options are rejected rather than
      // silently normalized into a different policy line.
      if (tokens.length < 4 || KEYTYPE_RE.test(tokens[2]!)) {
        // The branch with a key type at token 2 is the valid one-option form.
        keyIndex = 2;
      } else {
        fail('options must be one comma-separated field');
        continue;
      }
      let optionTokens: string[];
      try {
        optionTokens = tokenizeOptions(tokens[1]!);
      } catch (e) {
        fail(`options: ${(e as Error).message}`);
        continue;
      }
      let optionError: string | null = null;
      for (const rawOption of optionTokens) {
        if (rawOption === '') continue;
        const eq = rawOption.indexOf('=');
        const rawName = eq < 0 ? rawOption : rawOption.slice(0, eq);
        const name = rawName.toLowerCase();
        if (eq < 0) {
          if (!SINGLETON_OPTIONS.has(name)) {
            optionError = `unsupported option syntax: '${rawOption}'`;
            break;
          }
          // OpenSSH accepts repeated cert-authority options. Preserve the
          // boolean representation without treating repetition as a grammar error.
          options.certAuthority = true;
          continue;
        }
        if (!ASSIGN_OPTIONS.has(name)) {
          optionError = `unsupported option syntax: '${rawOption}'`;
          break;
        }
        let value: string;
        try {
          value = parseQuotedValue(rawOption.slice(eq + 1));
        } catch (e) {
          optionError = `option '${name}': ${(e as Error).message}`;
          break;
        }
        if (name === 'namespaces') {
          if (options.namespaces !== undefined) {
            optionError = 'duplicate option: namespaces';
            break;
          }
          options.namespaces = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
        } else if (name === 'valid-after') {
          if (options.validAfter !== undefined) {
            optionError = 'duplicate option: valid-after';
            break;
          }
          options.validAfter = value;
        } else {
          if (options.validBefore !== undefined) {
            optionError = 'duplicate option: valid-before';
            break;
          }
          options.validBefore = value;
        }
      }
      if (optionError !== null) {
        fail(optionError);
        continue;
      }
    }
    const keyType = tokens[keyIndex]!;
    if (!KEYTYPE_RE.test(keyType)) {
      fail(`invalid key type: '${keyType}'`);
      continue;
    }
    if (keyIndex + 1 >= tokens.length) {
      fail('missing base64 key');
      continue;
    }
    const keyBase64 = tokens[keyIndex + 1]!;
    let keyBlob: Buffer;
    try {
      keyBlob = decodeStandardBase64(keyBase64);
    } catch {
      fail('bad base64 key blob');
      continue;
    }
    const comment = tokens.slice(keyIndex + 2).join(' ');
    entries.push({ principals, options, keyType, keyBase64, keyBlob, comment, line: lineNo });
  }
  return { entries, errors };
}
