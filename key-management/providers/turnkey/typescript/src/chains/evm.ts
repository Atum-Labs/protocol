import {
  toUtf8Bytes,
  Transaction,
  type TransactionLike,
  type TransactionRequest,
} from 'ethers';

import {
  SignerErrorCode,
  signerTerminal,
  type EvmIdentity,
  type EvmPrimitives,
  type Signer,
  type TypedDataDomain,
  type TypedDataTypes,
} from '@atum-labs/km-core';

import type { TurnkeyClient } from '../client';
import { resolveTurnkeyAccountAddress, type TurnkeySignerCommonDeps } from '../signer-base';
import {
  signSecp256k1PreimageAndVerify,
  signSecp256k1TypedDataAndVerify,
} from './secp256k1-helpers';

const ADDRESS_FORMAT = 'ADDRESS_FORMAT_ETHEREUM';

/**
 * Turnkey-backed EVM signer.
 *
 * `signMessage` is EIP-191 personal-sign: builds the prefixed preimage
 * `\x19Ethereum Signed Message:\n<len> || msg` and sends it to Turnkey with
 * `HASH_FUNCTION_KECCAK256`. Turnkey computes the keccak server-side and signs the digest.
 *
 * `signPreimage` is the raw secp256k1-over-keccak primitive: same Turnkey routing as
 * `signMessage` with the caller-supplied preimage. Every policy set denies it.
 *
 * KECCAK256 over a caller-supplied preimage can sign any transaction (the sighash is keccak of
 * the unsigned tx), so every policy set denies it, which also blocks `signMessage`.
 *
 * `signTransaction` uses native `TRANSACTION_TYPE_ETHEREUM` so Turnkey-side policies can
 * parse `eth.tx.to` / `function_signature` / `chain_id` for defense in depth. The
 * post-sign check compares the FULL unsigned-tx bytes between input and Turnkey's signed
 * output — recovering `from` alone would not catch a substitution of `to` / `data` /
 * `value` (whether from MITM, Turnkey-side bug, or any substituted response).
 */
export class TurnkeyEvmSigner implements Signer<EvmPrimitives> {
  private readonly client: TurnkeyClient;
  private readonly deps: TurnkeySignerCommonDeps;
  /** Original case as returned by Turnkey — required for `signWith` lookups (Turnkey does
   * exact-case matching and 404s on a lowercased form). */
  private signWithAddress: string | null = null;
  /** Lowercase form for the chain-plugin contract (EvmIdentity is documented lowercase) and
   * for `recoverAddress` comparisons. */
  private address: string | null = null;

  constructor(client: TurnkeyClient, deps: Omit<TurnkeySignerCommonDeps, 'client'>) {
    this.client = client;
    this.deps = { ...deps, client };
  }

  get identity(): EvmIdentity {
    if (!this.address) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeyEvmSigner accessed before initialize()',
      );
    }
    return { address: this.address };
  }

  async initialize(): Promise<void> {
    const addr = await resolveTurnkeyAccountAddress(this.deps, ADDRESS_FORMAT);
    this.signWithAddress = addr;
    this.address = addr.toLowerCase();
  }

  async signMessage(msg: string | Uint8Array): Promise<string> {
    const { signWith, lower } = this.requireAddresses();
    // EIP-191 preimage: "\x19Ethereum Signed Message:\n<len>" || msg_bytes. Turnkey applies
    // keccak256 server-side via HASH_FUNCTION_KECCAK256.
    const msgBytes = typeof msg === 'string' ? toUtf8Bytes(msg) : msg;
    const prefix = toUtf8Bytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
    const preimage = new Uint8Array(prefix.length + msgBytes.length);
    preimage.set(prefix, 0);
    preimage.set(msgBytes, prefix.length);
    return signSecp256k1PreimageAndVerify(this.client, signWith, preimage, lower);
  }

  async signPreimage(preimage: Uint8Array): Promise<string> {
    const { signWith, lower } = this.requireAddresses();
    return signSecp256k1PreimageAndVerify(this.client, signWith, preimage, lower);
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    message: Record<string, unknown>,
  ): Promise<string> {
    const { signWith, lower } = this.requireAddresses();
    // Send the typed data AS typed data (PAYLOAD_ENCODING_EIP712) rather than collapsing it to a
    // digest locally. Same signature bytes, but Turnkey parses the struct so policies can gate on
    // individual fields — a digest has already keccak'd every one of them.
    return signSecp256k1TypedDataAndVerify(this.client, signWith, domain, types, message, lower);
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const { signWith, lower } = this.requireAddresses();
    if (tx.from && String(tx.from).toLowerCase() !== lower) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_ADDRESS_DRIFT,
        `signTransaction: tx.from=${tx.from} does not match signer ${lower}`,
      );
    }
    // `Transaction.from` accepts a TransactionLike and handles coercion (BigInt for value/gas,
    // address normalization, type inference, accessList/blob/auth fields). It rejects an
    // unsigned tx with `.from` populated (ethers v6 enforces this — only the signed form
    // carries a recovered `from`), so we omit it from the rebuild below.
    //
    // Why explicit field-by-field copy instead of `{ ...tx }`: when this method runs through
    // ethers' AbstractSigner.sendTransaction path (Contract.METHOD(...) → wallet.sendTransaction
    // → populateTransaction → Transaction.from(pop) → signTransaction(txObj)), `tx` is a
    // `Transaction` class instance, not a plain object. The Transaction class uses private
    // `#chainId`/`#nonce`/etc. fields with getters on the prototype — they are NOT own
    // enumerable properties, so `{ ...transaction }` produces `{}` and `Transaction.from({})`
    // builds an empty tx that Turnkey can't pre-parse (HTTP 400). Reading via getters and
    // rebuilding a plain object survives both inputs (TransactionRequest plain object and
    // Transaction instance).
    const txLike = {
      type: tx.type,
      chainId: tx.chainId,
      nonce: tx.nonce,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gasPrice: tx.gasPrice,
      accessList: tx.accessList,
    };
    const unsigned = Transaction.from(txLike as unknown as TransactionLike);
    const unsignedHex = unsigned.unsignedSerialized;
    let signedTransaction: string;
    try {
      const result = await this.client.signTransaction({
        signWith,
        unsignedTransaction: unsignedHex.startsWith('0x') ? unsignedHex.slice(2) : unsignedHex,
        type: 'TRANSACTION_TYPE_ETHEREUM',
      });
      signedTransaction = result.signedTransaction;
    } catch (err) {
      // Capture the unsigned-tx bytes Turnkey rejected. Without this it's impossible to tell
      // which chain / which fields produced an unparseable RLP blob from a CI log alone.
      this.deps.log.error(
        {
          err: err instanceof Error ? err.message : String(err),
          signWith,
          chainId: unsigned.chainId?.toString(),
          type: unsigned.type,
          to: unsigned.to,
          nonce: unsigned.nonce,
          maxFeePerGas: unsigned.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas?.toString(),
          gasLimit: unsigned.gasLimit?.toString(),
          value: unsigned.value?.toString(),
          dataLength: unsigned.data.length,
          unsignedHex,
        },
        'TurnkeyEvmSigner.signTransaction: Turnkey rejected unsigned tx',
      );
      throw err;
    }
    const signedHex = signedTransaction.startsWith('0x')
      ? signedTransaction
      : `0x${signedTransaction}`;
    const parsed = Transaction.from(signedHex);
    if (!parsed.from || parsed.from.toLowerCase() !== lower) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `signTransaction: signed tx parsed from=${parsed.from} ≠ expected ${lower}`,
      );
    }
    // Full-field post-verify: strip signature from parsed, re-serialize unsigned, compare
    // byte-for-byte against the input unsigned bytes. Any field drift fails the comparison.
    const parsedUnsignedHex = parsed.unsignedSerialized;
    const expectUnsigned = unsignedHex.startsWith('0x') ? unsignedHex : `0x${unsignedHex}`;
    const gotUnsigned = parsedUnsignedHex.startsWith('0x')
      ? parsedUnsignedHex
      : `0x${parsedUnsignedHex}`;
    if (expectUnsigned.toLowerCase() !== gotUnsigned.toLowerCase()) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `signTransaction: signed tx fields drifted; expected unsignedSerialized=${expectUnsigned}, got=${gotUnsigned}`,
      );
    }
    return signedHex;
  }

  private requireAddresses(): { signWith: string; lower: string } {
    if (!this.signWithAddress || !this.address) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeyEvmSigner accessed before initialize()',
      );
    }
    return { signWith: this.signWithAddress, lower: this.address };
  }
}
