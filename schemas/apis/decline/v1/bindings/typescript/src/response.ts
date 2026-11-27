import { BidDecline } from './types';
import { catalog } from './catalog_data';

/**
 * PublicReason is the caller-facing projection of one decline reason. It is what a
 * requester is told about why a settler did not bid, and it never carries the settler's
 * own message: that is text this gateway neither authors nor validates. Kept in sync
 * with the Go PublicReason.
 */
export interface PublicReason {
  /** Public reason category in SCREAMING_SNAKE_CASE. Several internal codes may map to one. */
  code: string;
  /** Curated, safe message describing the reason. */
  message: string;
  /**
   * What would have to change for this settler to bid. Drawn from the error catalog's
   * closed set so a caller reads one vocabulary. It describes this decline only: the
   * authoritative instruction for the payment is the retry_classification on its own
   * error response.
   *
   * Optional on the wire, matching the published shape.
   */
  retry_classification?: string;
  /**
   * Link to the documentation for this reason. Absent rather than empty when the
   * catalog names no base url, so a reader never follows a link to the site root.
   */
  docs_url?: string;
}

type CatalogEntry = (typeof catalog.entries)[keyof typeof catalog.entries];

function entryFor(code: string): CatalogEntry {
  const entries = catalog.entries as Record<string, CatalogEntry>;
  // Own-property check so a code like "toString" falls back instead of
  // resolving up the prototype chain.
  return Object.prototype.hasOwnProperty.call(entries, code)
    ? entries[code]
    : catalog.fallback;
}

/**
 * reasonFor projects an internal reason code onto its public reason.
 *
 * An unknown code yields the fallback rather than throwing. A settler running a newer
 * catalog than this consumer is the expected case, not a fault, and counting it as OTHER
 * keeps a decline summary exhaustive instead of dropping the settler from the tally.
 */
export function reasonFor(code: string): PublicReason {
  const entry = entryFor(code);
  const url = catalog.docs_base_url && entry.docs_slug ? catalog.docs_base_url + entry.docs_slug : '';
  return {
    code: entry.public_code,
    message: entry.public_message,
    retry_classification: entry.retry_classification,
    ...(url ? { docs_url: url } : {}),
  };
}

/**
 * known reports whether the code is named in this catalog. Use it to tell "a reason we
 * deliberately bucket as OTHER" from "a reason we have never heard of", which reasonFor
 * alone cannot distinguish because both project to OTHER.
 */
export function known(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(catalog.entries, code);
}

/** toPublicReason projects a settler-reported decline onto its public reason. */
export function toPublicReason(decline: BidDecline): PublicReason {
  return reasonFor(decline.reason_code);
}
