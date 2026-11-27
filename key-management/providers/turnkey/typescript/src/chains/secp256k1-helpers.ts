// Shared secp256k1 sign-then-recover-then-verify pipeline used by both `TurnkeyEvmSigner`
// and `TurnkeyTronSigner`. Both chains share the secp256k1 primitive — they differ only in
// address derivation and message-prefixing, which happens upstream (caller passes the
// unhashed preimage that Turnkey will keccak server-side).

import {
  getBytes,
  hexlify,
  keccak256,
  recoverAddress,
  Signature,
  TypedDataEncoder,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';

import { SignerErrorCode, signerTerminal } from '@atum-labs/km-core';

import type { TurnkeyClient } from '../client';

/**
 * Hash function paired with `PAYLOAD_ENCODING_EIP712`. EIP-712 fully determines its own
 * digest (`keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)`), so there is no caller-chosen
 * hash step left to name — Turnkey derives it from the parsed JSON.
 *
 * NOTE: Turnkey's REST docs do not state the required pairing for the EIP712 encoding. Measured
 * against a live org: EIP712 is accepted only with NOT_APPLICABLE, and KECCAK256 returns HTTP 400
 * "EIP-712 signing does not require hashing". Centralized here as a single constant, and exercised
 * by the EIP-712 pairing control in scripts/test-policies.ts.
 */
const EIP712_HASH_FUNCTION = 'HASH_FUNCTION_NOT_APPLICABLE' as const;

/**
 * Sign `keccak256(preimage)` via Turnkey using `HASH_FUNCTION_KECCAK256` (Turnkey hashes the
 * preimage server-side), recover the EVM-equivalent address from the returned `(r, s, v)`,
 * and verify it matches `expectedEvmAddrLower`.
 *
 * Routing the keccak through Turnkey lets the policy layer forbid the universal-oracle
 * `HASH_FUNCTION_NO_OP` path on the secp256k1 wallet: any caller that wants a signature over
 * an arbitrary 32-byte digest would have to land in NO_OP, which the policy denies. The
 * legitimate EIP-191 / TIP-191 / W3C-proof flows all have well-formed preimages that survive
 * a server-side keccak unchanged.
 *
 * Every policy set denies KECCAK256, so on those sub-orgs this path is refused;
 * W3C proofs and handshakes sign typed data through `signSecp256k1TypedDataAndVerify` instead.
 *
 * Returns the 0x-prefixed 65-byte recoverable signature hex. Throws `TURNKEY_BAD_RESPONSE`
 * if recovery doesn't match the expected address.
 *
 * Caller responsibilities:
 *   - Build the chain-specific preimage (EIP-191 prefix bytes, TIP-191 prefix bytes, or the
 *     concatenated `proofHash || docHash` for W3C proof signing). Don't pre-hash — Turnkey
 *     does that step.
 *   - Provide the chain's `signWith` address in the form Turnkey expects (0x… for EVM, T…
 *     base58 for Tron).
 *   - Pass the lowercase 0x-prefixed EVM hex of the expected recovery target. For Tron this
 *     is the EVM-equivalent of the base58 address (the 20-byte hash inside the base58check).
 */
export async function signSecp256k1PreimageAndVerify(
  client: TurnkeyClient,
  signWith: string,
  preimage: Uint8Array,
  expectedEvmAddrLower: string,
): Promise<string> {
  const preimageHex = hexlify(preimage).slice(2);
  const parts = await client.signRawPayload({
    signWith,
    payload: preimageHex,
    encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
    hashFunction: 'HASH_FUNCTION_KECCAK256',
  });
  // Recompute the digest locally for the recovery check. Turnkey signed over
  // keccak256(preimage); to verify, we have to keccak the same bytes here. Cheap (one hash).
  return recoverAndVerify(parts, keccak256(preimage), expectedEvmAddrLower);
}

/**
 * Sign EIP-712 typed data via Turnkey using `PAYLOAD_ENCODING_EIP712`, then recover the
 * EVM-equivalent address and verify it matches `expectedEvmAddrLower`.
 *
 * Produces the same signature bytes as signing the digest of that typed data (both cover
 * `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)`), so there is no wire-format or on-chain
 * difference. The reason to send the struct is what Turnkey can SEE: it parses the JSON and
 * exposes the domain, primary type and message fields to the policy engine, which is what allows
 * a policy like `eth.eip_712.message['witness']['destination'] == '…'` to be written at all.
 *
 * Returns the 0x-prefixed 65-byte recoverable signature hex. Throws `TURNKEY_BAD_RESPONSE`
 * if recovery doesn't match the expected address.
 */
export async function signSecp256k1TypedDataAndVerify(
  client: TurnkeyClient,
  signWith: string,
  domain: TypedDataDomain,
  types: Record<string, TypedDataField[]>,
  message: Record<string, unknown>,
  expectedEvmAddrLower: string,
): Promise<string> {
  // ethers' TypedDataEncoder.getPayload produces the canonical EIP-712 JSON (types with the
  // EIP712Domain entry filled in, primaryType inferred, values normalized). Sending exactly
  // this keeps Turnkey's server-side digest byte-identical to the local one we verify against.
  const payload = TypedDataEncoder.getPayload(domain, types, message);
  const parts = await client.signRawPayload({
    signWith,
    payload: JSON.stringify(payload),
    encoding: 'PAYLOAD_ENCODING_EIP712',
    hashFunction: EIP712_HASH_FUNCTION,
  });
  // Local digest for the recovery check. If Turnkey's parse diverged from ethers' encoding in
  // any way, recovery fails here rather than emitting a signature over bytes we never saw.
  const digestHex = TypedDataEncoder.hash(domain, types, message);
  return recoverAndVerify(parts, digestHex, expectedEvmAddrLower);
}

/**
 * Assemble Turnkey's `(r, s, v)` parts into a signature, recover the signer from `digestHex`,
 * and fail closed unless it matches `expectedEvmAddrLower`. Shared by the preimage and
 * typed-data paths so both get the same substituted-response protection.
 */
function recoverAndVerify(
  { r, s, v }: { r: string; s: string; v: string },
  digestHex: string,
  expectedEvmAddrLower: string,
): string {
  let sig: Signature;
  try {
    sig = Signature.from({
      r: r.startsWith('0x') ? r : `0x${r}`,
      s: s.startsWith('0x') ? s : `0x${s}`,
      v: parseInt(v, 16),
    });
  } catch (err) {
    throw signerTerminal(
      SignerErrorCode.TURNKEY_BAD_RESPONSE,
      `Turnkey returned malformed secp256k1 signature parts r=${r} s=${s} v=${v}`,
      err instanceof Error ? err : undefined,
    );
  }
  const recovered = recoverAddress(digestHex, sig).toLowerCase();
  if (recovered !== expectedEvmAddrLower) {
    throw signerTerminal(
      SignerErrorCode.TURNKEY_BAD_RESPONSE,
      `secp256k1 sign-then-recover mismatch: recovered ${recovered}, expected ${expectedEvmAddrLower}`,
    );
  }
  return sig.serialized;
}

/** Coerce a digest input (hex string or raw bytes) into a Uint8Array. */
export function bytesFromHexOrBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? getBytes(input) : input;
}
