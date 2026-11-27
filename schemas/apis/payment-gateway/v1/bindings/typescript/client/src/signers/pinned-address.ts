/**
 * Guard for the pinned sender address shared by both providers.
 *
 * Omitting `pinnedAddress` opts out of the sender check deliberately. An empty value must
 * not do the same silently: it is a caller that meant to pin a sender and passed nothing
 * (an unset variable, a blank CLI argument), so it is rejected before anything is signed.
 * The value is returned as given, never trimmed, so a padded address surfaces as the
 * mismatch it is rather than being rewritten here.
 */
export function requirePinnedSender(pinnedAddress: string | null | undefined): string | undefined {
  if (pinnedAddress === null || pinnedAddress === undefined) return undefined;
  // typeof: an untyped caller can reach this with a number or an object, which would
  // otherwise fail on .trim() with a message that names no cause.
  if (typeof pinnedAddress !== 'string' || pinnedAddress.trim() === '') {
    throw new Error(
      'The sender address (pinnedAddress) must be a non-empty address. Pass the sender to check it against the signing wallet or key. SDK callers may omit pinnedAddress to skip that check.',
    );
  }
  return pinnedAddress;
}
