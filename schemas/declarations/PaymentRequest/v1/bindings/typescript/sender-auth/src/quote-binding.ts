// Binds a FulfillmentQuote to the payment request the caller stored, by depositRequestHash v2.
// Mirrors quote_binding.go.

import { CommitmentError, echo, emptyResult, refuse } from './commitment-rules.js';
import { isObject } from './commitment-permit.js';
import { readDepositRequest, refuseDepositRequest } from './deposit-request-v2.js';
import type { DepositRequest } from './deposit-request-v2.js';
import { decodeUtf8, firstAmbiguousMember, wellFormed } from './json-members.js';

/**
 * Checks that a FulfillmentQuote quotes the payment request the caller stored, and returns the
 * stored request's terms. Act on those terms, never on the quote's copy.
 *
 * `quote` is the whole FulfillmentQuote as received. It is refused as `request_malformed` when its
 * member names are ambiguous, when it is not an object, or when `payment_request_json` is not a
 * string. Both the embedded `payment_request_json` and `storedRequest` are read with
 * `readDepositRequest`; a refusal of either is `request_malformed`, its detail prefixed with the copy
 * refused. The two must commit the same depositRequestHash v2, or the quote is refused as
 * `quote_request_mismatch`: the settler quoted terms other than the ones the payer signs.
 * Re-encoding that keeps the terms, such as storage in a JSONB column, does not change v2. The two
 * must also carry the same `deposit_nonce`, which v2 does not commit.
 *
 * It is always strict: it has no audit mode. Throws `CommitmentError` on refusal. Mirrors the Go
 * `VerifyQuoteRequestBinding`.
 */
export function verifyQuoteRequestBinding(
  quote: string | Uint8Array,
  storedRequest: string | Uint8Array,
): DepositRequest {
  const stored = readNamedCopy('the stored payment request', storedRequest);
  let text: string;
  let path: string | undefined;
  try {
    text = typeof quote === 'string' ? quote : decodeUtf8(quote);
    path = firstAmbiguousMember(text);
  } catch {
    return refuseDepositRequest('the quote is not a single valid JSON document');
  }
  if (path !== undefined) {
    return refuseDepositRequest(
      `the quote carries two members that differ only in letter case, at ${echo(path)}`,
    );
  }
  const root: unknown = JSON.parse(wellFormed(text));
  if (!isObject(root)) return refuseDepositRequest('the quote is not an object');
  const embedded = Object.hasOwn(root, 'payment_request_json')
    ? root.payment_request_json
    : undefined;
  if (typeof embedded !== 'string')
    return refuseDepositRequest('the quote has no payment_request_json string');
  const quoted = readNamedCopy("the quote's payment_request_json", wellFormed(embedded));
  if (quoted.depositRequestHashV2 !== stored.depositRequestHashV2) {
    return refuse(
      emptyResult(),
      'quote_request_mismatch',
      "the quote's payment_request_json does not commit the same terms as the stored payment request",
    );
  }
  // v2 does not commit an originator-executed deposit's nonce (the deposit id does), so it is
  // compared here: another nonce names another deposit.
  if (quoted.depositNonce !== stored.depositNonce) {
    return refuse(
      emptyResult(),
      'quote_request_mismatch',
      "the quote's payment_request_json does not carry the stored payment request's deposit_nonce",
    );
  }
  return stored;
}

/** `readDepositRequest` with its refusal detail prefixed by which copy was refused. */
function readNamedCopy(name: string, request: string | Uint8Array): DepositRequest {
  try {
    return readDepositRequest(request);
  } catch (e) {
    if (!(e instanceof CommitmentError)) throw e;
    return refuseDepositRequest(`${name}: ${e.result.detail}`);
  }
}
