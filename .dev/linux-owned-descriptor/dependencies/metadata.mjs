import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const INPUT_CAP = 65536;
export const TOOL_CAP = 512 * 1024 * 1024;
export const TOTAL_CAP = 1024 * 1024 * 1024;
export const OUTPUT_CAP = 65536;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function need(value) { if (!value) throw new Error('METADATA_REFUSED'); }
export function safeInteger(text) {
  need(typeof text === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(text));
  const n = Number(text); need(Number.isSafeInteger(n)); return n;
}
export function statusProjection(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= INPUT_CAP);
  const rows = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    need(!rows.has(match[1])); rows.set(match[1], match[2]);
  }
  const ids = key => {
    need(rows.has(key));
    const values = rows.get(key).trim().split(/\s+/).map(safeInteger);
    need(values.length === 4);
    return { fourEqual: values.every(v => v === values[0]), allNonzero: values.every(v => v > 0) };
  };
  need(rows.has('Groups'));
  const groups = rows.get('Groups').trim();
  const gs = groups === '' ? [] : groups.split(/\s+/).map(safeInteger);
  need(gs.length <= 64 && new Set(gs).size === gs.length);
  const capabilities = {};
  for (const [key, label] of [['CapInh','inheritable'],['CapPrm','permitted'],['CapEff','effective'],['CapBnd','bounding'],['CapAmb','ambient']]) {
    const value = rows.get(key); need(typeof value === 'string' && /^[0-9a-fA-F]{16}$/.test(value));
    capabilities[label] = BigInt(`0x${value}`) === 0n ? 'ZERO' : 'NONZERO';
  }
  const nnp = rows.get('NoNewPrivs'); need(nnp === '0' || nnp === '1');
  const seccomp = rows.get('Seccomp'); need(['0','1','2'].includes(seccomp));
  return { uid: ids('Uid'), gid: ids('Gid'), supplementaryGroupCount: gs.length,
    supplementaryGroupSetSha256: digest(Buffer.from(gs.slice().sort((a,b)=>a-b).join(','))),
    capabilities, noNewPrivileges: nnp === '1', seccomp: ['DISABLED','STRICT','FILTER'][Number(seccomp)] };
}
export function namespaceProjection(kind, first, second) {
  need(['pid','mnt','user'].includes(kind));
  need(typeof first === 'string' && first.length <= 128 && first === second);
  need(new RegExp(`^${kind}:\\[[0-9]{1,20}\\]$`).test(first));
  return { kind, identitySha256: digest(Buffer.from(first)), stableAcrossTwoReads: true };
}
export function mountProjection(text) {
  need(typeof text === 'string' && Buffer.byteLength(text) <= INPUT_CAP);
  const lines = text.trimEnd().split('\n'); need(lines.length > 0 && lines.length <= 2048);
  const matches = [];
  for (const line of lines) {
    const sides = line.split(' - '); need(sides.length === 2);
    const left = sides[0].split(' '), right = sides[1].split(' ');
    need(left.length >= 6 && right.length >= 3);
    if (left[4] === '/proc') {
      need(right[0] === 'proc');
      const opts = [...left[5].split(','), ...right[2].split(',')];
      const hide = opts.filter(x => x.startsWith('hidepid='));
      const subset = opts.filter(x => x.startsWith('subset='));
      need(hide.length <= 1 && (hide.length === 0 || ['hidepid=0','hidepid=1','hidepid=2','hidepid=4'].includes(hide[0])));
      need(subset.length <= 1 && (subset.length === 0 || subset[0] === 'subset=pid'));
      matches.push({ filesystem: 'PROCFS', hidepid: hide.length ? hide[0].slice(8) : 'NOT_DECLARED',
        subset: subset.length ? 'PID' : 'NOT_DECLARED',
        readOnly: opts.includes('ro'), optionsSha256: digest(Buffer.from(opts.slice().sort().join(','))) });
    }
  }
  need(matches.length === 1); return matches[0];
}
export function validateContext(env) {
  need(env.JEV_REPOSITORY === 'typicalday/owenloop' && env.JEV_PR === '369');
  need(env.JEV_BRANCH === 'jev-routing-foundation-20261008' && env.JEV_EVENT === 'pull_request');
  need(env.JEV_ACTION === 'synchronize');
  need(env.JEV_HEAD_REPOSITORY === 'typicalday/owenloop');
  need(env.JEV_BASE === 'b4ead192326ba607558cd3bb7687209cbb7c8165');
  need(/^[1-9][0-9]{0,19}$/.test(env.JEV_RUN_ID || '') && /^[1-9][0-9]{0,5}$/.test(env.JEV_RUN_ATTEMPT || ''));
  need(env.JEV_JOB === 'linux-metadata-preflight');
  need(/^[a-f0-9]{40}$/.test(env.JEV_HEAD || '') && env.JEV_HEAD === env.JEV_ADMITTED_HEAD);
  return { repository: 'typicalday/owenloop', pullRequest: 369, headSha256: digest(Buffer.from(env.JEV_HEAD)),
    baseSha256: digest(Buffer.from(env.JEV_BASE)), runId: env.JEV_RUN_ID, runAttempt: env.JEV_RUN_ATTEMPT,
    job: 'linux-metadata-preflight', sameRepositoryHeadGate: true, admissionKind: 'MUTABLE_ROOT_SCHEDULING_CONTROL' };
}
function deadlineCheck(deadline) { need(Number.isFinite(deadline) && performance.now() <= deadline); }
function boundedInput(path, deadline) {
  deadlineCheck(deadline);
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const a = fs.fstatSync(fd), chunks = []; let count = 0;
    while (true) {
      deadlineCheck(deadline); const buffer = Buffer.alloc(8192), n = fs.readSync(fd, buffer);
      if (!n) break; count += n; need(count <= INPUT_CAP); chunks.push(buffer.subarray(0,n));
    }
    const b = fs.fstatSync(fd); need(a.dev === b.dev && a.ino === b.ino && a.mode === b.mode);
    const bytes = Buffer.concat(chunks); return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}
function fileHash(path, cap, budget, deadline) {
  deadlineCheck(deadline); need(budget.files < 64); budget.files++;
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const a = fs.fstatSync(fd, { bigint: true }); need(a.isFile() && a.size >= 0n && a.size <= BigInt(cap));
    const hash = crypto.createHash('sha256'); let total = 0;
    while (true) {
      deadlineCheck(deadline); const buffer = Buffer.alloc(65536), n = fs.readSync(fd, buffer);
      if (!n) break; total += n; budget.bytes += n; need(total <= cap && budget.bytes <= TOTAL_CAP); hash.update(buffer.subarray(0,n));
    }
    const b = fs.fstatSync(fd, { bigint: true });
    for (const key of ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs']) need(a[key] === b[key]);
    const finalPath = fs.lstatSync(path, { bigint: true });
    for (const key of ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs']) need(b[key] === finalPath[key]);
    need(BigInt(total) === b.size); return { sha256: hash.digest('hex'), bytes: total };
  } finally { fs.closeSync(fd); }
}
export function canonicalResult(result) {
  const text = JSON.stringify(result) + '\n'; need(Buffer.byteLength(text) <= OUTPUT_CAP); return text;
}
export function kernelProjection(release) {
  need(typeof release === 'string' && Buffer.byteLength(release) <= 256 && !release.includes('\0'));
  const match = /^([0-9]{1,5})\.([0-9]{1,5})\.([0-9]{1,5})(?:[-+.][A-Za-z0-9.+_-]{1,128})?$/.exec(release);
  need(match !== null);
  return { releaseSha256: digest(Buffer.from(release)), releaseBytes: Buffer.byteLength(release),
    numericVersion: match.slice(1,4).map(safeInteger), exactVersionRetained: false };
}
function collect() {
  const deadline = performance.now() + 50000, budget = { files: 0, bytes: 0 };
  const context = validateContext(process.env);
  need(process.platform === 'linux' && process.version === 'v22.23.0');
  need(['x64','arm64'].includes(process.arch) && process.versions.napi === '10');
  const kernel = kernelProjection(os.release());
  const status = statusProjection(boundedInput('/proc/self/status', deadline));
  const mount = mountProjection(boundedInput('/proc/self/mountinfo', deadline));
  need(fs.statfsSync('/proc/self', { bigint: true }).type === 0x9fa0n);
  mount.ownPathFilesystemVerified = true;
  const namespaces = ['pid','mnt','user'].map(kind => namespaceProjection(kind,
    fs.readlinkSync(`/proc/self/ns/${kind}`), fs.readlinkSync(`/proc/self/ns/${kind}`)));
  const node = fileHash(process.execPath, TOOL_CAP, budget, deadline);
  const sources = ['metadata.mjs','owner.py','protocol.json'].map(name => ({ slot: name,
    ...fileHash(new URL(name, import.meta.url), INPUT_CAP, budget, deadline) }));
  deadlineCheck(deadline);
  return { protocol: 'jev-linux-own-process-metadata-v2', status: 'METADATA_COMPLETE', context,
    platform: 'LINUX', architecture: process.arch === 'x64' ? 'X86_64' : 'ARM64',
    kernel,
    ownProcess: status, procfs: mount, namespaces,
    node: { version: '22.23.0', napi: 10, ...node, provenance: 'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION' },
    sources, hashBudget: { selectedFiles: budget.files, totalBytes: budget.bytes },
    platformCredentials: 'ACTIONS_PLATFORM_CREDENTIALS_NOT_ABSENT', compilerQualified: false,
    targetAccessQualified: false, threadEnumerationQualified: false, nativeQualified: false,
    runtimeAccepted: false, laterObserverMustRemeasure: true, continuousCoverageClaimed: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(canonicalResult(collect())); }
  catch { process.stderr.write('LINUX_METADATA_REFUSED\n'); process.exitCode = 2; }
}
