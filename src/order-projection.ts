import type { ClaimOrder, Order } from './types.ts';

/** Project a native persisted claim onto the frozen public order.v1 fields. */
export function publicOrderV1(order: ClaimOrder): Order {
  const { claimWorkdirInputV1: _private, ...publicOrder } = order;
  return publicOrder;
}
