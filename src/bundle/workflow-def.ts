/** Parse only verified bundle definitions in the Hub qualified-name dialect.
 * The portable standalone parser remains unchanged. The native parser sees
 * the local component, then the signed authored name is restored before any
 * store registration, definition hash, or calls-closure resolution. */
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { parseDef } from '../defs.ts';
import type { WorkflowDef } from '../types.ts';
import type { BundleManifest } from './types.ts';
import { isBundleWorkflowName } from './call-target.ts';

export function bundleDialectForManifest(manifest: BundleManifest): 'plain' | 'hub-qualified' {
  return Object.keys(manifest.workflows).some(name => name.includes('/')) ? 'hub-qualified' : 'plain';
}

export function parseBundleDef(raw: unknown, source?: string, baseDir?: string): WorkflowDef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return parseDef(raw, source, baseDir);
  const record = raw as Record<string, unknown>;
  const authored = record.name;
  if (typeof authored !== 'string' || !authored.includes('/') || !isBundleWorkflowName(authored))
    return parseDef(raw, source, baseDir);
  const local = authored.slice(authored.indexOf('/') + 1);
  const def = parseDef({ ...record, name: local }, source, baseDir);
  def.name = authored;
  return def;
}

export function loadBundleDefFile(file: string, dialect: 'plain' | 'hub-qualified'): WorkflowDef {
  const def = parseBundleDef(parseYaml(readFileSync(file, 'utf8')), basename(file), dirname(file));
  def.dir = file;
  Object.defineProperty(def, 'bundleDialect', {
    value: dialect, configurable: true, enumerable: false,
  });
  return def;
}
