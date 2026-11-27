// A deposit that pays a chosen quote carries two signatures: the depositor's Permit2 deposit, which
// names a reserver in its witness, and that reserver's signature over the escrow's reserve witness
// {depositId, quoteHash, settler, sourceAmount}, which names the quote's settler and amount. The
// escrow checks the reserve signature on chain with OpenZeppelin's SignatureChecker: a reserver with
// no code must have signed with its own key (65 bytes, low-s), and a reserver with code must answer
// isValidSignature (ERC-1271), called from the escrow, with the magic value. On Solana the program
// requires the reserver's ed25519 signature over its reserve hash, which binds the same four values.
// `verifyReserveAuth` is that check evaluated off chain, identical in Go and TypeScript. Mirrors the
// Go reserve_auth.go and reserve_auth_solana.go.
//
// The digest is rebuilt from the verifier's own expected values, never from message_prehash: the
// prehash is only compared with them, member by member, so a refusal names the member that differs.
//
// As in `verifyDepositorSignature`, the key check runs first and reads nothing. An EIP-7702 account
// that signs with its own key is admitted here, while the escrow sends it to its delegate's
// isValidSignature; a delegate that refuses makes the deposit revert, which is a failed deposit and
// not a loss of funds.

import { recoverAddress, toBeHex } from 'ethers';
import {
  buildReserveTypedDataWithQuoteSource,
  computeReserveDigestWithQuoteSource,
} from '@atum-labs/evm-escrow-encoding';
import {
  buildTvmReserveTypedDataWithQuoteSource,
  computeTvmReserveDigestWithQuoteSource,
} from '@atum-labs/tvm-escrow-encoding';

import { evmChainId, namespaceOf, tronNumericChainId } from './chain-id.js';
import bs58 from 'bs58';
import { computeReserveHashV3, Pubkey, type EscrowDomain } from '@atum-labs/solana-escrow-encoding';
import { isJsonBlank } from './commitment-rules.js';
import { recordSpelledTwice } from './commitment-permit.js';
import { solanaEscrowDomain, verifyEd25519Strict } from './commitment-solana.js';
import { TronChainIdError } from './errors.js';
import {
  isObject,
  jsonEqual,
  memberAt,
  readPrehash,
  sameMessageTypes,
} from './commitment-permit.js';
import {
  ERC1271_MAGIC_WORD,
  MAX_SIGNATURE_LENGTH,
  depositorAddress,
  messageOf,
  offlineChecker,
} from './depositor-signature.js';
import type {
  ContractSignatureAnswer,
  DepositorSignatureChecker,
  SignaturePath,
} from './depositor-signature.js';

/** The reserver's signed reserve witness. */
export interface ReserveAuth {
  /** The 0x-hex 32-byte digest the reserver signed. */
  message: string;
  /**
   * Required; without it the result is `malformed`. On EVM and Tron it is the reserve witness as
   * typed data JSON; on Solana it is the reserve record
   * `{deposit_hash, recipient, quote_hash, source_amount}`.
   */
  message_prehash?: string;
  /** The 0x-hex signature, up to 65536 characters with the 0x. */
  signature: string;
}

/**
 * What the verifier knows the reserve must say. Every value comes from the verifier's own records,
 * never from the reserve_auth being checked. Field names match the Go `ReserveAuthExpectations`.
 */
export interface ReserveAuthExpectations {
  /** The CAIP-2 source chain: `eip155:<id>`, `tron:<cluster>` or `solana:<cluster>`. */
  network: string;
  /**
   * The source chain's escrow: the EIP-712 verifying contract and the msg.sender of
   * isValidSignature, or on Solana the escrow program id.
   */
  escrowContract: string;
  /** The payment's deposit id, 0x-hex 32 bytes. */
  depositId: string;
  /** The chosen quote's hash, 0x-hex 32 bytes. */
  quoteHash: string;
  /** The chosen quote's settler on the source chain. */
  settler: string;
  /** The chosen quote's source amount, a decimal string above zero. */
  sourceAmount: string;
  /** The reserver the verified deposit witness names, and so the required signer. */
  reserver: string;
  /**
   * TIP-712 chain ids by Tron cluster for networks the built-in table does not know, such as a local
   * node's, as the `tronChainIds` commitment option does.
   */
  tronChainIds?: Readonly<Record<string, number>>;
  /**
   * The Solana escrow's signature domain, required on Solana. The reserve hash binds the source
   * amount from domain version 5.
   */
  svmSignatureClusterId?: string;
  svmSignatureDomainVersion?: number;
}

/**
 * Why a reserve_auth was, or was not, found valid. Only `verified` is valid.
 * `signature_unverifiable` says a chain read failed and nothing about the signature;
 * `verifier_misconfigured` and `unsupported_chain` are about the expectations, not the reserve_auth;
 * every other reason is a refusal of it.
 */
export type ReserveAuthReason =
  | 'verified'
  | 'unsupported_chain'
  | 'verifier_misconfigured'
  | 'malformed'
  | 'domain_mismatch'
  | 'deposit_id_mismatch'
  | 'quote_hash_mismatch'
  | 'settler_mismatch'
  | 'source_amount_mismatch'
  | 'message_mismatch'
  | 'signer_mismatch'
  | 'contract_signature_rejected'
  | 'signature_unverifiable';

export interface ReserveAuthResult {
  valid: boolean;
  path: SignaturePath;
  reason: ReserveAuthReason;
  /** What was found, for logs. The same text in both languages, but `reason` is what to branch on. */
  detail: string;
}

const DIGEST = /^0x[0-9a-fA-F]{64}$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_ID = /^0x[1-9a-fA-F][0-9a-fA-F]*$/;
const POSITIVE_UINT = /^[1-9][0-9]*$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = '0x' + '0'.repeat(64);
// In UTF-8 bytes: the reserve typed data is under 1 KiB.
const MAX_PREHASH_LENGTH = 4096;

/**
 * Every member the reserve typed data may carry, per object. Anything else is refused: no reader
 * needs it, and an unread member is room for a second meaning. domain.salt is allowed only empty,
 * as go-ethereum's TypedDataDomain always writes it.
 */
const RESERVE_WITNESS_MEMBERS: {
  path: readonly string[] | undefined;
  allowed: readonly string[];
}[] = [
  { path: undefined, allowed: ['types', 'primaryType', 'domain', 'message'] },
  { path: ['domain'], allowed: ['name', 'version', 'chainId', 'verifyingContract', 'salt'] },
  { path: ['message'], allowed: ['depositId', 'quoteHash', 'settler', 'sourceAmount'] },
];

/** The expected reserve, read: addresses in the checker's form (0x-prefixed lowercase 20-byte hex). */
export interface ReserveWitness {
  namespace: 'eip155' | 'tron';
  chainId: number;
  escrow: string;
  depositId: string;
  quoteHash: string;
  settler: string;
  reserver: string;
  sourceAmount: string;
}

/**
 * Whether the escrow would accept `auth` as the expected reserver's signature over the expected
 * reserve witness, reading the chain through `checker` only when the reserver's key did not sign:
 *
 * 1. The expectations are read; one the escrow could never accept is `verifier_misconfigured`.
 * 2. message_prehash must be the reserve typed data for this escrow and chain, naming the expected
 *    depositId, quoteHash, settler and sourceAmount; the first member that differs is its own
 *    reason.
 * 3. message must be the digest rebuilt from the expectations.
 * 4. The signature recovers, by OpenZeppelin's ECDSA rule, to the reserver: valid, no chain read.
 * 5. Otherwise the reserver's code is read. No code: `signer_mismatch`. Code: isValidSignature is
 *    called from the escrow; the magic value is valid, anything else `contract_signature_rejected`.
 *
 * A read that fails is `signature_unverifiable`. Without a checker every read is unavailable. The
 * verdict is about the latest block and must never be cached. Mirrors the Go `VerifyReserveAuth`.
 */
export async function verifyReserveAuth(
  auth: ReserveAuth,
  expected: ReserveAuthExpectations,
  checker: DepositorSignatureChecker = offlineChecker,
): Promise<ReserveAuthResult> {
  const namespace = typeof expected.network === 'string' ? namespaceOf(expected.network) : '';
  if (namespace === 'solana') return verifySolanaReserveAuth(auth, expected);
  if (namespace !== 'eip155' && namespace !== 'tron') {
    return verdict(
      'none',
      'unsupported_chain',
      'the network is not an eip155, tron or solana chain',
    );
  }
  const read = readExpectations(namespace, expected);
  if ('reason' in read) return verdict('none', read.reason, read.detail);
  const w = read.witness;
  if (typeof auth.message !== 'string' || !DIGEST.test(auth.message)) {
    return verdict('none', 'malformed', 'the message is not a 0x-prefixed 32-byte hex digest');
  }
  if (typeof auth.signature !== 'string' || !HEX_BYTES.test(auth.signature)) {
    return verdict('none', 'malformed', 'the signature is not 0x-prefixed hex');
  }
  if (auth.signature.length > MAX_SIGNATURE_LENGTH) {
    return verdict('none', 'malformed', 'the signature is longer than 65536 characters');
  }
  const prehashProblem = matchPrehash(w, auth.message_prehash);
  if (prehashProblem !== undefined) {
    return verdict('none', prehashProblem.reason, prehashProblem.detail);
  }

  let digest: string;
  try {
    digest = reserveDigest(w).toLowerCase();
  } catch (e) {
    return verdict(
      'none',
      'verifier_misconfigured',
      `the reserve digest cannot be built: ${messageOf(e)}`,
    );
  }
  if (auth.message.toLowerCase() !== digest) {
    return verdict(
      'none',
      'message_mismatch',
      'the message is not the digest of the expected reserve witness',
    );
  }

  let signer: string | undefined;
  let recoverError = '';
  try {
    signer = recoverReserveEOA(digest, auth.signature);
  } catch (e) {
    recoverError = messageOf(e);
  }
  if (signer !== undefined && signer.toLowerCase() === w.reserver) {
    return verdict('eoa', 'verified', 'the signature recovers to the reserver');
  }
  let hasCode: unknown;
  try {
    hasCode = await checker.hasCode(expected.network, w.reserver);
  } catch (e) {
    return verdict(
      'none',
      'signature_unverifiable',
      `the reserver's code could not be read: ${messageOf(e)}`,
    );
  }
  if (typeof hasCode !== 'boolean') {
    return verdict(
      'none',
      'signature_unverifiable',
      "the reserver's code could not be read: the checker did not answer true or false",
    );
  }
  if (!hasCode) {
    return verdict(
      'eoa',
      'signer_mismatch',
      signer === undefined
        ? `no signer recovers from the signature (${recoverError}), and the reserver has no code`
        : `the signature recovers to ${signer}, and the reserver has no code`,
    );
  }

  let answer: ContractSignatureAnswer;
  try {
    answer = await checker.isValidSignatureFrom(
      expected.network,
      w.reserver,
      digest,
      auth.signature.toLowerCase(),
      w.escrow,
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
  // SignatureChecker decodes the return data as a bytes32: it reads the first word.
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

export type Problem = { reason: ReserveAuthReason; detail: string };

/**
 * Reads the expectations, or returns why the escrow could never accept them. `forBuild` reads a
 * reserve about to be signed with the same rules: it names no reserver, and the details name the
 * input instead of the verifier's expectations.
 */
export function readExpectations(
  namespace: 'eip155' | 'tron',
  expected: Omit<ReserveAuthExpectations, 'reserver'> & { reserver?: string },
  forBuild = false,
): { witness: ReserveWitness } | Problem {
  let chainId: number;
  try {
    chainId =
      namespace === 'eip155'
        ? evmChainId(expected.network)
        : tronNumericChainId(expected.network, expected.tronChainIds);
  } catch (e) {
    if (e instanceof TronChainIdError)
      return { reason: 'verifier_misconfigured', detail: e.detail };
    return { reason: 'unsupported_chain', detail: `the network is not a known ${namespace} chain` };
  }
  const the = forBuild ? 'the' : 'the expected';
  const misconfigured = (detail: string): Problem => ({ reason: 'verifier_misconfigured', detail });
  const escrow = depositorAddress(namespace, expected.escrowContract);
  if (escrow === undefined) {
    return misconfigured(`${the} escrow is not an address on this chain`);
  }
  if (!isExpectedHash(expected.depositId)) {
    return misconfigured(`${the} depositId is not a non-zero 0x-prefixed 32-byte hex value`);
  }
  if (!isExpectedHash(expected.quoteHash)) {
    return misconfigured(`${the} quoteHash is not a non-zero 0x-prefixed 32-byte hex value`);
  }
  const settler = depositorAddress(namespace, expected.settler);
  if (settler === undefined || settler === ZERO_ADDRESS) {
    return misconfigured(`${the} settler is not a non-zero address on this chain`);
  }
  let reserver = '';
  if (!forBuild) {
    const read = depositorAddress(namespace, expected.reserver);
    if (read === undefined || read === ZERO_ADDRESS) {
      return misconfigured('the expected reserver is not a non-zero address on this chain');
    }
    reserver = read;
  }
  if (typeof expected.sourceAmount !== 'string' || !POSITIVE_UINT.test(expected.sourceAmount)) {
    return misconfigured(`${the} sourceAmount is not a positive decimal integer string`);
  }
  if (BigInt(expected.sourceAmount) > MAX_UINT256) {
    return misconfigured(`${the} sourceAmount exceeds uint256`);
  }
  return {
    witness: {
      namespace,
      chainId,
      escrow,
      depositId: expected.depositId.toLowerCase(),
      quoteHash: expected.quoteHash.toLowerCase(),
      settler,
      reserver,
      sourceAmount: expected.sourceAmount,
    },
  };
}

function isExpectedHash(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value) && value !== ZERO_HASH;
}

/** Compares message_prehash with the expected reserve, or returns why it differs. */
function matchPrehash(w: ReserveWitness, prehash: unknown): Problem | undefined {
  if (
    prehash === undefined ||
    prehash === null ||
    (typeof prehash === 'string' && isJsonBlank(prehash))
  ) {
    return { reason: 'malformed', detail: 'message_prehash is required on this chain' };
  }
  // UTF-16 units never outnumber UTF-8 bytes, so the cheap check first.
  if (
    typeof prehash === 'string' &&
    (prehash.length > MAX_PREHASH_LENGTH ||
      new TextEncoder().encode(prehash).length > MAX_PREHASH_LENGTH)
  ) {
    return { reason: 'malformed', detail: 'message_prehash is longer than 4096 bytes' };
  }
  const read = readPrehash(prehash);
  if ('detail' in read) return { reason: 'malformed', detail: read.detail };
  const root = read.root;
  for (const m of RESERVE_WITNESS_MEMBERS) {
    let obj: unknown = root;
    if (m.path !== undefined) obj = memberAt(root, m.path).value;
    if (!isObject(obj)) {
      return { reason: 'malformed', detail: `${m.path!.join('.')} is not an object` };
    }
    for (const name of Object.keys(obj)) {
      if (!m.allowed.includes(name)) {
        const where = m.path === undefined ? 'the typed data' : m.path.join('.');
        return {
          reason: 'malformed',
          detail: `${where} carries a member the reserve typed data does not define`,
        };
      }
    }
  }
  if (root['primaryType'] !== 'ReserveWitness') {
    return { reason: 'malformed', detail: 'primaryType is not ReserveWitness' };
  }
  if (
    !sameMessageTypes(root['types'], reserveTypedData(w).types) ||
    !canonicalDomainType(root['types'])
  ) {
    return { reason: 'malformed', detail: 'types are not the reserve witness types' };
  }

  const domain = (name: string) => stringMember(root, ['domain', name]);
  if (domain('name') !== 'Escrow') {
    return { reason: 'domain_mismatch', detail: 'domain.name is not Escrow' };
  }
  if (domain('version') !== '3') {
    return { reason: 'domain_mismatch', detail: 'domain.version is not 3' };
  }
  const chainId = domain('chainId');
  if (chainId === undefined || !CHAIN_ID.test(chainId)) {
    return {
      reason: 'domain_mismatch',
      detail: 'domain.chainId is not 0x-prefixed hex without leading zeros',
    };
  }
  if (BigInt(chainId) !== BigInt(signedChainId(w))) {
    return { reason: 'domain_mismatch', detail: 'domain.chainId is not this chain' };
  }
  const contract = domain('verifyingContract');
  if (
    contract === undefined ||
    !HEX_ADDRESS.test(contract) ||
    contract.toLowerCase() !== w.escrow
  ) {
    return {
      reason: 'domain_mismatch',
      detail: 'domain.verifyingContract is not the expected escrow',
    };
  }
  const domainObject = root['domain'] as Record<string, unknown>;
  if (Object.hasOwn(domainObject, 'salt') && domainObject['salt'] !== '') {
    return { reason: 'domain_mismatch', detail: 'domain.salt is not empty' };
  }

  const message = (name: string) => stringMember(root, ['message', name]);
  const sameHash = (v: string | undefined, want: string) =>
    v !== undefined && DIGEST.test(v) && v.toLowerCase() === want;
  if (!sameHash(message('depositId'), w.depositId)) {
    return {
      reason: 'deposit_id_mismatch',
      detail: 'message.depositId is not the expected depositId',
    };
  }
  if (!sameHash(message('quoteHash'), w.quoteHash)) {
    return {
      reason: 'quote_hash_mismatch',
      detail: 'message.quoteHash is not the expected quoteHash',
    };
  }
  const settler = message('settler');
  if (settler === undefined || !HEX_ADDRESS.test(settler) || settler.toLowerCase() !== w.settler) {
    return { reason: 'settler_mismatch', detail: 'message.settler is not the expected settler' };
  }
  if (message('sourceAmount') !== w.sourceAmount) {
    return {
      reason: 'source_amount_mismatch',
      detail: 'message.sourceAmount is not the expected sourceAmount',
    };
  }
  return undefined;
}

const EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/**
 * Whether `types` declares EIP712Domain, when it does, as the four members of the escrow's domain:
 * the digest is rebuilt over that domain, so any other declaration would describe a domain the
 * signature is not over. Mirrors the Go `canonicalDomainType`.
 */
function canonicalDomainType(types: unknown): boolean {
  if (!isObject(types)) return false;
  if (!Object.hasOwn(types, 'EIP712Domain')) return true;
  return jsonEqual(types['EIP712Domain'], EIP712_DOMAIN_TYPE);
}

function stringMember(root: Record<string, unknown>, path: readonly string[]): string | undefined {
  const { value, found } = memberAt(root, path);
  return found && typeof value === 'string' ? value : undefined;
}

/** The chain id the escrow's domain carries: TIP712 masks it to 32 bits on Tron. */
function signedChainId(w: ReserveWitness): bigint {
  const id = BigInt(w.chainId);
  return w.namespace === 'tron' ? id & 0xffffffffn : id;
}

function encoderInput(w: ReserveWitness) {
  return {
    escrowContract: w.escrow,
    chainId: w.chainId,
    depositId: w.depositId,
    quoteHash: w.quoteHash,
    settler: w.settler,
    sourceAmount: w.sourceAmount,
  };
}

export function reserveTypedData(w: ReserveWitness) {
  return w.namespace === 'tron'
    ? buildTvmReserveTypedDataWithQuoteSource(encoderInput(w))
    : buildReserveTypedDataWithQuoteSource(encoderInput(w));
}

export function reserveDigest(w: ReserveWitness): string {
  return w.namespace === 'tron'
    ? computeTvmReserveDigestWithQuoteSource(encoderInput(w))
    : computeReserveDigestWithQuoteSource(encoderInput(w));
}

/**
 * Recovers the signer of `digest` as OpenZeppelin's ECDSA.tryRecover does: exactly 65 bytes
 * r || s || v, v 27 or 28, r in [1, n-1] and s in [1, n/2]. Permit2's rule is looser (it takes
 * high-s and the 64-byte form), so `recoverPermit2EOA` is not this rule. Mirrors the Go
 * `recoverReserveEOA`.
 */
function recoverReserveEOA(digest: string, signature: string): string {
  const body = signature.slice(2);
  if (body.length !== 130) throw new Error('the signature is not 65 bytes');
  const r = BigInt('0x' + body.slice(0, 64));
  const s = BigInt('0x' + body.slice(64, 128));
  const v = parseInt(body.slice(128), 16);
  if (v !== 27 && v !== 28) throw new Error('the signature recovery id is not 27 or 28');
  if (r < 1n || r >= SECP256K1_N || s < 1n || s > SECP256K1_N >> 1n) {
    throw new Error('the signature r is not in [1, n-1] or s is not in [1, n/2]');
  }
  try {
    return recoverAddress(digest, {
      r: toBeHex(r, 32),
      s: toBeHex(s, 32),
      yParity: (v - 27) as 0 | 1,
    });
  } catch {
    throw new Error('the signature recovers no public key');
  }
}

function verdict(
  path: SignaturePath,
  reason: ReserveAuthReason,
  detail: string,
): ReserveAuthResult {
  return { valid: reason === 'verified', path, reason, detail };
}

// ─── Solana ─────────────────────────────────────────────────────────────────

/** The first Solana signature domain version whose reserve hash binds the source amount. */
const SVM_RESERVE_SOURCE_AMOUNT_VERSION = 5;
const SOLANA_RESERVE_MEMBERS = ['deposit_hash', 'recipient', 'quote_hash', 'source_amount'];
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const ED25519_SIGNATURE = /^0x[0-9a-fA-F]{128}$/;
const MAX_U64 = (1n << 64n) - 1n;

/**
 * `verifyReserveAuth` on Solana: the reserve hash is rebuilt from the expectations with the escrow's
 * signature domain, message must be it, and the reserver's ed25519 signature must verify over it.
 * Solana has no contract accounts, so no chain is read. Mirrors the Go `verifySolanaReserveAuth`.
 */
function verifySolanaReserveAuth(
  auth: ReserveAuth,
  expected: ReserveAuthExpectations,
): ReserveAuthResult {
  const read = readSolanaExpectations(expected);
  if ('detail' in read) return verdict('none', read.reason, read.detail);
  const { settler, reserver } = read.witness;

  if (typeof auth.message !== 'string' || !DIGEST.test(auth.message)) {
    return verdict('none', 'malformed', 'the message is not a 0x-prefixed 32-byte hex digest');
  }
  if (typeof auth.signature !== 'string' || !HEX_BYTES.test(auth.signature)) {
    return verdict('none', 'malformed', 'the signature is not 0x-prefixed hex');
  }
  if (auth.signature.length > MAX_SIGNATURE_LENGTH) {
    return verdict('none', 'malformed', 'the signature is longer than 65536 characters');
  }
  const prehashProblem = matchSolanaReservePrehash(auth.message_prehash, expected, settler);
  if (prehashProblem !== undefined) {
    return verdict('none', prehashProblem.reason, prehashProblem.detail);
  }

  let digest: Uint8Array;
  try {
    digest = solanaReserveDigest(read.witness);
  } catch (e) {
    return verdict(
      'none',
      'verifier_misconfigured',
      `the reserve digest cannot be built: ${messageOf(e)}`,
    );
  }
  if (auth.message.slice(2).toLowerCase() !== Buffer.from(digest).toString('hex')) {
    return verdict(
      'none',
      'message_mismatch',
      'the message is not the digest of the expected reserve witness',
    );
  }
  if (!ED25519_SIGNATURE.test(auth.signature)) {
    return verdict(
      'eoa',
      'signer_mismatch',
      'the signature is not a 64-byte hex ed25519 signature',
    );
  }
  if (!verifyEd25519Strict(reserver.toBytes(), digest, hexBytes(auth.signature))) {
    return verdict(
      'eoa',
      'signer_mismatch',
      'the ed25519 signature does not verify against the reserver',
    );
  }
  return verdict('eoa', 'verified', 'the signature verifies against the reserver');
}

/** What a Solana reserve binds, read from the expectations. */
export interface SolanaReserveWitness {
  domain: EscrowDomain;
  depositId: string;
  quoteHash: string;
  settler: Pubkey;
  /** The zero key when read for a reserve about to be signed. */
  reserver: Pubkey;
  sourceAmount: bigint;
}

/**
 * Reads the Solana expectations, or returns why the escrow could never accept them. `forBuild`
 * reads a reserve about to be signed, as `readExpectations` does.
 */
export function readSolanaExpectations(
  expected: Omit<ReserveAuthExpectations, 'reserver'> & { reserver?: string },
  forBuild = false,
): { witness: SolanaReserveWitness } | Problem {
  const segments = expected.network.split(':');
  if (segments.length !== 2 || segments[1] === '') {
    return { reason: 'unsupported_chain', detail: 'the network is not a known solana chain' };
  }
  const the = forBuild ? 'the' : 'the expected';
  const misconfigured = (detail: string): Problem => ({ reason: 'verifier_misconfigured', detail });
  if (
    expected.svmSignatureDomainVersion === undefined ||
    expected.svmSignatureDomainVersion === null
  ) {
    return misconfigured(
      'the Solana escrow domain (program id, cluster, domain version) was not supplied',
    );
  }
  const domain = solanaEscrowDomain({
    escrowProgramId: expected.escrowContract,
    clusterId: expected.svmSignatureClusterId ?? '',
    domainVersion: expected.svmSignatureDomainVersion,
  });
  if (typeof domain === 'string') return misconfigured(domain);
  if (domain.signatureDomainVersion < SVM_RESERVE_SOURCE_AMOUNT_VERSION) {
    return misconfigured(
      'the Solana escrow signature domain version must be 5 or later to bind the source amount',
    );
  }
  if (!isExpectedHash(expected.depositId)) {
    return misconfigured(`${the} depositId is not a non-zero 0x-prefixed 32-byte hex value`);
  }
  if (!isExpectedHash(expected.quoteHash)) {
    return misconfigured(`${the} quoteHash is not a non-zero 0x-prefixed 32-byte hex value`);
  }
  const settler = readSolanaKey(expected.settler);
  if (settler === undefined) {
    return misconfigured(`${the} settler is not a non-zero base58 32-byte public key`);
  }
  let reserver = Pubkey.fromBytes(new Uint8Array(32));
  if (!forBuild) {
    const read = readSolanaKey(expected.reserver);
    if (read === undefined) {
      return misconfigured('the expected reserver is not a non-zero base58 32-byte public key');
    }
    reserver = read;
  }
  if (typeof expected.sourceAmount !== 'string' || !POSITIVE_UINT.test(expected.sourceAmount)) {
    return misconfigured(`${the} sourceAmount is not a positive decimal integer string`);
  }
  const sourceAmount = BigInt(expected.sourceAmount);
  if (sourceAmount > MAX_U64) return misconfigured(`${the} sourceAmount exceeds u64`);
  return {
    witness: {
      domain,
      depositId: expected.depositId.toLowerCase(),
      quoteHash: expected.quoteHash.toLowerCase(),
      settler,
      reserver,
      sourceAmount,
    },
  };
}

/** The reserve hash the Solana escrow checks the reserver's ed25519 signature over. */
export function solanaReserveDigest(w: SolanaReserveWitness): Uint8Array {
  return computeReserveHashV3(
    { depositHash: hexBytes(w.depositId), recipient: w.settler },
    hexBytes(w.quoteHash),
    w.sourceAmount,
    w.domain,
  );
}

/** The reserve record the settler builds its reserve instruction from. */
export function solanaReserveRecord(w: SolanaReserveWitness) {
  return {
    deposit_hash: w.depositId,
    recipient: w.settler.toString(),
    quote_hash: w.quoteHash,
    source_amount: w.sourceAmount.toString(),
  };
}

/** A base58 32-byte public key other than the zero key, or undefined. */
function readSolanaKey(value: unknown): Pubkey | undefined {
  if (typeof value !== 'string' || !BASE58.test(value)) return undefined;
  let raw: Uint8Array;
  try {
    raw = bs58.decode(value);
  } catch {
    return undefined;
  }
  if (raw.length !== 32) return undefined;
  const key = Pubkey.fromBytes(raw);
  return key.isZero() ? undefined : key;
}

/**
 * Compares the reserve record with the expectations, or returns why it differs. The record is
 * required: the settler builds the reserve instruction from its quote_hash and source_amount.
 */
function matchSolanaReservePrehash(
  prehash: unknown,
  expected: ReserveAuthExpectations,
  settler: Pubkey,
): Problem | undefined {
  if (
    prehash === undefined ||
    prehash === null ||
    (typeof prehash === 'string' && isJsonBlank(prehash))
  ) {
    return { reason: 'malformed', detail: 'message_prehash is required on this chain' };
  }
  if (
    typeof prehash === 'string' &&
    (prehash.length > MAX_PREHASH_LENGTH ||
      new TextEncoder().encode(prehash).length > MAX_PREHASH_LENGTH)
  ) {
    return { reason: 'malformed', detail: 'message_prehash is longer than 4096 bytes' };
  }
  const read = readPrehash(prehash);
  if ('detail' in read) return { reason: 'malformed', detail: read.detail };
  const root = read.root;
  if (recordSpelledTwice(root)) {
    return { reason: 'malformed', detail: 'message_prehash spells one member two ways' };
  }
  for (const name of Object.keys(root)) {
    if (!SOLANA_RESERVE_MEMBERS.includes(name)) {
      return {
        reason: 'malformed',
        detail: 'message_prehash carries a member the reserve record does not define',
      };
    }
  }
  const member = (name: string) => {
    const v = Object.hasOwn(root, name) ? root[name] : undefined;
    return typeof v === 'string' ? v : undefined;
  };
  const sameHash = (v: string | undefined, want: string) =>
    v !== undefined && DIGEST.test(v) && v.toLowerCase() === want.toLowerCase();
  if (!sameHash(member('deposit_hash'), expected.depositId)) {
    return { reason: 'deposit_id_mismatch', detail: 'deposit_hash is not the expected depositId' };
  }
  if (member('recipient') !== settler.toString()) {
    return { reason: 'settler_mismatch', detail: 'recipient is not the expected settler' };
  }
  if (!sameHash(member('quote_hash'), expected.quoteHash)) {
    return { reason: 'quote_hash_mismatch', detail: 'quote_hash is not the expected quoteHash' };
  }
  if (member('source_amount') !== expected.sourceAmount) {
    return {
      reason: 'source_amount_mismatch',
      detail: 'source_amount is not the expected sourceAmount',
    };
  }
  return undefined;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}
