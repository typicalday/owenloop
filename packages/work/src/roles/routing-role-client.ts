/** A routed role sees only its exact broker grant, never the Hub bearer. */
import type { HubClient } from '../hub/client.ts';
import { createRoutingChildClient } from '../hub/routing-child-client.ts';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';

const refused = async (): Promise<never> => { throw new Error('routed Hub verb refused'); };

export function createRoutingRoleClient(handoff: RoutingHandoffV1): HubClient & {
  routed: ReturnType<typeof createRoutingChildClient>;
} {
  if (!handoff.broker || !handoff.definitionStage)
    throw new Error('routing role handoff incomplete');
  const routed = createRoutingChildClient(handoff);
  return {
    routed,
    getOrder: req => routed.getOrder(req),
    heartbeat: req => routed.heartbeat(req),
    release: req => routed.release(req),
    submit: req => routed.submit(req),
    ask: req => routed.ask(req),
    reject: req => routed.reject(req),
    requestApproval: req => routed.requestApproval(req),
    whatsNext: refused,
    answerApproval: refused,
    listPendingApprovals: refused,
    reportResolution: refused,
    whoami: refused,
    wake: refused,
    presencePing: refused,
    putFileArtifact: refused,
  };
}
