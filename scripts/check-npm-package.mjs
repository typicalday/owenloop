import { readFileSync, realpathSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/**
 * The two marketplace roots are the consumer-facing plugin package. The
 * underscore-prefixed trees are source material for the committed copies and
 * must never enter the npm package.
 */
export const PLUGIN_FILES = Object.freeze([
  'plugins/claude-code/.claude-plugin/marketplace.json',
  'plugins/claude-code/plugin/.claude-plugin/plugin.json',
  'plugins/claude-code/plugin/.mcp.json',
  'plugins/claude-code/plugin/hooks/hooks.json',
  'plugins/claude-code/plugin/hooks/session-end.sh',
  'plugins/claude-code/plugin/hooks/session-start.sh',
  'plugins/claude-code/plugin/skills/author/SKILL.md',
  'plugins/claude-code/plugin/skills/conduct/SKILL.md',
  'plugins/claude-code/plugin/skills/shift/SKILL.md',
  'plugins/codex/.agents/plugins/marketplace.json',
  'plugins/codex/plugins/owenloop/.codex-plugin/plugin.json',
  'plugins/codex/plugins/owenloop/.mcp.json',
  'plugins/codex/plugins/owenloop/hooks/hooks.json',
  'plugins/codex/plugins/owenloop/hooks/session-end.sh',
  'plugins/codex/plugins/owenloop/hooks/session-start.sh',
  'plugins/codex/plugins/owenloop/skills/author/SKILL.md',
  'plugins/codex/plugins/owenloop/skills/conduct/SKILL.md',
  'plugins/codex/plugins/owenloop/skills/shift/SKILL.md',
]);

const PLUGIN_EXECUTABLES = new Set([
  'plugins/claude-code/plugin/hooks/session-end.sh',
  'plugins/claude-code/plugin/hooks/session-start.sh',
  'plugins/codex/plugins/owenloop/hooks/session-end.sh',
  'plugins/codex/plugins/owenloop/hooks/session-start.sh',
]);

const EXACT_FILES = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'bin/owenloop.mjs',
  ...PLUGIN_FILES,
]);

const ALLOWED_PREFIXES = ['dist/', 'docs/', 'examples/workflows/'];
const FORBIDDEN_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'credentials.json',
  'service-account.json',
]);
const FORBIDDEN_SEGMENTS = new Set([
  '.dev',
  '.git',
  '.owenloop',
  'coverage',
  'node_modules',
]);
const FORBIDDEN_EXTENSIONS = ['.key', '.pem', '.p12', '.pfx', '.sqlite', '.sqlite-shm', '.sqlite-wal'];

function textField(header, start, length) {
  return header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

function octalField(header, start, length, fieldName) {
  const raw = textField(header, start, length).trim();
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`invalid tar ${fieldName} field`);
  }
  return Number.parseInt(raw, 8);
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * Read the regular-file tar entries from an npm .tgz without trusting a shell
 * listing. Header type, checksum, size, mode, and path are preserved so the
 * caller can reject links, traversal, duplicate names, and mode changes.
 */
export function readTarEntries(tarball) {
  const archive = gunzipSync(readFileSync(tarball));
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;

    if (isZeroBlock(header)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    zeroBlocks = 0;

    const storedChecksum = octalField(header, 148, 8, 'checksum');
    const actualChecksum = tarChecksum(header);
    if (storedChecksum !== actualChecksum) {
      throw new Error(`tar checksum mismatch for ${textField(header, 0, 100)}`);
    }

    const name = textField(header, 0, 100);
    const prefix = textField(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = octalField(header, 124, 12, 'size');
    const mode = octalField(header, 100, 8, 'mode');
    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const paddedSize = Math.ceil(size / 512) * 512;

    if (offset + paddedSize > archive.length) {
      throw new Error(`truncated tar entry ${path}`);
    }
    entries.push({ mode, path, size, typeflag });
    offset += paddedSize;
  }

  if (zeroBlocks < 2) {
    throw new Error('tar archive is missing its two-block terminator');
  }
  return entries;
}

function normalizePackagePath(path) {
  if (!path.startsWith('package/')) {
    throw new Error(`tar path is outside package/: ${path}`);
  }
  const relativePath = path.slice('package/'.length);
  const segments = relativePath.split('/');
  if (
    relativePath.length === 0 ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe package path: ${path}`);
  }
  return relativePath;
}

function isForbiddenPath(path) {
  const segments = path.split('/');
  const basename = segments.at(-1);
  if (FORBIDDEN_BASENAMES.has(basename)) return true;
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return true;
  return FORBIDDEN_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function allowedPath(path) {
  return EXACT_FILES.has(path) || ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Return human-readable violations. An empty list means the archive is safe to
 * inspect and publish under the package-content policy.
 */
export function validatePackageEntries(entries) {
  const errors = [];
  const seen = new Set();

  for (const entry of entries) {
    let path;
    try {
      path = normalizePackagePath(entry.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    if (seen.has(path)) errors.push(`duplicate tar path: ${path}`);
    seen.add(path);

    if (entry.typeflag !== '0') {
      errors.push(`tar entry is not a regular file: ${path} (type ${entry.typeflag})`);
      continue;
    }
    if (!allowedPath(path)) {
      errors.push(`unexpected package path: ${path}`);
      continue;
    }
    if (isForbiddenPath(path)) {
      errors.push(`forbidden credential or local-state path: ${path}`);
      continue;
    }

    const expectedMode =
      path === 'bin/owenloop.mjs' || PLUGIN_EXECUTABLES.has(path) ? 0o755 : 0o644;
    if ((entry.mode & 0o7777) !== expectedMode) {
      errors.push(
        `unexpected mode for ${path}: expected ${expectedMode.toString(8)}, got ${(entry.mode & 0o7777).toString(8)}`,
      );
    }

    if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      errors.push(`TypeScript source must not ship: ${path}`);
    }
  }

  for (const path of PLUGIN_FILES) {
    if (!seen.has(path)) errors.push(`required plugin file missing: ${path}`);
  }

  return errors;
}

function main() {
  const [tarball] = process.argv.slice(2);
  if (!tarball || process.argv.length !== 3) {
    console.error('Usage: node scripts/check-npm-package.mjs <tarball>');
    process.exitCode = 2;
    return;
  }

  try {
    const entries = readTarEntries(tarball);
    const errors = validatePackageEntries(entries);
    if (errors.length > 0) {
      console.error('Unexpected files in npm tarball:');
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`npm package content OK (${entries.length} regular files)`);
  } catch (error) {
    console.error(`Unable to inspect npm tarball: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
