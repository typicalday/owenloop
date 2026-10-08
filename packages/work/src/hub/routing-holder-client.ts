/** HubClient surface for a nested routed hold. Every operation uses a
 * holder-only broker cap; unimplemented verbs refuse without a network fallback. */
import type { HubClient } from './client.ts';
import { createRoutingChildClient } from './routing-child-client.ts';

export function createRoutingHolderClient(binding: {
  workflow: string; run: string; broker: { socketPath: string; cap: string };
}): HubClient {
  const child = createRoutingChildClient({ reservation: binding, broker: binding.broker });
  const supported = {
    getOrder: child.getOrder,
    heartbeat: child.heartbeat,
    submit: child.submit,
  };
  return new Proxy(supported, {
    get(target, property) {
      if (typeof property === 'string' && Object.hasOwn(target, property))
        return target[property as keyof typeof target];
      return async () => { throw new Error('routed holder verb unavailable'); };
    },
  }) as HubClient;
}
