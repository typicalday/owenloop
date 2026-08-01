import { appendFileSync } from 'node:fs';

const SDK = '@anthropic-ai/claude-agent-sdk';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === SDK || specifier.startsWith(`${SDK}/`)) {
    const traceFile = process.env.OWENLOOP_SDK_TRACE;
    if (traceFile) appendFileSync(traceFile, `${specifier}\n`, 'utf8');
  }
  return nextResolve(specifier, context);
}
