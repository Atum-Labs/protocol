import { AtumError } from './types';
import { catalog } from './catalog_data';

/**
 * What a caller should do next. The set is closed, but a value outside it just
 * means a newer server than this binding, so compare against these and treat an
 * unrecognised value as unclassified rather than rejecting the response.
 *
 * Re-sending the same `request_id` is an idempotent replay and always safe. This
 * is about submitting a NEW `request_id`, which creates a new payment.
 */
export type RetryClassification =
  /** No payment was created and the condition is transient. Re-send after a delay. */
  | 'RETRY_AFTER_DELAY'
  /** Outcome unknown. Check the payment before a new `request_id` or risk paying twice. */
  | 'RECONCILE_THEN_DECIDE'
  /** Terminal, and no settlement was ever awarded, so a fresh `request_id` is safe. */
  | 'RETRY_WITH_NEW_IDENTIFIER'
  /** Still running. Poll its status; do not submit a new `request_id` yet. */
  | 'POLL_FOR_COMPLETION'
  /**
   * The request is wrong. Fix it and re-send. Whether the same `request_id` may be
   * reused is answered by `request_id_reusable`, not by this value.
   */
  | 'NOT_RETRYABLE_FIX_REQUEST'
  /** The operation had already completed. Read its state rather than submitting. */
  | 'ALREADY_DONE'
  /** Not resolvable by the caller. Quote `request_id`. */
  | 'CONTACT_SUPPORT';

/**
 * ErrorResponse is the only error shape returned to integrators. It is derived
 * from an internal AtumError via toErrorResponse. Never serialize a raw AtumError: its
 * message and details may contain sensitive detail. Kept in sync with the Go
 * ErrorResponse.
 */
export interface ErrorResponse {
  /** Public error category in SCREAMING_SNAKE_CASE. Many internal codes may map to one. */
  code: string;
  /** Curated, safe message shown to the user. */
  message: string;
  /** Correlation id the user quotes to support to find the internal record. */
  request_id?: string;
  /**
   * The payment this error was raised against. Absent when the error is not about
   * a specific payment, which is every error raised before a payment exists.
   */
  payment_id?: string;
  /** Docs page for this code. */
  docs_url?: string;
  /** Originating service domain. */
  domain?: string;
  /**
   * What the caller should do next. Absent means unclassified, which is not the
   * same as safe to retry.
   *
   * Typed as `string`, not the {@link RetryClassification} union, so a body from
   * any generated client stays assignable to this shape and an unrecognised value
   * from a newer server is carried rather than rejected. Narrow with the union
   * when you branch. `domain` is a plain string here for the same reason.
   */
  retry_classification?: string;
  /**
   * Whether the caller may re-send this same `request_id`. True means no payment
   * was created for it, so the id is still free. False means a payment exists for
   * it, so the id is spent and re-sending only replays this outcome.
   *
   * Absent means undetermined, and a caller should read that as false. Separate
   * from {@link ErrorResponse.retry_classification} on purpose, which answers what
   * the caller must change rather than whether the id survived.
   */
  request_id_reusable?: boolean;
}

// Every entry carries a classification and the fallback carries none, so the two
// are different shapes rather than one shape with an optional key. A union keeps
// that: a consumer narrowing to an entry gets the field as a guarantee, and the
// only way to reach the unclassified case is the fallback branch.
type Entry = (typeof catalog.entries)[keyof typeof catalog.entries];
type CatalogEntry = Entry | typeof catalog.fallback;

function entryFor(code: string): CatalogEntry {
  const entries = catalog.entries as Record<string, Entry>;
  // Own-property check so a code like "toString" falls back instead of
  // resolving up the prototype chain.
  return Object.prototype.hasOwnProperty.call(entries, code)
    ? entries[code]
    : catalog.fallback;
}

function docsUrl(slug: string): string {
  return slug ? catalog.docs_base_url + slug : '';
}

/**
 * toErrorResponse maps an internal AtumError to its ErrorResponse via the catalog. An
 * unknown code falls back to INTERNAL_ERROR, so an internal message never leaks.
 * Empty optional fields are omitted to match the Go binding's key set.
 */
export function toErrorResponse(err: AtumError): ErrorResponse {
  const entry = entryFor(err.code);
  const url = docsUrl(entry.docs_slug);
  const pub: ErrorResponse = {
    code: entry.public_code,
    message: entry.public_message,
  };
  if (err.request_id) pub.request_id = err.request_id;
  if (err.payment_id) pub.payment_id = err.payment_id;
  if (url) pub.docs_url = url;
  if (err.domain) pub.domain = err.domain;
  // The narrowing is the point: the fallback has no such key, so the compiler
  // makes the unclassified case impossible to forget.
  if ('retry_classification' in entry && entry.retry_classification) {
    pub.retry_classification = entry.retry_classification;
  }
  // Presence matters here, not truthiness: false is a meaningful answer and must
  // not be dropped the way an empty string would be.
  if ('request_id_reusable' in entry && entry.request_id_reusable !== undefined) {
    pub.request_id_reusable = entry.request_id_reusable;
  }
  return pub;
}

/**
 * httpStatus is the status a handler should respond with. Sent as the response
 * status, not in the body.
 */
export function httpStatus(err: AtumError): number {
  return entryFor(err.code).http_status || 500;
}
