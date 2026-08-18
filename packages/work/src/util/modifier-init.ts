import { readFileSync } from 'node:fs';

type Feedback = Array<{
  path?: unknown;
  reasons?: Array<{ at?: unknown; action?: unknown; requested?: unknown }>;
}>;

function usage(message: string): number {
  process.stderr.write(`owenloop util modifier-init: ${message}\n`);
  process.stderr.write('usage: owenloop util modifier-init --default <value>\n');
  return 2;
}

function feedbackRequested(env: Record<string, string | undefined>): string | undefined {
  const inline = env['OWENLOOP_FEEDBACK'];
  const file = env['OWENLOOP_FEEDBACK_FILE'];
  let raw: string | undefined;
  if (inline !== undefined) raw = inline;
  else if (file !== undefined) raw = readFileSync(file, 'utf8');
  if (raw === undefined) return undefined;
  const feedback = JSON.parse(raw) as Feedback;
  if (!Array.isArray(feedback)) throw new Error('OWENLOOP_FEEDBACK must be a JSON feedback array');
  let newest: { requested: string; at: number; position: number } | undefined;
  let position = 0;
  for (const owed of feedback) {
    if (!Array.isArray(owed.reasons)) continue;
    const rejection = [...owed.reasons].reverse().find((reason) => reason.action === 'reject');
    position++;
    if (typeof rejection?.requested !== 'string') continue;
    const at = typeof rejection.at === 'number' ? rejection.at : Number.NEGATIVE_INFINITY;
    if (
      newest === undefined
      || at > newest.at
      || (at === newest.at && position > newest.position)
    ) {
      newest = { requested: rejection.requested, at, position };
    }
  }
  return newest?.requested;
}

/** Resolve requested feedback first, then the order modifier hint, then default. */
export function resolveModifierInit(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): { value?: string; error?: string; usage?: true } {
  let fallback: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--default') return { error: `unknown argument '${arg}'`, usage: true };
    if (fallback !== undefined) return { error: '--default may only be specified once', usage: true };
    fallback = args[++i];
    if (fallback === undefined) return { error: 'missing value for --default', usage: true };
  }
  if (fallback === undefined) return { error: 'missing required option: --default', usage: true };
  try {
    const value = feedbackRequested(env) ?? env['OWENLOOP_MODIFIER'] ?? fallback;
    if (value === '' || /\s/.test(value)) return { error: 'resolved modifier must be a single word' };
    return { value };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function runModifierInit(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): number {
  const result = resolveModifierInit(args, env);
  if (result.error !== undefined) {
    if (result.usage) return usage(result.error);
    process.stderr.write(`owenloop util modifier-init: ${result.error}\n`);
    return 3;
  }
  process.stdout.write(`${result.value}\n`);
  return 0;
}
