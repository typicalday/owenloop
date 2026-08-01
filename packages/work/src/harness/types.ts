/**
 * Neutral harness-side types that are NOT part of the runtime session contract.
 *
 * `contract.ts` holds the things a running session needs (`StartArgs`,
 * `AgentEvent`, `HarnessSessionRef`, `StepPermissions`). This file holds the
 * things a harness declares ABOUT step definitions — today just `LintFinding`,
 * the shape `owenloop work lint` prints.
 *
 * ISOLATION RULE applies here exactly as it does to every other file under
 * `src/harness/`: no vendor name in this file, comments included. The adapter
 * modules are the only allowlisted exceptions, and the allowlist lives in
 * `test/harness-isolation.test.ts`, not here.
 */

/**
 * One finding from linting a single step's harness option bag (`x.harness`).
 *
 * `field` is the bag key the finding anchors to (`model`, `maxTurns`, …) and is
 * absent when the finding is about the bag as a whole. The caller renders the
 * location — `src/roles/lint.ts` prints `x.harness.<field>` — so a finding
 * carries the field NAME and never a rendered path.
 */
export interface LintFinding {
  severity: 'error' | 'warning';
  /** The step the finding is about. */
  step: string;
  /** The bag field it anchors to, when applicable (e.g. `model`, `maxTurns`). */
  field?: string;
  message: string;
}
