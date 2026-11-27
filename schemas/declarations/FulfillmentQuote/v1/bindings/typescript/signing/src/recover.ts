// recoverSigner is a thin wrapper over verifyQuote that returns just the
// signerDID. It mirrors the Go package's RecoverSigner(signedQuoteJSON)
// helper — both exist so callers that only need the identity (e.g. the
// whitelist check at the gRPC perimeter) don't have to
// unpack the full VerifyResult or remember which field to read for
// which cryptosuite.

import { verifyQuote } from "./verify.js";

// recoverSigner verifies the proof and returns the recovered signer's
// did:pkh URI without the "#blockchainAccountId" fragment. Throws on
// any verification failure (missing proof, bad signature, malformed
// DID, etc.) — fail-closed by construction.
export async function recoverSigner(
  signedQuote: string | Record<string, unknown>
): Promise<string> {
  const result = await verifyQuote(signedQuote);
  return result.signerDID;
}
