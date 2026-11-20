import type { ConsumedVerifier } from '../consumed-verifier.ts';

/** The v2 admission resolves the complete signed step before filtering human
 * inputs. Its callsProducers is the verified full-step closure; resolving the
 * filtered packet again would wrongly demand the removed human workdir seed. */
export function routedProducerVerifier(strictConsumed: ConsumedVerifier): ConsumedVerifier {
  return async (order, opts) => {
    try {
      const checked = await strictConsumed(order, { ...opts, hardRule: true });
      return checked.ok ? checked : { ok: false, reason: 'routed consumed proof refused' };
    } catch { return { ok: false, reason: 'routed consumed proof refused' }; }
  };
}
