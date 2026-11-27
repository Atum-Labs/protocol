// Permit2 authorises a deposit by checking the depositor's signature on chain, with one rule
// (SignatureVerification.verify, identical in the Tron port): an account with no code must have
// signed the digest with its own key, and an account with code must answer isValidSignature
// (ERC-1271) with the magic value. The functions in this file are that rule evaluated off chain,
// identical in Go and TypeScript. Mirrors the Go depositor_signature.go.
//
// `recoverSigner` is not this rule: it refuses every contract account, requires low-s, accepts a
// recovery id of 0 or 1 that Permit2 refuses, and refuses the 64-byte form Permit2 accepts. It is
// unchanged, and `verifyDepositorSignature` is the check to use where the question is "will Permit2
// accept this signature".
//
// The key check runs first and reads nothing, so an account whose key signed costs no chain read.
// That differs from Permit2 in one case: an EIP-7702 account that signs with its own key is admitted
// here, while Permit2 sends it to its delegate's isValidSignature. A delegate that refuses makes the
// deposit revert on chain, which is a failed deposit and not a loss of funds.

import { recoverAddress, toBeHex } from 'ethers';
import { PERMIT2_CONTRACT_ADDRESS } from '@atum-labs/evm-escrow-encoding';
import { normalizeAddress } from '@atum-labs/tvm-escrow-encoding';

import { evmChainId, namespaceOf, resolveTronPermit2 } from './chain-id.js';
import { RecoveryFailedError } from './errors.js';

/**
 * The Permit2 branch a verdict was reached on: `eoa` (no code, or the key signed), `contract` (the
 * account has code), or `none` (the input was refused, or the code could not be read).
 */
export type SignaturePath = 'eoa' | 'contract' | 'none';

/**
 * Why a depositor signature was, or was not, found valid. Only `verified` is valid.
 * `signer_mismatch` and `contract_signature_rejected` are refusals Permit2 makes too, and
 * `malformed` is a refusal as well: the account, digest or signature cannot be read, or the
 * signature is longer than 65536 characters. That breaks the payment request's spelling or the
 * length bound, and is the submitter's alone, so admitting it would let a respelled or padded
 * signature skip the check.
 * `signature_unverifiable` says the chain could not be read and nothing about the signature.
 */
export type SignatureReason =
  | 'verified'
  | 'signer_mismatch'
  | 'contract_signature_rejected'
  | 'signature_unverifiable'
  | 'unsupported_chain'
  | 'malformed';

/** One depositor signature to check the way Permit2 will. Mirrors the Go `DepositorSignature`. */
export interface DepositorSignature {
  /** The CAIP-2 source chain: `eip155:<id>` or `tron:<cluster>`. */
  network: string;
  /** The depositor, the permit owner Permit2 checks the signature for (on Tron, base58 or hex). */
  account: string;
  /** The 0x-hex 32-byte digest the depositor signed: `signed_messages[i].message`. */
  digest: string;
  /**
   * The 0x-hex signature, of any length up to 65536 characters with the 0x. A contract
   * account's signature is opaque: a multi-owner Safe's is 65 bytes per owner, and one approved on
   * chain is empty.
   */
  signature: string;
  /**
   * The Permit2 the escrow uses on `network`, and so the msg.sender of the isValidSignature call. It
   * comes from the verifier's own configuration, never from the payment. Absent means the canonical
   * EVM address, or the pinned Tron one.
   */
  permit2Contract?: string;
}

/** The verdict, returned for every input so admissions and refusals can be logged alike. */
export interface DepositorSignatureResult {
  valid: boolean;
  path: SignaturePath;
  reason: SignatureReason;
  /** What was found, for logs. The same text in both languages, but `reason` is what to branch on. */
  detail: string;
}

/** What an isValidSignature call returned: its return data, or a revert. */
export interface ContractSignatureAnswer {
  /**
   * The call reverted. A revert is the contract's answer (a Safe reverts on a signature it does not
   * accept), not a failure to ask.
   */
  reverted: boolean;
  /** The call's 0x-hex return data when it did not revert. */
  returnData: string;
}

/**
 * Reads the two chain facts Permit2 branches on. Accounts reach it as 0x-prefixed lowercase 20-byte
 * hex, on Tron too (prefix 0x41 for the 21-byte form), digests and signatures as 0x-prefixed
 * lowercase hex, and `network` is the input's CAIP-2 id. A rejected promise means the chain could
 * not be read, and is reported as `signature_unverifiable`, never as a refusal.
 */
export interface DepositorSignatureChecker {
  /**
   * Whether `account` has code at the latest block. It is Permit2's `code.length != 0`, so an
   * EIP-7702 delegation designator (0xef0100 || delegate) is code.
   */
  hasCode(network: string, account: string): Promise<boolean>;
  /**
   * Calls `account.isValidSignature(digest, signature)` at the latest block, as a static call the
   * way the chain makes it, with msg.sender set to `caller`, the contract that asks on chain: the
   * chain's Permit2 for a deposit, the escrow for a reserve (`verifyReserveAuth`). A contract may
   * answer only the callers it trusts, as a module account that trusts only Permit2 does. A revert
   * must resolve as `{ reverted: true }`, not reject. The answer depends on contract state (a
   * paused module, an invalidated digest, a rotated owner), so it must never be cached.
   */
  isValidSignatureFrom(
    network: string,
    account: string,
    digest: string,
    signature: string,
    caller: string,
  ): Promise<ContractSignatureAnswer>;
}

const DIGEST = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const S_MASK = (1n << 255n) - 1n;
// The longest signature accepted, in characters with the 0x: 32767 bytes, room for about 500 Safe
// owners. It equals the veri-fill signature-validity route's maxLength, so the library and the route
// refuse the same values. Mirrors the Go maxDepositorSignatureLength.
export const MAX_SIGNATURE_LENGTH = 65536;
// The only return data Permit2 accepts: isValidSignature's own selector, 0x1626ba7e, as an
// ABI-encoded bytes4. Anything shorter, or with a non-zero pad, fails the decode.
export const ERC1271_MAGIC_WORD = '0x1626ba7e' + '0'.repeat(56);

/**
 * Recovers the signer of a 0x-hex 32-byte digest exactly as Permit2 does for an account with no
 * code. The signature is 65 bytes, r || s || v with v 27 or 28, or 64 bytes in the EIP-2098 form
 * r || vs. A high-s signature is accepted, because Permit2 accepts it. A recovery id of 0 or 1 is
 * refused, because Permit2 passes v to ecrecover unchanged and gets the zero address. Returns the
 * signer's EIP-55 address; on Tron it is the 20-byte body. Throws `RecoveryFailedError`. Mirrors the
 * Go `RecoverPermit2EOA`.
 */
export function recoverPermit2EOA(message: string, signature: string): string {
  try {
    return permit2EOASigner(message, signature);
  } catch (e) {
    throw new RecoveryFailedError(
      `sender_auth: could not recover a signer from the signed message: ${(e as Error).message}`,
    );
  }
}

function permit2EOASigner(message: unknown, signature: unknown): string {
  if (typeof message !== 'string' || !DIGEST.test(message)) {
    throw new Error('the message is not a 0x-prefixed 32-byte hex digest');
  }
  if (typeof signature !== 'string' || !HEX_BYTES.test(signature)) {
    throw new Error('the signature is not 0x-prefixed hex');
  }
  const body = signature.slice(2);
  let r: bigint;
  let s: bigint;
  let v: number;
  if (body.length === 130) {
    r = BigInt('0x' + body.slice(0, 64));
    s = BigInt('0x' + body.slice(64, 128));
    v = parseInt(body.slice(128), 16);
  } else if (body.length === 128) {
    // EIP-2098: the top bit of the second word is the y parity and the rest is s.
    const vs = BigInt('0x' + body.slice(64));
    r = BigInt('0x' + body.slice(0, 64));
    s = vs & S_MASK;
    v = Number(vs >> 255n) + 27;
  } else {
    throw new Error('the signature is neither 64 nor 65 bytes');
  }
  if (v !== 27 && v !== 28) {
    throw new Error('the signature recovery id is not 27 or 28');
  }
  // The ecrecover precompile's own range check. The precompile has no low-s rule.
  if (r < 1n || r >= SECP256K1_N || s < 1n || s >= SECP256K1_N) {
    throw new Error('the signature r or s is not in [1, n-1]');
  }
  // ethers refuses a high-s signature, so recover its low-s twin: (r, n - s) with the other parity
  // recovers the same public key.
  let yParity = v - 27;
  if (s > SECP256K1_N >> 1n) {
    s = SECP256K1_N - s;
    yParity ^= 1;
  }
  try {
    return recoverAddress(message, {
      r: toBeHex(r, 32),
      s: toBeHex(s, 32),
      yParity: yParity as 0 | 1,
    });
  } catch {
    throw new Error('the signature recovers no public key');
  }
}

/**
 * Whether Permit2 would accept `input.signature` as the account's signature over `input.digest`,
 * reading the chain through `checker` only when the account's key did not sign:
 *
 * 1. The signature recovers, by {@link recoverPermit2EOA}, to the account: valid on the EOA path,
 *    with no chain read.
 * 2. Otherwise the account's code is read. No code: Permit2 would recover a different signer, or
 *    none, and refuse (`signer_mismatch`).
 * 3. Code, including an EIP-7702 designator: isValidSignature is called from the chain's Permit2.
 *    The magic value is valid; any other return data, or a revert, is `contract_signature_rejected`.
 *
 * A read that fails is `signature_unverifiable`. The verdict is about the latest block, and the
 * chain can change before the deposit lands, so Permit2 stays the authority and the verdict is never
 * to be cached. Without a checker every read is unavailable, which gives the offline verdict: valid
 * on the EOA path, otherwise unverifiable. Mirrors the Go `VerifyDepositorSignature`.
 */
export async function verifyDepositorSignature(
  input: DepositorSignature,
  checker: DepositorSignatureChecker = offlineChecker,
): Promise<DepositorSignatureResult> {
  const namespace = typeof input.network === 'string' ? namespaceOf(input.network) : '';
  const permit2 = depositorPermit2(namespace, input);
  if ('refusal' in permit2) return verdict('none', 'unsupported_chain', permit2.refusal);
  const account = depositorAddress(namespace, input.account);
  if (account === undefined) {
    return verdict('none', 'malformed', 'the account is not an address on this chain');
  }
  if (typeof input.digest !== 'string' || !DIGEST.test(input.digest)) {
    return verdict('none', 'malformed', 'the digest is not a 0x-prefixed 32-byte hex string');
  }
  if (typeof input.signature !== 'string' || !HEX_BYTES.test(input.signature)) {
    return verdict('none', 'malformed', 'the signature is not 0x-prefixed hex');
  }
  if (input.signature.length > MAX_SIGNATURE_LENGTH) {
    return verdict('none', 'malformed', 'the signature is longer than 65536 characters');
  }

  let signer: string | undefined;
  let recoverError = '';
  try {
    signer = permit2EOASigner(input.digest, input.signature);
  } catch (e) {
    recoverError = (e as Error).message;
  }
  if (signer !== undefined && signer.toLowerCase() === account) {
    return verdict('eoa', 'verified', 'the signature recovers to the account');
  }
  let hasCode: unknown;
  try {
    hasCode = await checker.hasCode(input.network, account);
  } catch (e) {
    return verdict(
      'none',
      'signature_unverifiable',
      `the account's code could not be read: ${messageOf(e)}`,
    );
  }
  if (typeof hasCode !== 'boolean') {
    return verdict(
      'none',
      'signature_unverifiable',
      "the account's code could not be read: the checker did not answer true or false",
    );
  }
  if (!hasCode) {
    return verdict(
      'eoa',
      'signer_mismatch',
      signer === undefined
        ? `no signer recovers from the signature (${recoverError}), and the account has no code`
        : `the signature recovers to ${signer}, and the account has no code`,
    );
  }

  let answer: ContractSignatureAnswer;
  try {
    answer = await checker.isValidSignatureFrom(
      input.network,
      account,
      input.digest.toLowerCase(),
      input.signature.toLowerCase(),
      permit2.address,
    );
  } catch (e) {
    return verdict(
      'contract',
      'signature_unverifiable',
      `isValidSignature could not be called: ${messageOf(e)}`,
    );
  }
  if (answer?.reverted === true) {
    return verdict('contract', 'contract_signature_rejected', 'isValidSignature reverted');
  }
  if (
    answer?.reverted !== false ||
    typeof answer.returnData !== 'string' ||
    !HEX_BYTES.test(answer.returnData)
  ) {
    return verdict(
      'contract',
      'signature_unverifiable',
      'isValidSignature could not be called: the checker did not return a revert or 0x-hex return data',
    );
  }
  // Permit2 decodes the return data as a bytes4: it reads the first word and ignores the rest.
  const returned = answer.returnData.toLowerCase();
  if (returned.length >= 66 && returned.slice(0, 66) === ERC1271_MAGIC_WORD) {
    return verdict('contract', 'verified', 'isValidSignature returned the ERC-1271 magic value');
  }
  return verdict(
    'contract',
    'contract_signature_rejected',
    `isValidSignature returned ${returned.slice(0, 66)}, not the ERC-1271 magic value`,
  );
}

/**
 * The chain's Permit2 in the checker's address form, or why the network is not one the rule can be
 * evaluated on.
 */
function depositorPermit2(
  namespace: string,
  input: DepositorSignature,
): { address: string } | { refusal: string } {
  // Empty is absent, as in Go, whose string field cannot tell the two apart.
  const configured = input.permit2Contract === '' ? undefined : input.permit2Contract;
  if (namespace === 'eip155') {
    try {
      evmChainId(input.network);
    } catch {
      return { refusal: 'the network is not a valid eip155 chain' };
    }
    const address = depositorAddress(namespace, configured ?? PERMIT2_CONTRACT_ADDRESS);
    return address === undefined
      ? { refusal: 'the Permit2 contract is not an address on this chain' }
      : { address };
  }
  if (namespace === 'tron') {
    const segments = input.network.split(':');
    if (segments.length !== 2 || segments[1] === '') {
      return { refusal: 'the network is not a valid tron chain' };
    }
    let permit2: string;
    try {
      permit2 = configured ?? resolveTronPermit2(input.network);
    } catch {
      return { refusal: 'no Permit2 contract is known for this tron network' };
    }
    const address = depositorAddress(namespace, permit2);
    return address === undefined
      ? { refusal: 'the Permit2 contract is not an address on this chain' }
      : { address };
  }
  return { refusal: 'the network is not an eip155 or tron chain' };
}

/**
 * An address in the checker's form: 0x-prefixed lowercase 20-byte hex, which on Tron is the body of
 * the base58 or 41-prefixed hex address. Undefined when it is not an address on that chain.
 */
export function depositorAddress(namespace: string, address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  if (namespace === 'tron') {
    try {
      return normalizeAddress(address);
    } catch {
      return undefined;
    }
  }
  return EVM_ADDRESS.test(address) ? address.toLowerCase() : undefined;
}

function verdict(
  path: SignaturePath,
  reason: SignatureReason,
  detail: string,
): DepositorSignatureResult {
  return { valid: reason === 'verified', path, reason, detail };
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The checker used when none is supplied: no chain can be read. */
export const offlineChecker: DepositorSignatureChecker = {
  hasCode: () => Promise.reject(new Error('no chain reader was supplied')),
  isValidSignatureFrom: () => Promise.reject(new Error('no chain reader was supplied')),
};
