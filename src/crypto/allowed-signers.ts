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
 * - options (optional): comma-separated `name` / `name="value"` entries.
 *   Quoted values may contain commas, spaces, and `\"` / `\\` escapes.
 *   Recognized: `cert-authority`, `touch-required`, `namespaces=`,
 *   `valid-after=`, `valid-before=`. Principal/namespace pattern text is
 *   retained verbatim.
 * - keytype: e.g. `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`;
 * - base64key: the key blob, standard Base64;
 * - comment: everything after the key blob (may contain spaces).
 *
 * Blank lines and full-line `#` comments are ignored; LF and CRLF both
 * accepted. All parse errors carry their 1-indexed line number and never
 * include secret material (the format carries only public keys).
 */

import { decodeBase64Strict } from './dsse.ts';

/** Structured options recognized on an allowed_signers line. */
export interface AllowedSignerOptions {
  /** `cert-authority` singleton. */
  certAuthority: boolean;
  /** `touch-required` singleton. */
  touchRequired: boolean;
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
const KEYTYPE_RE = /^(?:ssh|ecdsa|sk-(?:ssh|ecdsa)-[a-z0-9@.-]+)[a-z0-9@.-]*$/i;

/** Singleton option names (no `=value`). */
const SINGLETON_OPTIONS = new Set(['cert-authority', 'touch-required']);
/** Assignment option names (`name="value"`). */
const ASSIGN_OPTIONS = new Set(['namespaces', 'valid-after', 'valid-before']);

/**
 * Tokenize the options field: comma-separated `name` / `name="value"` entries,
 * where quoted values may contain commas/spaces and `\"`/`\\` escapes. Returns
 * the tokens or throws with a structural reason (unterminated quote).
 */
function tokenizeOptions(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i += 2;
          continue;
        }
        current += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (inQuotes) throw new Error('unterminated quoted option value');
  tokens.push(current);
  return tokens;
}

/** Split the principals field on commas (patterns carry no quoting). */
function splitPrincipals(text: string): string[] {
  return text.split(',').map((p) => p.trim()).filter((p) => p !== '');
}

/**
 * Split on commas that fall OUTSIDE double quotes (`"` with `\"`/`\\`
 * escapes). Quoted spans keep their commas. Throws on an unterminated quote.
 */
function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQ = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQ) {
      if (ch === '\\' && i + 1 < text.length) {
        cur += ch + text[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inQ = false;
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQ = true;
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      parts.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (inQ) throw new Error('unterminated quoted option value');
  parts.push(cur);
  return parts;
}

/**
 * Parse one line into tokens honoring double-quoted spans (an option value may
 * contain spaces): returns the whitespace-separated tokens with quoted strings
 * kept whole. The FIRST token (principals) is never quoted.
 */
function splitLineTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
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

    const tokens = splitLineTokens(trimmed);

    // Stock accepts the options field BOTH comma-joined in one token
    // (`namespaces="a,b",cert-authority`) and space-separated into several
    // tokens (`namespaces="a,b" cert-authority`). When the token after the
    // principals contains at least one recognized option name, expand a
    // comma-joined options token into its parts; otherwise leave it for the
    // scan below (it may be the key type). An unterminated quote inside this
    // token is a structural error, reported before the field-count check.
    if (tokens.length > 1 && /[,=]/.test(tokens[1]!)) {
      let sub: string[];
      try {
        sub = splitOutsideQuotes(tokens[1]!);
      } catch (e) {
        fail(`options: ${(e as Error).message}`);
        continue;
      }
      // Expand only when EVERY comma-part is a recognized option form —
      // `singleton` or `name="quoted value"` (the quoted value itself may hold
      // commas, spaces, and escapes; the splitter above kept it whole).
      // Otherwise the comma lives inside some other field's value and the
      // token is left for the scan below.
      const allOptions = sub.every((s) => {
        const m = /^([A-Za-z-]+)(?:="(?:[^"\\]|\\.)*")?$/.exec(s);
        if (m === null) return false;
        return SINGLETON_OPTIONS.has(m[1]!) || ASSIGN_OPTIONS.has(m[1]!);
      });
      if (allOptions) tokens.splice(1, 1, ...sub);
    }

    if (tokens.length < 3) {
      fail('missing fields: expected principals, key type, and base64 key');
      continue;
    }

    // Token 0: principals.
    const principals = splitPrincipals(tokens[0]!);
    if (principals.length === 0) {
      fail('missing principals');
      continue;
    }

    // Middle tokens: options until the key type appears.
    const options: AllowedSignerOptions = {
      certAuthority: false,
      touchRequired: false,
      namespaces: undefined,
      validAfter: undefined,
      validBefore: undefined,
    };
    let i = 1;
    let aborted = false;
    for (; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (KEYTYPE_RE.test(tok)) break; // key type reached
      // An option token: singleton or assignment.
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok : tok.slice(0, eq);
      if (eq === -1) {
        if (!SINGLETON_OPTIONS.has(name)) {
          fail(`unsupported option syntax: '${tok}'`);
          aborted = true;
          break;
        }
        if (name === 'cert-authority') {
          if (options.certAuthority) {
            fail('duplicate option: cert-authority');
            aborted = true;
            break;
          }
          options.certAuthority = true;
        } else {
          if (options.touchRequired) {
            fail('duplicate option: touch-required');
            aborted = true;
            break;
          }
          options.touchRequired = true;
        }
        continue;
      }
      if (!ASSIGN_OPTIONS.has(name)) {
        fail(`unsupported option syntax: '${tok}'`);
        aborted = true;
        break;
      }
      const quoted = tok.slice(eq + 1);
      let value: string;
      try {
        const parts = tokenizeOptions(quoted);
        if (parts.length !== 1) {
          fail(`option '${name}' value must be a single quoted string`);
          aborted = true;
          break;
        }
        value = parts[0]!;
      } catch (e) {
        fail(`option '${name}': ${(e as Error).message}`);
        aborted = true;
        break;
      }
      if (name === 'namespaces') {
        if (options.namespaces !== undefined) {
          fail('duplicate option: namespaces');
          aborted = true;
          break;
        }
        options.namespaces = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
      } else if (name === 'valid-after') {
        if (options.validAfter !== undefined) {
          fail('duplicate option: valid-after');
          aborted = true;
          break;
        }
        options.validAfter = value;
      } else {
        if (options.validBefore !== undefined) {
          fail('duplicate option: valid-before');
          aborted = true;
          break;
        }
        options.validBefore = value;
      }
    }
    if (aborted) continue;
    if (i >= tokens.length) {
      fail('missing key type and base64 key');
      continue;
    }
    const keyType = tokens[i]!;
    if (i + 1 >= tokens.length) {
      fail('missing base64 key');
      continue;
    }
    const keyBase64 = tokens[i + 1]!;
    let keyBlob: Buffer;
    try {
      keyBlob = decodeBase64Strict(keyBase64);
    } catch {
      fail('bad base64 key blob');
      continue;
    }
    const comment = tokens.slice(i + 2).join(' ');
    entries.push({ principals, options, keyType, keyBase64, keyBlob, comment, line: lineNo });
  }
  return { entries, errors };
}
