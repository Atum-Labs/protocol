// Hand-written, not generated. The generated files in this package are overwritten on every
// run, including index.ts, so this module is imported by its own subpath rather than re-exported
// from there.
//
// This is the TypeScript half of the verdict signing preimage. It exists because the framing was
// designed around JavaScript's behaviour, so having only the Go side assert the frozen vectors
// would leave the divergence the vectors were written to catch untested. Two reject vectors in
// each file exist for exactly this reason.

import type { DepositVerdict, FulfillmentVerdict } from './types.gen';

/** First line of every fulfillment verdict preimage. */
export const VERDICT_PREIMAGE_TAG = 'atum-verdict/fulfillment/1';

/** First line of every deposit verdict preimage. */
export const DEPOSIT_VERDICT_PREIMAGE_TAG = 'atum-verdict/deposit/1';

/** One rendered line's key and value. */
export interface PreimageMember {
  key: string;
  value: string;
}

/**
 * The fixed order the fulfillment preimage renders. Changing it, or the tag, invalidates every
 * signature ever issued.
 *
 * Every member is read with `?? ''` rather than interpolated, because an absent property
 * interpolates as the string `undefined` in JavaScript and would be signed as though it were a
 * value. That is the failure the frozen `key=0:` vectors pin.
 */
export function verdictSignedMembers(v: FulfillmentVerdict): PreimageMember[] {
  return [
    { key: 'domain', value: v.domain ?? '' },
    { key: 'payment_id', value: v.payment_id ?? '' },
    { key: 'chain_id', value: v.chain_id ?? '' },
    { key: 'outcome', value: (v.outcome as string) ?? '' },
    { key: 'block_number', value: v.block_number ?? '' },
    { key: 'block_hash', value: v.block_hash ?? '' },
    { key: 'finality_policy', value: v.finality_policy ?? '' },
    { key: 'transaction_hash', value: v.transaction_hash ?? '' },
    { key: 'fulfiller', value: v.fulfiller ?? '' },
  ];
}

/** The fixed order the deposit preimage renders. */
export function depositVerdictSignedMembers(v: DepositVerdict): PreimageMember[] {
  return [
    { key: 'domain', value: v.domain ?? '' },
    { key: 'payment_id', value: v.payment_id ?? '' },
    { key: 'chain_id', value: v.chain_id ?? '' },
    { key: 'escrow_address', value: v.escrow_address ?? '' },
    { key: 'outcome', value: (v.outcome as string) ?? '' },
    { key: 'block_number', value: v.block_number ?? '' },
    { key: 'block_hash', value: v.block_hash ?? '' },
    { key: 'finality_policy', value: v.finality_policy ?? '' },
    { key: 'transaction_hash', value: v.transaction_hash ?? '' },
  ];
}

/**
 * Byte length of a value, which is what the framing counts.
 *
 * `String.prototype.length` counts UTF-16 code units and MUST NOT be used here. Today the two
 * always agree, because `assertRenderable` refuses every non-ASCII value before a length is
 * taken, so the ASCII rejection is what actually prevents divergence and this function is the
 * second line rather than the first. It is exported and tested directly for that reason: if the
 * rejection is ever relaxed, for a non-ASCII `domain` say, this must already be counting bytes,
 * and a code-unit count would silently make the two languages sign different preimages for the
 * same verdict with each rejecting the other's signature.
 */
export function preimageValueByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Rejects a value that cannot appear in a preimage: anything outside printable ASCII, and the
 * two framing bytes.
 *
 * Throws rather than returning a flag, so a caller cannot proceed to sign a value this refused.
 */
function assertRenderable(key: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(
        `verdict member ${key} contains a non-printable or non-ASCII code unit at offset ${i}`,
      );
    }
    if (value[i] === '\n' || value[i] === '\r' || value[i] === '=') {
      throw new Error(`verdict member ${key} contains the framing byte ${JSON.stringify(value[i])}`);
    }
  }
}

/**
 * Builds the signed bytes for one attestation kind from its tag and its member list.
 *
 * The tag is the first line, so two kinds with different tags can never render to the same bytes
 * however similar their member lists are. One key can sign every kind for a chain, so that
 * separation is what stops a signature over one kind satisfying a verifier of the other.
 */
export function renderPreimage(tag: string, members: PreimageMember[]): string {
  let out = tag + '\n';
  for (const m of members) {
    assertRenderable(m.key, m.value);
    out += `${m.key}=${preimageValueByteLength(m.value)}:${m.value}\n`;
  }
  return out;
}

/** Derives the exact bytes a fulfillment verdict's signature covers. */
export function verdictSignedPayload(v: FulfillmentVerdict): string {
  if (v === null || v === undefined) {
    throw new Error('verdict is nil');
  }
  return renderPreimage(VERDICT_PREIMAGE_TAG, verdictSignedMembers(v));
}

/** Derives the exact bytes a deposit verdict's signature covers. */
export function depositVerdictSignedPayload(v: DepositVerdict): string {
  if (v === null || v === undefined) {
    throw new Error('deposit verdict is nil');
  }
  return renderPreimage(DEPOSIT_VERDICT_PREIMAGE_TAG, depositVerdictSignedMembers(v));
}
