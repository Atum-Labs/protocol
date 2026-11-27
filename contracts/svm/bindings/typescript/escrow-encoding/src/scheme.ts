/**
 * The form of the message an escrow version's ed25519 signers sign over a witness hash. The
 * registry's `svmMessage` field names it; `''` (SCHEME_RAW_HASH) signs the 32 byte hash itself.
 */
export type MessageScheme = string;

/** Signs the 32 byte witness hash itself, the only form the v4 program verifies. */
export const SCHEME_RAW_HASH: MessageScheme = '';

/** The escrow operation a witness hash authorizes. Values match the Go WitnessKind. */
export enum WitnessKind {
  Deposit = 1,
  Reserve = 2,
  Release = 3,
  Refund = 4,
}

/**
 * Returns the message to sign for a witness hash under `scheme`. The raw hash scheme returns a
 * copy of the hash; an unknown scheme or kind, or a hash that is not 32 bytes, throws.
 */
export function signingBytes(scheme: MessageScheme, kind: WitnessKind, hash: Uint8Array): Uint8Array {
  if (!Number.isInteger(kind) || kind < WitnessKind.Deposit || kind > WitnessKind.Refund) {
    throw new Error(`unknown witness kind ${kind}`);
  }
  if (hash.length !== 32) {
    throw new Error(`witness hash must be 32 bytes, got ${hash.length}`);
  }
  if (scheme === SCHEME_RAW_HASH) {
    return Uint8Array.from(hash);
  }
  throw new Error(`unknown message scheme ${JSON.stringify(scheme)}`);
}

/**
 * Returns the message forms a client signature may take for an escrow signing with `scheme`.
 * The raw hash scheme accepts the raw hash only, as the v4 program does.
 */
export function acceptedForms(scheme: MessageScheme): MessageScheme[] {
  if (scheme === SCHEME_RAW_HASH) {
    return [SCHEME_RAW_HASH];
  }
  throw new Error(`unknown message scheme ${JSON.stringify(scheme)}`);
}
