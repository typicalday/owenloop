/**
 * Is this machine still the machine the shift started on?
 *
 * A shift daemon is a long-lived process holding paths it resolved once, at
 * start, and one of those paths is not stable for the life of the process:
 * macOS gives each boot a fresh per-user temp directory
 * (`/var/folders/<a>/<b>/T`). A process that survives a reboot — or was started
 * before one and re-parented — keeps the OLD `TMPDIR` in its environment, and
 * that directory is gone.
 *
 * The fault does not announce itself. The shift keeps polling, every hub call
 * and every child spawn fails for a reason the error text attributes to the
 * network ("fetch failed"), and the daemon looks alive to `pgrep` and answers
 * `shift end` while dispatching nothing. It was measured wedged this way for 42
 * minutes with no record naming the cause.
 *
 * WHAT THIS MODULE IS FOR, AND WHAT IT IS NOT FOR. It answers exactly one
 * question: "is a LOCAL, non-self-healing fault the reason this shift cannot
 * work?" It is deliberately not a health check and not a reachability probe. A
 * hub outage, a Cloudflare 1015 ban, an expired credential and a flaky DHCP
 * lease are all REMOTE and all self-heal without operator action, so this
 * module must report them clean — the caller's whole decision rests on that
 * split, because a clean answer means "keep polling" and a dirty one means
 * "stop, a human must fix the host".
 *
 * PURE AND INJECTABLE. Every filesystem call is taken through `FsProbe` so the
 * caller's tests can present a missing temp directory without one, and so a
 * probe that itself throws is reported as a fault rather than crashing the
 * shift.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Which of the shift's own directories a fault was found in. */
export type HostPathRole = 'temp-dir';

export interface HostFault {
  /**
   * The stable machine discriminator. The three kinds are separate because
   * they have different operator fixes: a missing temp directory means the host
   * rebooted and the shift must be restarted from a fresh shell, while an
   * unwritable one means a permission change that restarting will not repair.
   */
  kind: 'missing' | 'not-a-directory' | 'unwritable';
  role: HostPathRole;
  path: string;
  /** Operator-facing text: what is wrong, why it happened, and what to do. */
  message: string;
}

/** The filesystem calls this check makes, as one injectable seam. */
export interface FsProbe {
  isDirectory: (path: string) => boolean;
  exists: (path: string) => boolean;
  isWritable: (path: string) => boolean;
}

export const realFsProbe: FsProbe = {
  exists: (path) => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isWritable: (path) => {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The path checked, and DELIBERATELY only this one.
 *
 * A shift also holds a state directory, a bundle cache directory and a work
 * root, and none of them is here: the shift CREATES all three on demand
 * (`resolveWorkRoot` defaults the work root to `<cacheDir>/work`, and
 * `prepareWorkdir` mkdir -p's it), so their absence is a normal first-run
 * condition rather than a fault. A check that treated it as one would refuse to
 * start every fresh install — which is exactly what an earlier draft of this
 * module did, and what the suite caught. The temp directory is the one path the
 * shift depends on, does not create, and cannot recover on its own.
 *
 * The operator's `--work-root` list is a different thing again: it NARROWS
 * which roots an order may name rather than supplying a directory the shift
 * writes to, and losing one of several does not stop the shift serving orders
 * that name the others. If it is ever worth checking, it is worth checking as
 * its own decision, not folded in here.
 */
export interface HostPaths {
  /** Absent means "read the live `TMPDIR`", which is what the shift itself uses. */
  tempDir?: string;
}

const REMEDY: Record<HostPathRole, string> = {
  'temp-dir':
    'the host\'s temp directory changed, which a reboot does — stop this shift and start a new one from a fresh shell so it inherits the current TMPDIR',
};

const LABEL: Record<HostPathRole, string> = {
  'temp-dir': 'TMPDIR',
};

function checkOne(role: HostPathRole, path: string, fs: FsProbe): HostFault | undefined {
  if (!fs.exists(path)) {
    return { kind: 'missing', role, path, message: `${LABEL[role]} '${path}' no longer exists — ${REMEDY[role]}` };
  }
  if (!fs.isDirectory(path)) {
    return {
      kind: 'not-a-directory',
      role,
      path,
      message: `${LABEL[role]} '${path}' is not a directory — ${REMEDY[role]}`,
    };
  }
  if (!fs.isWritable(path)) {
    return {
      kind: 'unwritable',
      role,
      path,
      message: `${LABEL[role]} '${path}' is not writable by this process — ${REMEDY[role]}`,
    };
  }
  return undefined;
}

/**
 * Report every local host fault, in a fixed role order so a reader comparing
 * two records sees the same fault in the same position.
 *
 * The return is an array rather than a single fault so that adding a second
 * role later does not change this function's contract, and so a caller never
 * has to ask whether the one fault it was handed was the only one. An empty
 * array means "no local fault" — which the caller must read as "the cause is
 * elsewhere", never as "the shift is healthy".
 */
export function checkHost(paths: HostPaths, fs: FsProbe = realFsProbe): HostFault[] {
  const candidates: Array<[HostPathRole, string | undefined]> = [
    ['temp-dir', paths.tempDir ?? tmpdir()],
  ];
  const faults: HostFault[] = [];
  for (const [role, path] of candidates) {
    if (path === undefined || path === '') continue;
    const fault = checkOne(role, path, fs);
    if (fault !== undefined) faults.push(fault);
  }
  return faults;
}
