import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/owenloop.mjs', import.meta.url));
const DEFS = join(ROOT, 'examples', 'workflows');
const CHECK_ARGS = ['check', 'improve', '--defs', DEFS, '--format', 'json'];

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: Buffer;
}

function spawnBin(args: string[], stdio: Parameters<typeof spawn>[2]['stdio']): ChildProcess {
  return spawn(process.execPath, [BIN, ...args], { cwd: ROOT, stdio });
}

function waitForClose(child: ChildProcess, stderr: Buffer[], timeoutMs = 10_000): Promise<ExitResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`child did not exit within ${timeoutMs}ms: ${Buffer.concat(stderr).toString('utf8')}`)));
    }, timeoutMs);

    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code, signal) => finish(() => resolve({ code, signal, stderr: Buffer.concat(stderr) })));
  });
}

async function runPiped(args: string[]): Promise<ExitResult & { stdout: Buffer }> {
  const child = spawnBin(args, ['ignore', 'pipe', 'pipe']);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  return { ...(await waitForClose(child, stderr)), stdout: Buffer.concat(stdout) };
}

async function runToFile(args: string[], outputPath: string): Promise<ExitResult> {
  const fd = openSync(outputPath, 'w');
  let child: ChildProcess;
  try {
    child = spawnBin(args, ['ignore', fd, 'pipe']);
  } finally {
    closeSync(fd);
  }
  const stderr: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  return waitForClose(child, stderr);
}

test('the executable drains complete JSON output to a pipe before exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-stdio-drain-'));
  try {
    const filePath = join(dir, 'report.json');
    const fileResult = await runToFile(CHECK_ARGS, filePath);
    const pipeResult = await runPiped(CHECK_ARGS);

    assert.deepEqual(
      { code: fileResult.code, signal: fileResult.signal },
      { code: 0, signal: null },
      fileResult.stderr.toString('utf8'),
    );
    assert.deepEqual(
      { code: pipeResult.code, signal: pipeResult.signal },
      { code: 0, signal: null },
      pipeResult.stderr.toString('utf8'),
    );

    const fileOutput = readFileSync(filePath);
    assert.ok(pipeResult.stdout.length > 64 * 1024, `piped output was only ${pipeResult.stdout.length} bytes`);
    assert.equal(
      pipeResult.stdout.length,
      fileOutput.length,
      `piped output was ${pipeResult.stdout.length} bytes; file output was ${fileOutput.length} bytes`,
    );
    assert.deepEqual(pipeResult.stdout, fileOutput, 'piped output differs from file output');
    assert.doesNotThrow(() => JSON.parse(pipeResult.stdout.toString('utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a closed stdout reader does not strand the executable', async () => {
  const child = spawnBin(CHECK_ARGS, ['ignore', 'pipe', 'pipe']);
  const stderr: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
  const closedReader = new Promise<void>((resolve, reject) => {
    const stdout = child.stdout!;
    const readOneHundredBytes = () => {
      const chunk = stdout.read(100) as Buffer | null;
      if (chunk === null) {
	stdout.once('readable', readOneHundredBytes);
	return;
      }
      try {
	assert.equal(chunk.length, 100, `reader received ${chunk.length} bytes before closing`);
	stdout.destroy();
	resolve();
      } catch (error) {
	child.kill('SIGKILL');
	reject(error);
      }
    };
    stdout.once('readable', readOneHundredBytes);
    stdout.once('end', () => reject(new Error('stdout ended before the reader received 100 bytes')));
  });

  const exited = waitForClose(child, stderr);
  await closedReader;
  const result = await exited;
  assert.deepEqual(
    { code: result.code, signal: result.signal },
    { code: 0, signal: null },
    result.stderr.toString('utf8'),
  );
});

test('the executable preserves a check error exit code', async () => {
  const result = await runPiped(['check', 'definitely-missing', '--defs', DEFS, '--format', 'json']);
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 1, signal: null });
  assert.match(result.stderr.toString('utf8'), /unknown workflow definition/);
});
