/**
 * The atum-escrow wire contract as this package sees it — the generated bindings
 * plus the runtime validators compiled from the same JSON Schemas.
 *
 * Every type re-exported here is generated from a schema under
 * `schemas/` in this repo (the single source of truth), never hand-written. The
 * indirection through this module means the role mechanisms (client, server,
 * facilitator) import one name per concept and stay insulated from which binding
 * package a given type happens to live in.
 */

export type { AtumEscrowExtra, AtumEscrowPayload } from '@atum-labs/atum-escrow';
// The inner Atum PaymentRequest the atum-escrow payload carries. The canonical
// declaration is the source of truth, so the client builds — and the facilitator
// reads — a typed instance instead of a hand-rolled shape.
export type { PaymentRequest } from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript';

// Runtime validators compiled from the same JSON Schemas the types are generated
// from — for hardening inbound trust boundaries.
export { assertAtumEscrowExtra, assertAtumEscrowPayload } from './validate';
