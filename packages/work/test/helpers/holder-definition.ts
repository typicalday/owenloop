import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { finalizeDefs, loadDefFile } from '../../../../src/defs.ts';
import { defInstructionDigest } from '../../../../src/order-resolver.ts';
import { installBundleFixture, writeBundleSource } from '../../../../test/helpers/store-fixture.ts';

/** Install the plain builder used by real-process Hold MCP lease drills. */
export async function installHolderDefinition(home: string): Promise<string> {
  const workflow = `name: holder-drill
steps:
  - name: builder
    produces: [pr]
    terminal: true
    body: "Produce pr."
`;
  const sourceDir = writeBundleSource({ name: 'holder-drill', workflow });
  const installed = await installBundleFixture({
    sourceDir, root: join(home, '.owenloop', 'workflows'),
  });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  if (definition === undefined) throw new Error('holder drill definition was not installed');
  return defInstructionDigest(definition);
}

/** Installed objects are deliberately read-only; test teardown makes them writable. */
export function makeHolderStoreWritable(path: string): void {
  if (!existsSync(path)) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) makeHolderStoreWritable(child);
    else chmodSync(child, 0o600);
  }
}
