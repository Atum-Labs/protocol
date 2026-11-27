/**
 * Per-chain address/asset helpers for the atum-escrow client and facilitator.
 *
 * The escrow-deposit crypto (build the authorization, sign it, recover/verify the
 * signer) now lives in the shared `@atum-labs/payment-request-sender-auth` SDK — the
 * client builds+signs through it and the facilitator verifies through it. What the SDK
 * does NOT provide, and what remains here, is the two chain-form conversions the flow
 * still needs: the payer's `source.account` in the chain's address form, and the CAIP-19
 * asset identifier. Selecting an adapter by CAIP-2 namespace ({@link getChainAdapter})
 * keeps the client and facilitator chain-agnostic around those two helpers.
 */

import type { Signer } from 'ethers';

/**
 * The minimal signer surface the secp256k1/EIP-712 adapters (EVM, Tron) need; an
 * `ethers.Wallet` — or a Turnkey/3PP `ethers.Signer` — satisfies it structurally.
 */
export type EscrowSigner = Pick<Signer, 'getAddress' | 'signTypedData'>;

/**
 * The signer surface an Ed25519 chain (Solana) needs. Deliberately NOT a raw
 * private key: a capability interface lets a local `tweetnacl` keypair today and a
 * remote Turnkey/3PP Solana signer later satisfy it with zero mechanism change (the
 * mechanism never sees key material). Ed25519 signatures are not public-key
 * recoverable, so the public key is carried explicitly for the verify side.
 */
export interface SolanaSigner {
  /** Base58 Ed25519 public key (the Solana address). */
  readonly publicKey: string;
  /** Ed25519-sign the raw message bytes, returning the 64-byte detached signature. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * The signer surface a Stellar source needs: an Ed25519 key, as on Solana, with no key
 * material exposed. The key is both the payer account and the key that signs the deposit: the
 * shared sender_auth library refuses a deposit whose `delegate_signer` is not `source.account`
 * (the check that a separate delegate is registered for the account is on-chain state it cannot
 * make). So the payer registers this account's own key as its delegate on the escrow
 * (`create_delegate`, plus the token `approve`) before paying. That skips the capped, separate
 * delegate key the escrow is designed around; the SDK refuses one too until it can verify the
 * registration, so a separately delegated payer cannot pay through this package.
 */
export interface StellarSigner {
  /** The Stellar account (`G…` strkey) of the Ed25519 key. */
  readonly publicKey: string;
  /** Ed25519-sign the raw message bytes, returning the 64-byte detached signature. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * Narrow the seam's signer union to the Ed25519 capability surface that Solana and Stellar share.
 * An EVM `ethers` signer exposes `signTypedData` and is a caller error on either chain.
 *
 * @param chain - the adapter's chain, as the error names it (`solana`, `stellar`)
 * @param typeName - the signer type the caller should have passed (`SolanaSigner`, `StellarSigner`)
 */
export function asEd25519Signer(
  signer: AuthSigner,
  chain: string,
  typeName: string,
): SolanaSigner | StellarSigner {
  if ('signTypedData' in signer) {
    throw new Error(`${chain} adapter requires an Ed25519 (${typeName}) signer`);
  }
  return signer;
}

/**
 * Any source signer a {@link ChainAdapter} accepts. `getAddress` narrows to the one it
 * needs ({@link EscrowSigner} for EVM/Tron, {@link SolanaSigner} for Solana,
 * {@link StellarSigner} for Stellar); the same union is what the client hands the sender_auth
 * SDK bridge ({@link toSenderSigner}).
 */
export type AuthSigner = EscrowSigner | SolanaSigner | StellarSigner;

/**
 * The per-chain address/asset seam. The escrow-deposit signing/verification lives in the
 * shared sender_auth SDK; these two helpers are the chain-form conversions the SDK does
 * not cover, so both the client (build) and the facilitator (verify) resolve them the
 * same way per chain.
 */
export interface ChainAdapter {
  /**
   * The payer/source account for a signer, in the chain's address form — becomes
   * `source.account`. Secp256k1 (EVM/Tron) derives it from the key; Solana reads the
   * signer's public key. Chain-specific, so the client stays chain-agnostic.
   */
  getAddress(signer: AuthSigner): Promise<string>;
  /**
   * The CAIP-19 asset identifier for a token on a network (e.g. `eip155:1/erc20:0x…`
   * or `solana:…/spl:…`). Owned by the adapter so the client (build) and the
   * facilitator (verify) reconstruct the identical string per chain.
   */
  assetIdentifier(network: string, asset: string): string;
  /**
   * Put a role/contract address (`quote_selector`, `fulfillment_verifier.account`)
   * into the canonical on-chain form the SIGNED WITNESS uses, so the top-level request
   * body is internally consistent with what the payer signed and with what the settlement
   * backend verifies against. EVM (already 0x-hex), Solana (base58) and Stellar (strkey) are identity; Tron
   * has two encodings — `/defaults` returns base58 (`T…`) but the witness carries the
   * 20-byte hex, so the Tron adapter normalizes base58 → hex here (mirroring the PGC SDK,
   * which normalizes exactly these role fields and deliberately leaves `escrow` base58).
   */
  normalizeRoleAddress(addr: string): string;
}
