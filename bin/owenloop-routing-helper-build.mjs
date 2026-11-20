#!/usr/bin/env node
// Explicit server-side preparation. Ordinary owenloop installs never compile.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const platform = process.platform;
const arch = process.arch;
if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
  if (process.argv.includes('--if-supported')) process.exit(0);
  process.stderr.write('routed artifact helper unsupported on this platform/architecture\n');
  process.exit(1);
}
const source = join(root, 'native', 'routing-file-open.c');
const output = join(root, 'native', 'bin', `${platform}-${arch}`, 'routing-file-open');
mkdirSync(dirname(output), { recursive: true });
const result = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
  '-o', output, source], { stdio: 'inherit', env: { PATH: process.env.PATH ?? '' } });
if (result.error || result.status !== 0) {
  process.stderr.write('routed artifact helper build failed\n');
  process.exit(1);
}
process.stdout.write(`${output}\n`);
