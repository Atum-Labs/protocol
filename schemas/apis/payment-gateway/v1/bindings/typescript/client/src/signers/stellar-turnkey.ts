/**
 * SEAM(turnkey-stellar): Turnkey signing for Stellar is not supported yet, and refuses rather than guess.
 *
 * What is missing is Turnkey's Stellar address format and signing payload. Until both are confirmed
 * there is no `turnkeyAddressFormat` on the Stellar chain adapter, and the signer factory and the
 * Turnkey implementation both fail closed with this message, so no Stellar message is ever sent to a
 * Turnkey wallet. Use the raw (local key) signer for a Stellar delegate signer.
 *
 * To add Turnkey support, replace the two refusals marked `SEAM(turnkey-stellar)` in this package,
 * `createSenderSigner` in `./index.ts` and the `stellar` case of `signWithTurnkeyClient` in
 * `./turnkey-impl.ts`, and set `turnkeyAddressFormat` on the Stellar chain adapter. This file holds
 * only the shared message.
 */
export const STELLAR_TURNKEY_UNSUPPORTED =
  'Turnkey signing for Stellar is not supported yet: use the raw private-key signer for a Stellar delegate signer';
