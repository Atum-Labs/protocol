import bs58 from 'bs58';
import { recoverAddress, Signature, toUtf8Bytes } from 'ethers';
import { createHash } from 'node:crypto';

import {
  SignerErrorCode,
  signerTerminal,
  type Signer,
  type TronIdentity,
  type TronPrimitives,
  type TronWebTx,
  type TypedDataDomain,
  type TypedDataTypes,
} from '@atum-labs/km-core';

import type { TurnkeyClient } from '../client';
import { resolveTurnkeyAccountAddress, type TurnkeySignerCommonDeps } from '../signer-base';
import {
  signSecp256k1PreimageAndVerify,
  signSecp256k1TypedDataAndVerify,
} from './secp256k1-helpers';

const ADDRESS_FORMAT = 'ADDRESS_FORMAT_TRON';

/**
 * Turnkey-backed Tron signer. Tron uses the same secp256k1 primitive as EVM; only the
 * address derivation and the TIP-191 message prefix differ.
 *
 * `signMessage` applies the TIP-191 prefix (`\x19TRON Signed Message:\n<len>`) — distinct
 * from EIP-191's `\x19Ethereum Signed Message:\n<len>`. The protocol's signature verifier
 * expects this exact form. The prefixed bytes are sent to Turnkey with
 * `HASH_FUNCTION_KECCAK256`; Turnkey applies keccak server-side.
 *
 * `signPreimage` is the raw secp256k1-over-keccak primitive. Every policy set denies it.
 *
 * `signTransaction` uses native `TRANSACTION_TYPE_TRON` so Turnkey-side policies parse
 * Tron contract calls (`tron.tx.contract[0].contract_address`, function selector, amount).
 */
export class TurnkeyTronSigner implements Signer<TronPrimitives> {
  private readonly client: TurnkeyClient;
  private readonly deps: TurnkeySignerCommonDeps;
  private address: string | null = null;
  /** EVM-equivalent 20-byte hash (lowercase hex, 0x-prefixed) of the Tron base58 address.
   * Tron signatures recover to this form; we keep it cached so `signSecp256k1PreimageAndVerify`
   * can do its constant-time post-verify without re-decoding base58 on every call. */
  private evmEquivalentAddress: string | null = null;

  constructor(client: TurnkeyClient, deps: Omit<TurnkeySignerCommonDeps, 'client'>) {
    this.client = client;
    this.deps = { ...deps, client };
  }

  get identity(): TronIdentity {
    if (!this.address) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeyTronSigner accessed before initialize()',
      );
    }
    return { address: this.address };
  }

  async initialize(): Promise<void> {
    const addr = await resolveTurnkeyAccountAddress(this.deps, ADDRESS_FORMAT);
    this.address = addr;
    this.evmEquivalentAddress = tronBase58ToEvmHexAddress(addr);
  }

  async signMessage(message: string): Promise<string> {
    const { address, evmAddr } = this.requireReady();
    // TIP-191 preimage: "\x19TRON Signed Message:\n<len>" || message_bytes. Turnkey applies
    // keccak256 server-side via HASH_FUNCTION_KECCAK256.
    const messageBytes = toUtf8Bytes(message);
    const prefixBytes = toUtf8Bytes(`\x19TRON Signed Message:\n${messageBytes.length}`);
    const preimage = new Uint8Array(prefixBytes.length + messageBytes.length);
    preimage.set(prefixBytes, 0);
    preimage.set(messageBytes, prefixBytes.length);
    return signSecp256k1PreimageAndVerify(this.client, address, preimage, evmAddr);
  }

  async signPreimage(preimage: Uint8Array): Promise<string> {
    const { address, evmAddr } = this.requireReady();
    return signSecp256k1PreimageAndVerify(this.client, address, preimage, evmAddr);
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: TypedDataTypes,
    message: Record<string, unknown>,
  ): Promise<string> {
    const { address, evmAddr } = this.requireReady();
    // TIP-712 shares the EIP-712 wire format, so Turnkey's EIP712 encoding parses it as-is,
    // keeping the struct readable to the policy engine (see signSecp256k1TypedDataAndVerify).
    return signSecp256k1TypedDataAndVerify(this.client, address, domain, types, message, evmAddr);
  }

  async signTransaction(tx: TronWebTx): Promise<TronWebTx> {
    const { address, evmAddr } = this.requireReady();
    if (!tx.raw_data_hex) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        'TurnkeyTronSigner.signTransaction: tx is missing raw_data_hex',
      );
    }
    const { signedTransaction } = await this.client.signTransaction({
      signWith: address,
      unsignedTransaction: tx.raw_data_hex,
      type: 'TRANSACTION_TYPE_TRON',
    });
    // Turnkey returns a Tron `Transaction` protobuf containing both `raw_data` (field 1) and
    // `signature` (field 2, repeated bytes). NOT a bare 65-byte signature — confirmed via
    // probe-turnkey-tx-shapes against real Turnkey. We extract field 2 from the protobuf and
    // verify with ecrecover against our cached EVM-equivalent address.
    const signedHex = signedTransaction.startsWith('0x')
      ? signedTransaction.slice(2)
      : signedTransaction;
    const signatureHex = extractTronSignatureFromTransactionProtobuf(signedHex);
    if (signatureHex.length !== 130) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Tron signTransaction: extracted signature length ${signatureHex.length} hex chars, expected 130`,
      );
    }
    const txID = createHash('sha256').update(Buffer.from(tx.raw_data_hex, 'hex')).digest();
    const txIDHex = '0x' + txID.toString('hex');
    let sig: Signature;
    try {
      sig = Signature.from('0x' + signatureHex);
    } catch (err) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Tron signTransaction: malformed signature ${signatureHex.slice(0, 12)}…`,
        err instanceof Error ? err : undefined,
      );
    }
    const recoveredEvm = recoverAddress(txIDHex, sig).toLowerCase();
    if (recoveredEvm !== evmAddr) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Tron signTransaction: recovered ${recoveredEvm}, expected ${evmAddr}`,
      );
    }
    return { ...tx, signature: [signatureHex] };
  }

  private requireReady(): { address: string; evmAddr: string } {
    if (!this.address || !this.evmEquivalentAddress) {
      throw signerTerminal(
        SignerErrorCode.SIGNER_NOT_INITIALIZED,
        'TurnkeyTronSigner accessed before initialize()',
      );
    }
    return { address: this.address, evmAddr: this.evmEquivalentAddress };
  }
}

/**
 * Tron base58 → 20-byte EVM-equivalent hex. base58-decode produces 25 bytes: 1-byte version
 * prefix (`0x41`) + 20-byte hash + 4-byte sha256(sha256)[..4] checksum. Strip the prefix
 * and checksum, return lowercase hex with `0x`.
 */
function tronBase58ToEvmHexAddress(b58: string): string {
  const decoded = Buffer.from(bs58.decode(b58));
  if (decoded.length !== 25 || decoded[0] !== 0x41) {
    throw signerTerminal(
      SignerErrorCode.TURNKEY_BAD_RESPONSE,
      `Invalid Tron base58 address shape: ${b58}`,
    );
  }
  return '0x' + decoded.subarray(1, 21).toString('hex');
}

/**
 * Walk a Tron `Transaction` protobuf and return the bytes of field 2 (signature) as a hex
 * string. Tron's Transaction message:
 *
 *   message Transaction {
 *     raw raw_data = 1;          // tag = 0x0a, length-delimited
 *     repeated bytes signature = 2; // tag = 0x12, length-delimited
 *     repeated TransactionResult ret = 5; // tag = 0x2a, length-delimited (only post-broadcast)
 *   }
 *
 * Empirically verified against Turnkey's `TRANSACTION_TYPE_TRON` response (probe-turnkey-tx-
 * shapes). For our single-signer agent there's exactly one signature; multi-sig is out of
 * scope. Returns the FIRST signature found.
 */
export function extractTronSignatureFromTransactionProtobuf(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  let pos = 0;
  while (pos < bytes.length) {
    const tag = bytes[pos++];
    if (tag === undefined) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Tron signTransaction: truncated protobuf at offset ${pos}`,
      );
    }
    const fieldNum = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType !== 2) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Tron signTransaction: unsupported protobuf wire type ${wireType} at field ${fieldNum}`,
      );
    }
    // Read varint length.
    let length = 0;
    let shift = 0;
    while (true) {
      if (pos >= bytes.length) {
        throw signerTerminal(
          SignerErrorCode.TURNKEY_BAD_RESPONSE,
          `Tron signTransaction: truncated varint at offset ${pos}`,
        );
      }
      const b = bytes[pos++]!;
      length |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 28) {
        throw signerTerminal(
          SignerErrorCode.TURNKEY_BAD_RESPONSE,
          `Tron signTransaction: varint too long at offset ${pos}`,
        );
      }
    }
    if (pos + length > bytes.length) {
      throw signerTerminal(
        SignerErrorCode.TURNKEY_BAD_RESPONSE,
        `Tron signTransaction: field ${fieldNum} length ${length} exceeds remaining bytes`,
      );
    }
    if (fieldNum === 2) {
      // Found the signature field.
      return bytes.subarray(pos, pos + length).toString('hex');
    }
    pos += length;
  }
  throw signerTerminal(
    SignerErrorCode.TURNKEY_BAD_RESPONSE,
    `Tron signTransaction: no signature (field 2) in returned Transaction protobuf`,
  );
}
