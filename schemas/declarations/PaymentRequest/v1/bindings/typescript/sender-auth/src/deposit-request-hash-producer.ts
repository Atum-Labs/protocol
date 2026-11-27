// What a depositRequestHash producer reads from the payment gateway and sends back to it: the
// versions a deposit from a chain may be signed with, and the compatibility headers it may post with
// a body, naming the producer and the v2 it computed over the body.

import { readDepositRequest } from './deposit-request-v2.js';

/** A depositRequestHash version this build signs and reads. */
export type DepositRequestHashVersionNumber = 1 | 2;

/** The versions this build knows, ascending. */
const KNOWN_VERSIONS: readonly DepositRequestHashVersionNumber[] = [1, 2];

/**
 * The depositRequestHash versions a deposit from a chain may be signed with, from the payment
 * gateway's `GET /v1/defaults` entry for it, ascending and limited to the versions this build knows.
 *
 * `depositRequestHashVersions` (`deposit_request_hash_versions`) decides when published: `[1]` before
 * v2, `[1, 2]` while both are accepted, `[2]` once v1 is retired. A gateway that predates it publishes
 * only `depositRequestHashVersion` (`deposit_request_hash_version`), read as `[1, 2]` for 2 and `[1]`
 * otherwise. The result is empty when every published version is one this build does not know, so a
 * deposit it signed would be refused: upgrade.
 *
 * @throws If `depositRequestHashVersions` is present but not a non-empty array of positive
 *   integers, which no gateway publishes.
 */
export function depositRequestHashVersionsOf(defaults: {
  depositRequestHashVersion?: number | null;
  depositRequestHashVersions?: readonly number[] | null;
}): DepositRequestHashVersionNumber[] {
  const published: unknown = defaults.depositRequestHashVersions;
  if (published === undefined || published === null) {
    return defaults.depositRequestHashVersion === 2 ? [1, 2] : [1];
  }
  if (
    !Array.isArray(published) ||
    published.length === 0 ||
    !published.every((v) => Number.isInteger(v) && v >= 1)
  ) {
    throw new Error(
      `depositRequestHashVersions must be a non-empty array of positive integers, not ${JSON.stringify(published)}`,
    );
  }
  return KNOWN_VERSIONS.filter((v) => published.includes(v));
}

/**
 * The depositRequestHash versions a merchant publishes for a source in an x402 or MPP challenge, from
 * its chain's `GET /v1/defaults` entry: what {@link depositRequestHashVersionsOf} reads, or
 * `undefined` for `[1]`, which publishes nothing and which payers read as `[1]`.
 *
 * @throws If the entry's `depositRequestHashVersions` is malformed, or names no version this build
 *   signs, so every payment would be refused.
 */
export function publishedDepositRequestHashVersions(
  defaults: Parameters<typeof depositRequestHashVersionsOf>[0],
): DepositRequestHashVersionNumber[] | undefined {
  const versions = depositRequestHashVersionsOf(defaults);
  if (versions.length === 0) {
    throw new Error(
      `it accepts none this build signs, ${JSON.stringify(defaults.depositRequestHashVersions)}; upgrade this package`,
    );
  }
  return versions.length === 1 && versions[0] === 1 ? undefined : versions;
}

/**
 * What a producer may post with a payment request: who built the body, and the depositRequestHash v2
 * it computed over it. Send them as the `X-Atum-Producer` and `X-Atum-Deposit-Request-Hash-V2`
 * headers of `POST /v1/payments`. They are used for compatibility diagnostics only and never change
 * how the payment is processed.
 */
export interface DepositRequestHashShadow {
  /** What built the body, such as `sdk-ts`, `x402` or `mppx`. */
  producer: string;
  /**
   * The body's depositRequestHash v2, 0x + 64 lowercase hex. Absent when the strict reader refuses
   * the body, which no v2 deposit could pay.
   */
  depositRequestHashV2?: string;
}

/**
 * The shadow `producer` posts with `request`, the body exactly as it is posted, sender_auth
 * included. The v2 is read with `readDepositRequest`, as the gateway reads the body it receives, so
 * the two match unless the body changed between them or the readers disagree. It is compared, never
 * trusted, so it is sent whichever version the deposit signs.
 */
export function depositRequestHashShadowOf(
  request: string | Uint8Array,
  producer: string,
): DepositRequestHashShadow {
  try {
    return { producer, depositRequestHashV2: readDepositRequest(request).depositRequestHashV2 };
  } catch {
    return { producer };
  }
}
