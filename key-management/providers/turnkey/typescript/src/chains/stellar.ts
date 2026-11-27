import { Keypair, StrKey, type Transaction } from '@stellar/stellar-sdk';

import {
  SignerErrorCode,
  signerTerminal,
  type Signer,
  type StellarIdentity,
  type StellarPrimitives,
} from '@atum-labs/km-core';

import type { TurnkeyClient } from '../client';
import { resolveTurnkeyAccountAddress, type TurnkeySignerCommonDeps } from '../signer-base';
import { encodePayload } from './ed25519-payload';

const ADDRESS_FORMAT = 'ADDRESS_FORMAT_XLM';

/**
 * Turnkey-backed Stellar signer. Import it from the `@atum-labs/turnkey-signer/stellar` subpath,
 * not the package root: `@stellar/stellar-sdk` is an optional peer dependency, and the root entry
 * must keep loading for consumers that do not have it.
 *
 * What Turnkey documents for Stellar (docs.turnkey.com, checked 2026-11-10): the account format
 * `ADDRESS_FORMAT_XLM` on `CURVE_ED25519`, and curve-level raw payload signing. It does NOT document
 * transaction parsing or a `TRANSACTION_TYPE_STELLAR`, so `signTransaction` here does not hand
 * Turnkey a transaction. It computes the transaction hash locally (SHA-256 of the signature
 * payload, which binds the network passphrase) and has Turnkey sign those 32 bytes as a raw
 * ed25519 message, `HASH_FUNCTION_NOT_APPLICABLE`: no hashing on Turnkey's side, which is what
 * Stellar's own signers do (ed25519 over the 32-byte hash).
 *
 * Consequence, and the reason this is not a policy boundary: Turnkey's policy engine sees the
 * payload of a raw signature as opaque. It cannot tell a Stellar transaction hash from any other
 * 32 bytes, so a stolen agent credential can sign any transaction with this key. Server-side
 * policy can only fence the activity shape, hash function and wallet account (see
 * `buildAllowStellarRawPayloadPolicy`). The settler's client-side `PolicyCheckedSigner` is what
 * inspects the transaction before it reaches this class, so this class must never be exposed
 * without it, and the key must hold no more than the settler needs.
 *
 * Every Turnkey result is verified locally against the pubkey Turnkey reported at `initialize()`,
 * and a transaction is verified against the LOCAL hash rather than anything Turnkey returns.
 */
export class TurnkeyStellarSigner implements Signer<StellarPrimitives> {
  private readonly client: TurnkeyClient;
  private readonly deps: TurnkeySignerCommonDeps;
  private ident: StellarIdentity | null = null;

  constructor(client: TurnkeyClient, deps: Omit<TurnkeySignerCommonDeps, 'client'>) {
    this.client = client;
    this.deps = { ...deps, client };
  }

  get identity(): StellarIdentity {
    if (!this.ident) throw notInitialized();
    return this.ident;
  }

  async initialize(): Promise<void> {
    const address = await resolveTurnkeyAccountAddress(this.deps, ADDRESS_FORMAT);
    // Turnkey's docs name the format but not its output. A G... account strkey is what the settler
    // pins and what a Stellar transaction's source account is, so anything else is refused here
    // rather than failing at the first signature.
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Turnkey ${ADDRESS_FORMAT} account address is not a G... ed25519 account strkey`,
      );
    }
    this.ident = {
      address,
      publicKey: new Uint8Array(StrKey.decodeEd25519PublicKey(address)),
    };
  }

  /** Raw ed25519 over `bytes`. Which bytes may reach this is decided by the policy layer above. */
  async signMessage(bytes: Uint8Array): Promise<Uint8Array> {
    const { address, publicKey } = this.identity;
    const { r, s } = await this.client.signRawPayload({
      signWith: address,
      ...encodePayload(bytes),
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    });
    // Turnkey returns an ed25519 signature as `r` and `s` with no recovery byte.
    const sig = Buffer.concat([Buffer.from(stripHex(r), 'hex'), Buffer.from(stripHex(s), 'hex')]);
    if (sig.length !== 64) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Stellar signMessage: signature length ${sig.length}, expected 64`,
      );
    }
    if (!verify(publicKey, bytes, sig)) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        'Stellar signMessage: ed25519 verify failed against the expected pubkey',
      );
    }
    return new Uint8Array(sig);
  }

  async signTransaction(tx: Transaction): Promise<Transaction> {
    const { address } = this.identity;
    if (tx.source !== address) {
      // The source account is the fee payer and the default signer. Another account's
      // transaction signed by this key is at best a wasted signature, so refuse it.
      throw signerTerminal(
        SignerErrorCode.SIGNER_ADDRESS_DRIFT,
        `Stellar signTransaction: source account is ${tx.source}, expected ${address}`,
      );
    }
    const hash = tx.hash();
    const sig = await this.signMessage(hash);
    tx.addSignature(address, Buffer.from(sig).toString('base64'));
    return tx;
  }
}

function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(publicKey)).verify(
    Buffer.from(message),
    Buffer.from(signature),
  );
}

function notInitialized() {
  return signerTerminal(
    SignerErrorCode.SIGNER_NOT_INITIALIZED,
    'TurnkeyStellarSigner accessed before initialize()',
  );
}

function stripHex(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s;
}
