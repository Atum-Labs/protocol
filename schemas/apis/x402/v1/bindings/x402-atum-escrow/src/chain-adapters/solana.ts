/**
 * Solana source address/asset helpers. The Ed25519 escrow-deposit crypto (build the
 * domain-separated deposit hash, sign it, verify against the disclosed delegate_signer)
 * now lives in the shared `@atum-labs/payment-request-sender-auth` SDK; this adapter only
 * resolves the two chain-form values the SDK does not: the payer's `source.account`
 * (the signer's base58 public key) and the CAIP-19 (`spl`) asset identifier.
 */

import { asEd25519Signer, type AuthSigner, type ChainAdapter } from './types';

export const solanaAdapter: ChainAdapter = {
  async getAddress(signer: AuthSigner): Promise<string> {
    return asEd25519Signer(signer, 'solana', 'SolanaSigner').publicKey;
  },

  assetIdentifier(network: string, asset: string): string {
    // `spl` here, and the reason recorded honestly, because two of the three reasons this
    // comment used to give were not true.
    //
    // NOT true: the FulfillmentQuote schema does not key on it —
    // `FulfillmentQuote/v1/schema.json` has zero `solana` occurrences and no pattern on its
    // CAIP-19 field. NOT true: solver-gw corridor matching does not key on it either — its
    // `GetAssetSymbol` resolves the token by `(caip2, assetReference)` and DISCARDS the asset
    // namespace, so a spelling change cannot drop an auction there. What IS true is that the
    // live settler chain-plugin configs declare Solana assets as `spl`, which is why this stays
    // `spl` rather than being flipped to the `token` that ONCHAIN_SPEC.md ratifies.
    //
    // This value reaches the SIGNED destination commitment (see ../client/index.ts), so the
    // spelling matters more here than a corridor label would. It is nonetheless safe today, and
    // for a reason worth knowing before changing anything: the destination is derived ONCE per
    // payment and transported verbatim — the release signer reads the identifier back off the
    // stored request rather than re-deriving it (atum-core
    // solver-gw/.../pubsub_msg_handlers.go: SelectCommittedDestination then BuildDestination),
    // so both signers hash the same bytes whichever spelling this returns. See the
    // single-derivation test in ../client/sender-signer.test.ts, which pins that property.
    //
    // Converging on one spelling is still worth doing; it needs a settler-side corridor check
    // first, which cannot be made from this repo.
    return `${network}/spl:${asset}`;
  },

  // Solana addresses are base58 in both the witness and the request body — no conversion.
  normalizeRoleAddress(addr: string): string {
    return addr;
  },
};
