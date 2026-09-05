/**
 * Is there enough room on this disk to START another piece of work?
 *
 * A shift's children are the heaviest writers on the machine: a clone, a
 * dependency install, a build tree, and a transcript per agent turn. When the
 * volume holding the work root fills, those children do not fail politely. The
 * incident this exists for is recorded in `loop.ts`'s `noteWorkerFailure`
 * docstring: a worker "exited 1 with no signal, killed by ENOSPC inside its own
 * error logging" — the process died while trying to say why it was dying, so
 * the shift saw a bare non-zero exit and re-offered the order onto the same
 * full disk, forever.
 *
 * WHY THIS REFUSES WORK INSTEAD OF STOPPING THE SHIFT. A full disk is a LOCAL
 * fault, like the vanished `TMPDIR` that `host-preflight.ts` answers for, but
 * unlike it a full disk SELF-HEALS: a large file gets deleted, a cache is
 * pruned, another process finishes and releases its scratch space. Exiting the
 * shift would turn a condition that commonly clears in minutes into an outage
 * that needs a human to notice and restart a daemon. So this gate does the one
 * thing that is both safe and reversible — it declines to take on NEW work,
 * keeps polling, and starts dispatching again by itself the moment space
 * returns. Work already in flight is left alone: killing a nearly-finished
 * child frees little and destroys everything it had done.
 *
 * WHAT IT DOES NOT PROMISE. This is a floor for STARTING work, not a guarantee
 * that a step will finish. Nothing here knows how much space the next order
 * needs, and a step that wants 40 GiB will still die on a disk holding 2. The
 * value of the gate is not that it prevents every ENOSPC; it is that when the
 * disk is the reason nothing is moving, a record says so by name instead of the
 * operator reading a wall of unexplained exit-1s.
 *
 * FAIL-OPEN, DELIBERATELY. If the free-space probe itself fails — an
 * unsupported filesystem, a platform without `statfs`, a path that races away
 * between the walk and the call — this reports `unknown` and the caller
 * dispatches. A disk check that refused work whenever it could not measure the
 * disk would convert its own blind spot into the total outage it exists to
 * prevent, and it would do so on exactly the exotic hosts least likely to be
 * debugged quickly. The measured failure mode is a full disk, not an
 * unmeasurable one.
 */

import { statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** One gibibyte, the default floor. */
const GIB = 1024 * 1024 * 1024;

/**
 * How much room the shift insists on before starting anything new.
 *
 * Chosen as a DISTRESS threshold rather than a sufficiency threshold. Below
 * roughly a gibibyte a general-purpose developer machine cannot complete a
 * dependency install or a build of any size, so nearly every order a shift
 * takes will die; above it, whether an order succeeds depends on the order, and
 * this module has no business guessing. The error to avoid is a floor set high
 * enough to refuse work that would have succeeded, because a shift that will
 * not take work is worse than a shift that occasionally loses one to ENOSPC —
 * which is why the default is low and the operator can lower it further.
 */
export const DEFAULT_DISK_FLOOR_BYTES = GIB;

/**
 * `--disk-floor` > `settings.diskFloorBytes` > the default, matching every
 * other shift tunable. `0` disables the gate: an operator who is deliberately
 * running a machine close to full, or who has hit a floor this module got
 * wrong, must be able to say so without downgrading the CLI.
 */
export function resolveDiskFloorBytes(
  flagFloor: number | undefined,
  settingsFloor: number | undefined,
): number {
  return flagFloor ?? settingsFloor ?? DEFAULT_DISK_FLOOR_BYTES;
}

/** The one filesystem call this module makes, as an injectable seam. */
export interface StatfsProbe {
  /** Bytes available to an unprivileged writer, or `undefined` if unmeasurable. */
  freeBytes: (path: string) => number | undefined;
  exists: (path: string) => boolean;
}

export const realStatfsProbe: StatfsProbe = {
  freeBytes: (path) => {
    try {
      const fs = statfsSync(path);
      /*
       * `bavail`, NOT `bfree`. `bfree` counts blocks the filesystem has reserved
       * for root, which this process cannot write into — reading it would let
       * the gate report several hundred megabytes of headroom that no child can
       * actually use, on precisely the full disk the gate exists to catch.
       */
      const free = Number(fs.bavail) * Number(fs.bsize);
      return Number.isFinite(free) && free >= 0 ? free : undefined;
    } catch {
      return undefined;
    }
  },
  exists: (path) => {
    try {
      statfsSync(path);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The nearest ancestor of `path` that exists, so free space can be measured for
 * a directory the shift has not created yet.
 *
 * A work root is normally absent on a first run — `resolveWorkRoot` defaults it
 * to `<cacheDir>/work` and `prepareWorkdir` mkdir -p's it on demand — so a
 * check that required the path to exist would report `unknown` on every clean
 * install and never fire when it mattered. This is the same premise that an
 * earlier draft of `host-preflight.ts` got wrong; the difference is that a
 * missing directory is not a fault here, merely a reason to ask its parent.
 *
 * Bounded by the walk reaching the filesystem root, where `dirname` becomes a
 * fixed point, so a path that exists nowhere terminates rather than looping.
 */
export function nearestExistingAncestor(path: string, fs: StatfsProbe): string | undefined {
  let current = resolve(path);
  for (;;) {
    if (fs.exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export type DiskSpace =
  | { state: 'ok'; path: string; freeBytes: number; floorBytes: number }
  | { state: 'low'; path: string; freeBytes: number; floorBytes: number }
  /** Unmeasurable, or the gate is switched off. The caller dispatches. */
  | { state: 'unknown'; path: string };

/** Render a byte count the way an operator reading a log line wants it. */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  return `${bytes} B`;
}

/**
 * Measure free space for the volume that will hold the shift's work.
 *
 * Returns `unknown` — never `low` — when the floor is disabled or the disk
 * cannot be measured, so that a caller written as `if (state === 'low')` treats
 * every uncertainty as permission to proceed.
 */
export function checkDiskFloor(
  workRoot: string,
  floorBytes: number,
  fs: StatfsProbe = realStatfsProbe,
): DiskSpace {
  if (floorBytes <= 0) return { state: 'unknown', path: workRoot };
  const probed = nearestExistingAncestor(workRoot, fs);
  if (probed === undefined) return { state: 'unknown', path: workRoot };
  const free = fs.freeBytes(probed);
  if (free === undefined) return { state: 'unknown', path: probed };
  return {
    state: free < floorBytes ? 'low' : 'ok',
    path: probed,
    freeBytes: free,
    floorBytes,
  };
}
