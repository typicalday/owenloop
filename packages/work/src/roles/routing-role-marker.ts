/** Classify routed role markers before any settings or credential lookup.
 * Shift legitimately inherits the literal nonsecret opt-out `0` into ordinary
 * children. An injected environment cannot hide a routed ambient marker. */
export function routingRoleMarker(
  env: Record<string, string | undefined>,
  ambient: Record<string, string | undefined> = process.env,
): 'ordinary' | 'routed' | 'invalid' {
  const sources = env === ambient ? [env] : [env, ambient];
  if (sources.length === 2
    && Object.hasOwn(env, 'OWENLOOP_ROUTING_HANDOFF')
    && Object.hasOwn(ambient, 'OWENLOOP_ROUTING_HANDOFF')
    && env.OWENLOOP_ROUTING_HANDOFF !== ambient.OWENLOOP_ROUTING_HANDOFF) return 'invalid';
  let routed = false;
  for (const source of sources) {
    if (Object.hasOwn(source, 'OWENLOOP_ROUTING_HANDOFF')
      || Object.hasOwn(source, 'OWENLOOP_ROUTING_HOLDER')) routed = true;
    const session = source.OWENLOOP_ROUTING_SESSION;
    if (session !== undefined && session !== '0' && session !== '1') return 'invalid';
    if (session === '1') routed = true;
  }
  return routed ? 'routed' : 'ordinary';
}

/** Shift emits this one ordered argv shape for a routed worker. Reject a
 * duplicate flag even when the parser's final value matches the handoff. */
export function exactRoutedRoleArgs(args: string[], target: { workflow: string; run: string },
  origin: string | undefined, shift: string | undefined): boolean {
  return !!origin && !!shift && args.length === 5
    && args[0] === `${target.workflow}/${target.run}`
    && args[1] === '--origin' && args[2] === origin
    && args[3] === '--shift' && args[4] === shift;
}
