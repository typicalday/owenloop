import type { CheckReport } from './types.ts';

const chunkSize = 64 * 1024;

function* reportJsonParts(report: CheckReport): Generator<string> {
  let separator = '{\n  ';
  for (const [key, value] of Object.entries(report)) {
    if (value === undefined) continue;
    yield separator;
    separator = ',\n  ';
    yield JSON.stringify(key) + ': ';
    if (!Array.isArray(value) || value.length === 0) {
      yield JSON.stringify(value, null, 2).replaceAll('\n', '\n  ');
      continue;
    }
    yield '[\n    ';
    for (const [index, item] of value.entries()) {
      if (index > 0) yield ',\n    ';
      yield (JSON.stringify(item, null, 2) ?? 'null').replaceAll('\n', '\n    ');
    }
    yield '\n  ]';
  }
  yield '\n}\n';
}

/** Emit the same pretty JSON without stringifying every witness at once. */
export async function writeCheckReportJson(
  report: CheckReport,
  write: (chunk: string) => Promise<boolean>,
): Promise<void> {
  let chunk = '';
  for (const part of reportJsonParts(report)) {
    chunk += part;
    if (chunk.length >= chunkSize) {
      if (!await write(chunk)) return;
      chunk = '';
    }
  }
  if (chunk) await write(chunk);
}
