/**
 * Materialize the committed Claude Code plugin copies from their source files.
 *
 * The `_skills/` and `_hooks/` trees are the single source of truth. The copies
 * under `claude-code/plugin/` are committed because `claude plugin marketplace
 * add` reads a checkout directly; generating them only during `prepack` would
 * leave a fresh checkout unable to install the marketplace. Do not wire this
 * command into `prepack`, `build`, or `check`: the committed-output test must
 * detect drift rather than repairing drift before it is asserted. Run
 * `npm run materialize:plugins` after changing a source tree.
 */

import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

for (const [sourceRel, destinationRel] of [
  ['plugins/_skills', 'plugins/claude-code/plugin/skills'],
  ['plugins/_hooks', 'plugins/claude-code/plugin/hooks'],
]) {
  const source = join(ROOT, sourceRel);
  const destination = join(ROOT, destinationRel);
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}
