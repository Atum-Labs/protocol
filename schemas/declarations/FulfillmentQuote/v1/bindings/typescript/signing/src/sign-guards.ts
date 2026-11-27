// rejectCallerSuppliedVC throws when a caller passes a non-empty
// verifiableCredential to the base signer. The base signer covers quote
// terms only, so a VC here would never be signed. Failing loud stops it
// from being silently discarded. An absent or empty verifiableCredential
// is accepted, matching the empty slot the wire form reserves. Callers
// carrying credentials must use the VP signer.
export function rejectCallerSuppliedVC(quote: {
  verifiableCredential?: unknown;
}): void {
  const vc = quote.verifiableCredential;
  if (vc === undefined || vc === null) return;
  if (Array.isArray(vc) && vc.length === 0) return;
  throw new Error(
    "base signer does not carry verifiableCredential, use the VP signer for credentials"
  );
}
