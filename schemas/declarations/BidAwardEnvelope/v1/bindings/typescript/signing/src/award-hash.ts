import { keccak256, toUtf8Bytes } from "ethers";

/**
 * AWARD_HASH_DOMAIN_SEPARATOR namespaces the award_hash preimage so a value can
 * never collide with another protocol hash that concatenates the same fields.
 * The separator is hashed into proof.challenge, which ships to external clients
 * when this SDK signs an award on the quote-award flow, so it stays a stable
 * public string with no environment or ticket tagging that could not be changed
 * later without breaking verification everywhere. The "v1" suffix versions the
 * layout; bump it only if the preimage layout changes.
 *
 * MUST equal the Go binding's DomainSeparator
 * (schemas/declarations/BidAwardEnvelope/v1/signing/go) and the conformance
 * golden's domain_separator, or signed awards fail verification.
 */
export const AWARD_HASH_DOMAIN_SEPARATOR = "atum:award_hash:v1";

/**
 * computeAwardHash returns the award_hash binding for an award decision:
 *
 *   award_hash = "0x" + hex(keccak256(utf8(
 *       DOMAIN_SEPARATOR "\n" payment_id "\n" quote_hash "\n" settler_id)))
 *
 * The field order is FIXED and matches the Go binding byte-for-byte (pinned by
 * conformance/award-hash-golden.json). award_hash binds an award-authority VP to
 * a specific (payment_id, quote_hash, settler_id) award: it is the proof.challenge
 * the producer signs into the envelope and the verifier recomputes from the award
 * event, so a captured VP cannot be replayed across awards.
 *
 *   - paymentId: the deposit / settlement key (BidAwardEnvelope.payment_id).
 *   - quoteHash: the canonical content hash of the awarded FulfillmentQuote —
 *     MUST be the same canonical value used elsewhere, never a separately
 *     re-derived one.
 *   - settlerId:  the awarded settler id (BidAwardEnvelope.settler_id).
 *
 * Rejects empty inputs and inputs containing "\n" (separator-collision risk).
 *
 * SECURITY: this does NOT verify any signature — an equal award_hash does not
 * imply a valid VP; callers MUST verify the proof independently. award_hash is
 * signature-binding, NOT an identifier: never index by it, look a record up by
 * it, or commit it on-chain.
 */
export function computeAwardHash(
  paymentId: string,
  quoteHash: string,
  settlerId: string,
): string {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["payment_id", paymentId],
    ["quote_hash", quoteHash],
    ["settler_id", settlerId],
  ];
  for (const [name, value] of fields) {
    if (value === "") {
      throw new Error(`award_hash: ${name} is empty`);
    }
    if (value.includes("\n")) {
      throw new Error(
        "award_hash: input contains newline (separator collision risk)",
      );
    }
  }
  const preimage = [
    AWARD_HASH_DOMAIN_SEPARATOR,
    paymentId,
    quoteHash,
    settlerId,
  ].join("\n");
  // ethers keccak256 returns "0x"+lowercase-hex, matching the Go binding's
  // "0x"+common.Bytes2Hex(...) output.
  return keccak256(toUtf8Bytes(preimage));
}
