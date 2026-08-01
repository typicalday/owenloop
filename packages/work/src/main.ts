/**
 * `owenloop work` entry point: parse argv, dispatch one execution role, and map
 * the role's returned code onto the process exit code.
 *
 * Exit-code contract (stable; roles and scripts depend on it):
 *   0  success, or `--help` / `help` / `--version`
 *   2  usage error — unknown or missing role, or a role's own arg validation
 *      failed (missing `--order`, missing `<order-id>`, …). Usage goes to stderr.
 *   3  a role is a not-yet-implemented skeleton stub. Distinct from 0 so a
 *      script can never mistake a stub's "did nothing" for real success.
 *
 * The role table contains loaders rather than imported functions. This keeps
 * `owenloop work settings` and `owenloop work lint` from evaluating unrelated
 * proxy, runner, or harness modules, and leaves the model SDK behind the
 * adapter's own dynamic import boundary.
 */
import { USAGE } from './usage.ts';

const VERSION = '0.0.0';

type Role = (args: string[]) => Promise<number>;
type RoleModule = { run: Role };
type RoleLoader = () => Promise<RoleModule>;

const ROLES: Record<string, RoleLoader> = {
  proxy: () => import('./roles/proxy.ts'),
  hold: () => import('./roles/hold.ts'),
  exec: () => import('./roles/exec.ts'),
  'agent-run': () => import('./roles/agent-run.ts'),
  prepare: () => import('./roles/prepare.ts'),
  lint: () => import('./roles/lint.ts'),
  settings: () => import('./roles/settings.ts'),
  release: () => import('./roles/release.ts'),
  join: () => import('./roles/join.ts'),
  sessions: () => import('./roles/sessions.ts'),
};

export async function mainAsync(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (first === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const loader = ROLES[first];
  if (loader === undefined) {
    process.stderr.write(`owenloop work: unknown command '${first}'\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  const module = await loader();
  return module.run(rest);
}
