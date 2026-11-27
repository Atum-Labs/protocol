/**
 * The `request_id` recipe for the `atum-escrow` scheme — one definition, used by both sides.
 *
 * `request_id` is the payment's identity at the Atum gateway, which de-duplicates on it. The
 * payer derives it here; the facilitator rebuilds it here to confirm the payment really was
 * anchored to the merchant's per-intent key and to the page being paid for. Sharing the module is
 * what keeps those two from drifting into a check that silently passes everything.
 *
 * The identity is (page, identifier, account). The page is the resource string the resource
 * server publishes in `extra.atumResource` (method plus path and query, no host), so a payment
 * for one page can never resolve to, or be replayed as, a payment for another.
 *
 * The digest comes from the shared sender_auth SDK — the cross-language implementation the
 * settlement backend links against too — so the recipe cannot fork per language. It is kept
 * whole (256 bits): the payer picks the identifier, so a truncated id would let it search for two
 * identifiers whose ids collide across pages. What this
 * module adds is the page binding and the scheme's prefix. The prefix is part of the id, so
 * pinning it is what makes the facilitator's check exact: a client that computed the right
 * digest but varied the prefix between attempts would emit a different `request_id` each time,
 * and the gateway would treat every retry as a new payment.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import type { PaymentRequirements } from '@x402/core/types';
import { deterministicFullRequestId } from '@atum-labs/payment-request-sender-auth';

/**
 * The prefix every `atum-escrow` `request_id` carries. Cosmetic to the derivation (it is not
 * hashed) but fixed by the scheme, so the full id is reproducible from the anchor and account.
 */
export const ATUM_ESCROW_REQUEST_ID_PREFIX = 'req_x402_';

/** The `extra` key under which the resource server publishes the page a requirement pays for. */
export const ATUM_RESOURCE_EXTRA_KEY = 'atumResource';

/** Upper bound on a published resource string, in UTF-8 bytes. */
export const ATUM_RESOURCE_MAX_LENGTH = 2048;

/** Length of `value` in UTF-8 bytes, the unit {@link ATUM_RESOURCE_MAX_LENGTH} is counted in. */
export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Whether a resource string is non-empty and within {@link ATUM_RESOURCE_MAX_LENGTH} bytes. */
export function isValidAtumResource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    utf8ByteLength(value) <= ATUM_RESOURCE_MAX_LENGTH
  );
}

/** Whether a requirement's `extra` already carries {@link ATUM_RESOURCE_EXTRA_KEY}. */
export function hasAtumResource(requirements: Pick<PaymentRequirements, 'extra'>): boolean {
  return Object.prototype.hasOwnProperty.call(requirements.extra ?? {}, ATUM_RESOURCE_EXTRA_KEY);
}

/** Stable JSON: object keys sorted by code unit, array order kept, own enumerable keys only. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableJson(v))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === null ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  throw new Error(`atum-escrow: cannot serialize a query value of type ${typeof value}`);
}

/**
 * The canonical query of a page: `''` when the parsed query has no keys, otherwise `?` followed
 * by its stable JSON (keys sorted recursively, array order kept, so `a=1&a=2` differs from
 * `a=2&a=1`).
 *
 * @param params - the parsed query, as the framework's query parser produced it
 * @returns `''` or a string starting with `?`
 * @throws if `params` is not an object, or holds a value JSON cannot represent
 */
export function atumEscrowCanonicalQuery(params: unknown): string {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('atum-escrow: the parsed query must be an object');
  }
  return Object.keys(params).length === 0 ? '' : `?${stableJson(params)}`;
}

/**
 * Derive the `request_id` of an atum-escrow payment.
 *
 * @param identifier - the purchase's identifier, from the `payment-identifier` extension
 * @param account - the source account paying (`source.account`)
 * @param resource - the page paid for, as published in `extra.atumResource`
 * @returns the deterministic `request_id`
 * @throws if `identifier` or `resource` is empty
 */
export function atumEscrowRequestId(identifier: string, account: string, resource: string): string {
  if (!identifier) {
    throw new Error('atum-escrow: a purchase identifier is required to derive request_id');
  }
  if (!resource) {
    throw new Error('atum-escrow: the paid resource is required to derive request_id');
  }
  const resourceHash = keccak256(toUtf8Bytes(resource)).slice(2).toLowerCase();
  return deterministicFullRequestId({
    anchor: `${identifier}:${resourceHash}`,
    account,
    prefix: ATUM_ESCROW_REQUEST_ID_PREFIX,
  });
}

/**
 * The resource string for an HTTP request: upper-cased method, a space, the path, then the
 * canonical query. A pure string join, so nothing in the request can rewrite the path.
 *
 * @param method - the HTTP method
 * @param path - the routed request path, as received
 * @param query - the canonical query from {@link atumEscrowCanonicalQuery}
 * @returns e.g. `GET /reports/42?{"format":"pdf"}`
 */
export function atumEscrowResource(method: string, path: string, query: string): string {
  return `${method.toUpperCase()} ${path}${query}`;
}

/**
 * Read the resource string a requirement was published for.
 *
 * @param requirements - the requirement being paid
 * @returns the value of `extra.atumResource`
 * @throws if the key is missing, not a string, empty or over {@link ATUM_RESOURCE_MAX_LENGTH} bytes
 */
export function requireAtumResource(requirements: PaymentRequirements): string {
  const resource = (requirements.extra as Record<string, unknown> | undefined)?.[
    ATUM_RESOURCE_EXTRA_KEY
  ];
  if (!isValidAtumResource(resource)) {
    throw new Error(
      `atum-escrow: requirement is missing a valid extra.${ATUM_RESOURCE_EXTRA_KEY} ` +
        `(a non-empty string of at most ${ATUM_RESOURCE_MAX_LENGTH} UTF-8 bytes naming the paid page)`,
    );
  }
  return resource;
}
