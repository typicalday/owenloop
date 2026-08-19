import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	assertShiftDaemonPlatform,
	resolveCap,
	resolveStateDirOverride,
	resolveMaxConcurrentAgents,
	resolveExecReserve,
	resolveLocalQueueHoldMs,
	resolveShiftName,
	parseArgs,
	reconcileStartupState,
	runShiftRuntime,
} from '../src/shift/runtime.ts';
import { createLockedRemovalCallbacks, withDispatchLock } from '../src/shift/loop.ts';
import {
  finalizeChildReservation,
  removeChildRecord,
  readChildRecords,
  readChildReservations,
  reconcileInFlight,
  reserveChild,
  startReservedChild,
  writeChildRecord,
} from '../src/shift/state.ts';

test('public Shift daemon fails explicitly on Windows while direct Shift remains the fallback', () => {
  assert.throws(
    () => assertShiftDaemonPlatform('win32'),
    /public Shift daemon is not supported on Windows.*named-pipe transport is not implemented.*use `owenloop work shift` directly/iu,
  );
  assert.doesNotThrow(() => assertShiftDaemonPlatform('darwin'));
  assert.doesNotThrow(() => assertShiftDaemonPlatform('linux'));
});

// C6 wired settings-file fallbacks into shift's cap + dir resolution. These pin
// the precedence: CLI flag > env var > settings file > built-in default.

test('resolveCap: --cap beats settings.dispatchCap beats the default 3', () => {
  assert.equal(resolveCap(7, 5), 7); // flag wins
  assert.equal(resolveCap(undefined, 5), 5); // settings when no flag
  assert.equal(resolveCap(undefined, undefined), 3); // built-in default
});

test('resolveStateDirOverride: flag > OWENLOOP_STATE_DIR > settings; else undefined', () => {
  assert.equal(resolveStateDirOverride('/flag', { OWENLOOP_STATE_DIR: '/env' }, '/settings'), '/flag');
  assert.equal(resolveStateDirOverride(undefined, { OWENLOOP_STATE_DIR: '/env' }, '/settings'), '/env');
  assert.equal(resolveStateDirOverride(undefined, {}, '/settings'), '/settings');
  assert.equal(resolveStateDirOverride(undefined, {}, undefined), undefined);
});

test('startup reconciliation cannot reap a re-dispatched shared-state record', () => {
	const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-startup-race-'));
	const stateDir = join(root, 'state');
	const firstPid = 111;
	const replacementPid = 222;
	try {
		writeChildRecord(stateDir, {
			workflow: 'wf1',
			run: 'run_startup_race',
			pid: firstPid,
			spawnedAt: 0,
			kind: 'agent-run',
		});
		const isAlive = (pid: number): boolean => pid === replacementPid;
		let injected = false;
		let competingReaped = 0;
		const startup = reconcileStartupState(stateDir, () => assert.fail('startup reconciliation must not defer'), {
			isAlive,
			dispatchLockOptions: {
				beforeOpen: () => {
					if (injected) return;
					injected = true;
					const competing = reconcileInFlight(stateDir, {
						isAlive,
						...createLockedRemovalCallbacks(stateDir),
					});
					competingReaped += competing.reaped.length;
					writeChildRecord(stateDir, {
						workflow: 'wf1',
						run: 'run_startup_race',
						pid: replacementPid,
						spawnedAt: 1,
						kind: 'agent-run',
					});
				},
			},
		});

		assert.equal(startup?.reaped.length, 0, 'the startup sweep did not remove the replacement');
		assert.equal(competingReaped, 1, 'exactly one reconciler removed the stale record');
		assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [replacementPid]);
		const current = reconcileInFlight(stateDir, {
			isAlive,
			...createLockedRemovalCallbacks(stateDir),
		});
		assert.equal(current.live.length + current.reserved.length, 1, 'the replacement keeps its capacity slot');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('startup reconciliation cannot cancel a replacement shared-state reservation', () => {
	const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-startup-reservation-race-'));
	const stateDir = join(root, 'state');
	const stale = reserveChild(stateDir, {
		workflow: 'wf1',
		run: 'run_startup_reservation_race',
		reservedAt: 0,
		childKind: 'agent-run',
		step: 'builder',
	});
	try {
		let injected = false;
		let competingAbandoned = 0;
		let replacement: ReturnType<typeof reserveChild> | undefined;
		const startup = reconcileStartupState(stateDir, () => assert.fail('startup reconciliation must not defer'), {
			dispatchLockOptions: {
				beforeOpen: () => {
					if (injected) return;
					injected = true;
					const competing = reconcileInFlight(stateDir, {
						...createLockedRemovalCallbacks(stateDir),
					});
					competingAbandoned += competing.abandoned.length;
					replacement = reserveChild(stateDir, {
						workflow: 'wf1',
						run: stale.reservation.run,
						reservedAt: Date.now(),
						childKind: 'agent-run',
						step: 'builder',
					});
				},
			},
		});

		assert.equal(startup?.abandoned.length, 0, 'the startup sweep did not cancel the replacement');
		assert.equal(competingAbandoned, 1, 'exactly one reconciler cancelled the stale reservation');
		assert.deepEqual(readChildReservations(stateDir), [replacement!.reservation]);
		assert.equal(existsSync(replacement!.gatePath), true, 'the replacement gate survives the startup reaper');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('startup reconciliation cannot reap a finalized replacement from a stale reservation', () => {
	const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-startup-finalized-race-'));
	const stateDir = join(root, 'state');
	const replacementPid = 222;
	const stale = reserveChild(stateDir, {
		workflow: 'wf1',
		run: 'run_startup_finalized_reservation_race',
		reservedAt: 0,
		childKind: 'agent-run',
		step: 'builder',
	});
	try {
		let injected = false;
		let competingAbandoned = 0;
		let replacementGate = '';
		const startup = reconcileStartupState(stateDir, () => assert.fail('startup reconciliation must not defer'), {
			isAlive: (pid) => pid === replacementPid,
			dispatchLockOptions: {
				beforeOpen: () => {
					if (injected) return;
					injected = true;
					const competing = reconcileInFlight(stateDir, {
						isAlive: (pid) => pid === replacementPid,
						...createLockedRemovalCallbacks(stateDir),
					});
					competingAbandoned += competing.abandoned.length;
					const replacement = reserveChild(stateDir, {
						workflow: 'wf1',
						run: stale.reservation.run,
						reservedAt: Date.now(),
						childKind: 'agent-run',
						step: 'builder',
					});
					const child = finalizeChildReservation(stateDir, replacement.reservation, {
						pid: replacementPid,
						spawnedAt: Date.now(),
						kind: 'agent-run',
						step: 'builder',
					});
					startReservedChild(stateDir, child);
					replacementGate = replacement.gatePath;
				},
			},
		});

		assert.equal(startup?.abandoned.length, 0, 'the startup sweep did not reap the replacement');
		assert.equal(competingAbandoned, 1, 'exactly one reconciler cancelled the stale reservation');
		assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [replacementPid]);
		assert.equal(existsSync(replacementGate), true, 'the replacement gate survives the startup reaper');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('startup gate settlement cannot overwrite a replacement reservation after child exit', () => {
	const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-startup-live-gate-reservation-race-'));
	const stateDir = join(root, 'state');
	const firstPid = 111;
	const stale = reserveChild(stateDir, {
		workflow: 'wf1',
		run: 'run_startup_live_gate_reservation_race',
		reservedAt: 0,
		childKind: 'agent-run',
		step: 'builder',
	});
	const firstChild = finalizeChildReservation(stateDir, stale.reservation, {
		pid: firstPid,
		spawnedAt: 0,
		kind: 'agent-run',
		step: 'builder',
	});
	try {
		let injected = false;
		let replacement: ReturnType<typeof reserveChild> | undefined;
		const startup = reconcileStartupState(stateDir, () => assert.fail('startup reconciliation must not defer'), {
			isAlive: (pid) => pid === firstPid,
			dispatchLockOptions: {
				beforeOpen: () => {
					if (injected) return;
					injected = true;
					withDispatchLock(stateDir, {}, () => {
						assert.equal(removeChildRecord(stateDir, firstChild.run, { pid: firstChild.pid }), true);
						replacement = reserveChild(stateDir, {
							workflow: 'wf1',
							run: firstChild.run,
							reservedAt: Date.now(),
							childKind: 'agent-run',
							step: 'builder',
						});
					});
				},
			},
		});

		assert.deepEqual(startup?.live, [], 'the stale observer did not retain the exited child');
		assert.deepEqual(readChildReservations(stateDir), [replacement!.reservation]);
		assert.equal(existsSync(replacement!.gatePath), true, 'the replacement gate survives stale settlement');
		const current = reconcileInFlight(stateDir, {
			isAlive: (pid) => pid === firstPid,
			...createLockedRemovalCallbacks(stateDir),
		});
		assert.equal(current.live.length + current.reserved.length, 1, 'the replacement retains capacity');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('startup gate settlement cannot overwrite a finalized replacement after child exit', () => {
	const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-startup-live-gate-finalized-race-'));
	const stateDir = join(root, 'state');
	const firstPid = 111;
	const replacementPid = 222;
	const stale = reserveChild(stateDir, {
		workflow: 'wf1',
		run: 'run_startup_live_gate_finalized_race',
		reservedAt: 0,
		childKind: 'agent-run',
		step: 'builder',
	});
	const firstChild = finalizeChildReservation(stateDir, stale.reservation, {
		pid: firstPid,
		spawnedAt: 0,
		kind: 'agent-run',
		step: 'builder',
	});
	try {
		let injected = false;
		let replacementToken = '';
		const isAlive = (pid: number): boolean => pid === firstPid || pid === replacementPid;
		const startup = reconcileStartupState(stateDir, () => assert.fail('startup reconciliation must not defer'), {
			isAlive,
			dispatchLockOptions: {
				beforeOpen: () => {
					if (injected) return;
					injected = true;
					withDispatchLock(stateDir, {}, () => {
						assert.equal(removeChildRecord(stateDir, firstChild.run, { pid: firstChild.pid }), true);
						const replacement = reserveChild(stateDir, {
							workflow: 'wf1',
							run: firstChild.run,
							reservedAt: 1,
							childKind: 'agent-run',
							step: 'builder',
						});
						const child = finalizeChildReservation(stateDir, replacement.reservation, {
							pid: replacementPid,
							spawnedAt: 1,
							kind: 'agent-run',
							step: 'builder',
						});
						startReservedChild(stateDir, child);
						replacementToken = replacement.reservation.token;
					});
				},
			},
		});

		assert.deepEqual(startup?.live, [], 'the stale observer did not retain the exited child');
		assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [replacementPid]);
		assert.equal(readChildRecords(stateDir)[0]?.gateToken, replacementToken, 'the replacement handoff remains intact');
		const current = reconcileInFlight(stateDir, {
			isAlive,
			...createLockedRemovalCallbacks(stateDir),
		});
		assert.equal(current.live.length, 1, 'the finalized replacement retains capacity');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// WO-4.3 serve-crew SELECTION contract, pinned at the parse layer. The wire
// meaning: no flag → serveCrews undefined, which run() resolves to `[]` at the
// call site (`parsed.serveCrews ?? []`), and the hub reads empty as "serve ALL
// the actor's crews" — i.e. the default is serve-all, NOT serve-none.
test('parseArgs --work-root: REPEATABLE and accumulating, unlike every other value flag', () => {
  // Repeatable rather than comma-split, because a directory path may legally
  // contain a comma and an operator should never have to know that.
  assert.equal(parseArgs([]).workRoots, undefined);
  assert.deepEqual(parseArgs(['--work-root', '/a']).workRoots, ['/a']);
  assert.deepEqual(parseArgs(['--work-root', '/a', '--work-root', '/b']).workRoots, ['/a', '/b']);
  assert.deepEqual(parseArgs(['--work-root=/a', '--work-root=/b']).workRoots, ['/a', '/b']);
});

test('parseArgs --serve-crews: comma-split, trim, drop-empties; no flag ⇒ undefined (→ [] at call site)', () => {
  // no flag: undefined here; run() turns this into [] via `parsed.serveCrews ?? []`.
  assert.equal(parseArgs([]).serveCrews, undefined);
  // space-form and =-form both parse to the same list.
  assert.deepEqual(parseArgs(['--serve-crews', 'a,b']).serveCrews, ['a', 'b']);
  assert.deepEqual(parseArgs(['--serve-crews=a,b']).serveCrews, ['a', 'b']);
  // trim each entry and drop empty segments.
  assert.deepEqual(parseArgs(['--serve-crews', ' a , ,b ']).serveCrews, ['a', 'b']);
  // an empty / whitespace-only value narrows to nothing ⇒ [] (still "serve all" downstream).
  assert.deepEqual(parseArgs(['--serve-crews', '']).serveCrews, []);
  assert.deepEqual(parseArgs(['--serve-crews', '   ']).serveCrews, []);
});

// ---- the agent-run budget ---------------------------------------------------

test('resolveMaxConcurrentAgents: --max-agents beats settings.maxConcurrentAgents beats the default 4', () => {
  assert.equal(resolveMaxConcurrentAgents(undefined, undefined), 4);
  assert.equal(resolveMaxConcurrentAgents(undefined, 2), 2);
  assert.equal(resolveMaxConcurrentAgents(9, 2), 9);
});

test('resolveExecReserve: --exec-reserve beats settings.execReserve beats the default 1', () => {
  assert.equal(resolveExecReserve(undefined, undefined), 1);
  assert.equal(resolveExecReserve(undefined, 2), 2);
  assert.equal(resolveExecReserve(0, 2), 0);
});

test('resolveLocalQueueHoldMs: flag beats settings.localQueueHoldMs beats the default 0', () => {
  assert.equal(resolveLocalQueueHoldMs(undefined, undefined), 0);
  assert.equal(resolveLocalQueueHoldMs(undefined, 2_000), 2_000);
  assert.equal(resolveLocalQueueHoldMs(0, 2_000), 0);
});

test('parseArgs reads --max-agents; absent leaves it undefined', () => {
  const on = parseArgs(['--max-agents', '6']);
  assert.equal(on.error, undefined);
  assert.equal(on.maxAgents, 6);
  assert.equal(parseArgs(['--max-agents=2']).maxAgents, 2);
  assert.equal(parseArgs([]).maxAgents, undefined);

  assert.match(parseArgs(['--max-agents', 'abc']).error!, /--max-agents must be a non-negative integer/);
  assert.match(parseArgs(['--max-agents']).error!, /missing value/);
});

test('parseArgs reads --exec-reserve; absent leaves it undefined', () => {
  const on = parseArgs(['--exec-reserve', '2']);
  assert.equal(on.error, undefined);
  assert.equal(on.execReserve, 2);
  assert.equal(parseArgs(['--exec-reserve=0']).execReserve, 0);
  assert.equal(parseArgs([]).execReserve, undefined);

  assert.match(parseArgs(['--exec-reserve', 'abc']).error!, /--exec-reserve must be a non-negative integer/);
  assert.match(parseArgs(['--exec-reserve']).error!, /missing value/);
});

test('parseArgs reads --local-queue-hold; absent leaves it undefined', () => {
  const on = parseArgs(['--local-queue-hold', '2000']);
  assert.equal(on.error, undefined);
  assert.equal(on.localQueueHoldMs, 2_000);
  assert.equal(parseArgs(['--local-queue-hold=0']).localQueueHoldMs, 0);
  assert.equal(parseArgs([]).localQueueHoldMs, undefined);

  assert.match(parseArgs(['--local-queue-hold', 'abc']).error!, /--local-queue-hold must be a non-negative integer/);
  assert.match(parseArgs(['--local-queue-hold']).error!, /missing value/);
});

// ---- session-unique shift name (shifts.md §6/§8 item 4) --------------------
//
// The hub keys presence rows by (principal, name), so two sessions on one
// machine in one directory under one identity must NOT resolve to the same
// default name — that flip-flopping-row defect is what resolveShiftName fixes.

test('resolveShiftName: default is host/dir#<first 6 hex of the cid, shf_ stripped>', () => {
  assert.equal(
    resolveShiftName(undefined, { shiftId: 'shf_7f3a2b91-aaaa-bbbb-cccc-dddddddddddd', hostname: 'box', cwd: '/a/proj' }),
    'box/proj#7f3a2b',
  );
});

test('resolveShiftName: two different cids on the same host+cwd produce two different names (the §6 defect, at the unit level)', () => {
  const a = resolveShiftName(undefined, { shiftId: 'shf_11111111-0000-0000-0000-000000000000', hostname: 'box', cwd: '/a/proj' });
  const b = resolveShiftName(undefined, { shiftId: 'shf_22222222-0000-0000-0000-000000000000', hostname: 'box', cwd: '/a/proj' });
  assert.notEqual(a, b);
});

test('resolveShiftName: an explicit --name wins verbatim — no suffix appended', () => {
  assert.equal(resolveShiftName('explicit', { shiftId: 'shf_7f3a2b91-aaaa' }), 'explicit');
});

test('resolveShiftName: with no shiftId, falls back to a p<pid> suffix', () => {
  assert.equal(resolveShiftName(undefined, { hostname: 'box', cwd: '/a/proj', pid: 4242 }), 'box/proj#p4242');
});

test('parseArgs rejects a blank --name (both forms) at parse time', () => {
  assert.match(parseArgs(['--name', '']).error ?? '', /--name requires a non-empty value/);
  assert.match(parseArgs(['--name=']).error ?? '', /--name requires a non-empty value/);
  assert.equal(parseArgs(['--name', 'shiftA']).name, 'shiftA'); // a real value still passes
});

// PHASE 5 deleted the legacy stamp path along with every flag that selected it.
// These are now UNKNOWN options, and an unknown option is a usage error — the
// point being that an operator running an old command line is told, not silently
// given a different behaviour.
test('the deleted stamp-path flags are unknown options, not silently ignored', () => {
	for (const flag of ['--no-stamp', '--runner-dispatch', '--settle-margin', '--agents-dir']) {
		assert.match(parseArgs([flag]).error ?? '', /unknown option/, `${flag} must be rejected`);
	}
});

test('runtime writes a corrupt-roster serving warning as one terminated stderr record', async () => {
	const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-serving-warning-'));
	const previous = {
		home: process.env.HOME,
		configDir: process.env.OWENLOOP_CONFIG_DIR,
		token: process.env.OWENLOOP_TOKEN,
	};
	const originalStderrWrite = process.stderr.write;
	let stderr = '';

	try {
		const crewDir = join(root, '.owenloop', 'crews');
		mkdirSync(crewDir, { recursive: true });
		writeFileSync(join(crewDir, 'broken.json'), '{not json');
		process.env.HOME = root;
		delete process.env.OWENLOOP_CONFIG_DIR;
		process.env.OWENLOOP_TOKEN = 'shift-runtime-test-token';
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stderr.write;

		assert.equal(await runShiftRuntime({
			origin: 'http://127.0.0.1:1',
			serveCrews: ['broken'],
			once: true,
			cacheDir: join(root, 'cache'),
			stateDir: join(root, 'state'),
		}), 0);

		const warning = stderr.split('\n').find((line) => line.includes('could not compute serving capabilities for "broken"'));
		assert.ok(warning, `missing serving warning in stderr: ${stderr}`);
		assert.equal(warning.includes('\\n'), false, 'the warning must end at a real newline');
	} finally {
		process.stderr.write = originalStderrWrite;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		if (previous.configDir === undefined) delete process.env.OWENLOOP_CONFIG_DIR;
		else process.env.OWENLOOP_CONFIG_DIR = previous.configDir;
		if (previous.token === undefined) delete process.env.OWENLOOP_TOKEN;
		else process.env.OWENLOOP_TOKEN = previous.token;
		rmSync(root, { recursive: true, force: true });
	}
});
