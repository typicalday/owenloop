import type { OrderPacket } from './types.ts';

/**
 * The hub order is still needed for lease and proof work, but these fields are
 * neither covered by consumed proofs nor checked against the local definition.
 * Keep them out of every model-facing copy until each has its own trust source.
 */
export function modelOrder(order: OrderPacket): OrderPacket {
  const projected = { ...order };
  delete projected.spec;
  delete projected.x;
  projected.owes = order.owes.map((owed) => {
    const safe = { ...owed };
    delete safe.schema;
    delete safe.schemaAppliesTo;
    delete safe.previousValue;
    return safe;
  });
  return projected;
}
