import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  SignerErrorCode,
  signerTerminal,
  type Signer,
  type SolanaIdentity,
  type SolanaPrimitives,
} from '@atum-labs/km-core';

import type { TurnkeyClient } from '../client';
import { encodePayload as encodeEd25519Payload } from './ed25519-payload';
import { resolveTurnkeyAccountAddress, type TurnkeySignerCommonDeps } from '../signer-base';

// A Solana escrow text: label then the base64url (no padding) 32-byte hash.
const ESCROW_TEXT = /^atum (deposit|reserve|release|refund) v1 [A-Za-z0-9_-]{43}$/;

/**
 * Choose the Turnkey payload encoding for a Solana raw signature.
 *
 * A 32-byte escrow hash and an escrow text always go as HEXADECIMAL, the encoding every role's
 * ed25519 allow admits (ed25519 signs the same bytes either way). Anything else follows the shared
 * ed25519 choice: printable text as TEXT_UTF8, binary as HEXADECIMAL.
 */
export function encodePayload(bytes: Uint8Array): ReturnType<typeof encodeEd25519Payload> {
  const buf = Buffer.from(bytes);
  if (buf.length === 32 || ESCROW_TEXT.test(buf.toString('latin1'))) {
    return { payload: buf.toString('hex'), encoding: 'PAYLOAD_ENCODING_HEXADECIMAL' };
  }
  return encodeEd25519Payload(bytes);
}

const ADDRESS_FORMAT = 'ADDRESS_FORMAT_SOLANA';

/**
 * Turnkey-backed Solana signer.
 *
 * `signMessage` signs arbitrary bytes with raw Ed25519, no UTF-8 constraint and no domain prefix
 * added by Turnkey. `HASH_FUNCTION_NOT_APPLICABLE` hands the bytes verbatim to ed25519.Sign, and
 * `encodePayload` picks the wire encoding (see it for why). The result is the same 64-byte raw
 * signature `nacl.sign.detached` would produce, bit-identical with the raw provider, so W3C
 * `Ed25519Signature2020` proofs round-trip without any custom proof-type extensions.
 *
 * `signTransaction` uses native `TRANSACTION_TYPE_SOLANA`. Turnkey serializes the message
 * itself and signs; we deserialize the returned hex into a VersionedTransaction, copy the
 * payer-slot signature into the original transaction object, and verify locally with
 * `nacl.sign.detached.verify` before returning.
 *
 * Note on Solana tx constraints: Turnkey requires the System Program in the static account
 * keys (per their Solana transaction-construction docs). Our plugin's transaction builder
 * already includes ComputeBudgetProgram instructions which implicitly bring the System Program
 * into context for the runtime, but the static-keys requirement is on the message itself.
 * Empirically this is satisfied by every settlement instruction we build.
 */
export class TurnkeySolanaSigner implements Signer<SolanaPrimitives> {
  private readonly client: TurnkeyClient;
  private readonly deps: TurnkeySignerCommonDeps;
  private publicKey: PublicKey | null = null;
  private address: string | null = null;
  private pubkeyBytes: Uint8Array | null = null;

  constructor(client: TurnkeyClient, deps: Omit<TurnkeySignerCommonDeps, 'client'>) {
    this.client = client;
    this.deps = { ...deps, client };
  }

  get identity(): SolanaIdentity {
    if (!this.publicKey || !this.address) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeySolanaSigner accessed before initialize()',
      );
    }
    return { publicKey: this.publicKey, address: this.address };
  }

  async initialize(): Promise<void> {
    const addr = await resolveTurnkeyAccountAddress(this.deps, ADDRESS_FORMAT);
    this.address = addr;
    this.publicKey = new PublicKey(addr);
    this.pubkeyBytes = bs58.decode(addr);
  }

  async signMessage(bytes: Uint8Array): Promise<Uint8Array> {
    if (!this.address || !this.pubkeyBytes) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeySolanaSigner accessed before initialize()',
      );
    }
    const { r, s } = await this.client.signRawPayload({
      signWith: this.address,
      ...encodePayload(bytes),
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    });
    // Turnkey returns Ed25519 signatures as `r` + `s` concatenated into 64 bytes; this is
    // the same wire shape `nacl.sign.detached` produces. They split the parts to share the
    // response schema with secp256k1, but for Ed25519 there is no recovery byte.
    const sig = Buffer.concat([Buffer.from(stripHex(r), 'hex'), Buffer.from(stripHex(s), 'hex')]);
    if (sig.length !== 64) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Solana signMessage: signature length ${sig.length}, expected 64`,
      );
    }
    if (!(await ed25519Verify(bytes, sig, this.pubkeyBytes))) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Solana signMessage: Ed25519 verify failed against expected pubkey`,
      );
    }
    return new Uint8Array(sig);
  }

  async signTransaction(tx: VersionedTransaction): Promise<VersionedTransaction> {
    if (!this.address || !this.publicKey || !this.pubkeyBytes) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeySolanaSigner accessed before initialize()',
      );
    }
    // Pre-check: the payer slot (index 0 of staticAccountKeys) must be us. tx.addSignature
    // looks up our pubkey in staticAccountKeys; if we're not the payer, the signature lands
    // in the wrong slot. The plugin always builds with `payerKey: this.publicKey`, so the
    // assertion is a structural invariant guard, not a hot-path concern.
    const payerKey = tx.message.staticAccountKeys[0];
    if (!payerKey || !payerKey.equals(this.publicKey)) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_ADDRESS_DRIFT,
        `Solana signTransaction: payer slot is ${payerKey?.toBase58() ?? 'missing'}, expected ${this.address}`,
      );
    }
    const localMessageBytes = tx.message.serialize();
    const serialized = Buffer.from(tx.serialize()).toString('hex');
    const { signedTransaction } = await this.client.signTransaction({
      signWith: this.address,
      unsignedTransaction: serialized,
      type: 'TRANSACTION_TYPE_SOLANA',
    });
    const signedBytes = Buffer.from(stripHex(signedTransaction), 'hex');
    // Decode the returned signed tx ONLY to extract the signature; we deliberately verify
    // against the LOCAL message bytes (not Turnkey's returned message). If the returned
    // message differs from what we sent (MITM on the API path, Turnkey-side bug, or any
    // substituted response), verification against `reTx.message` would pass — but the
    // signature we attach to the LOCAL tx wouldn't be valid for that tx's message. Locking
    // the verify input to `localMessageBytes` makes any such substitution surface as a
    // `TURNKEY_BAD_RESPONSE`.
    const reTx = VersionedTransaction.deserialize(signedBytes);
    const sig = reTx.signatures[0];
    if (!sig || sig.length !== 64) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Solana signTransaction: payer-slot signature missing or wrong length (got ${sig?.length ?? 'none'})`,
      );
    }
    if (!(await ed25519Verify(localMessageBytes, sig, this.pubkeyBytes))) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Solana signTransaction: Ed25519 verify failed against local message bytes`,
      );
    }
    tx.addSignature(this.publicKey, sig);
    return tx;
  }
}

function stripHex(s: string): string {
  return s.startsWith('0x') ? s.slice(2) : s;
}

async function ed25519Verify(
  message: Uint8Array,
  signature: Uint8Array,
  pubkey: Uint8Array,
): Promise<boolean> {
  // tweetnacl ships CJS by default; the dynamic import path normalizes default-vs-namespace
  // export to the same shape regardless of how the bundler resolved it.
  const naclModule = await import('tweetnacl');
  const nacl = (naclModule as unknown as { default?: typeof naclModule }).default ?? naclModule;
  return nacl.sign.detached.verify(message, signature, pubkey);
}
