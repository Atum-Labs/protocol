import {
  createPermitWitnessTransferFromPrehashWithDestination,
  hashPermitWitnessTransferFrom,
} from '@atum-labs/evm-escrow-encoding';
import {
  createTvmPermitWitnessTransferFromPrehashWithDestination,
  hashTvmPermitWitnessTransferFrom,
  normalizeAddress,
} from '@atum-labs/tvm-escrow-encoding';
import { recoverAddress } from 'ethers';

import type { SignedMessageInput } from './types.js';
import { MalformedPrehashError } from './errors.js';
import { evmChainId, tronNumericChainId } from './chain-id.js';
import { foldMemberName, scanMembers, wellFormed } from './json-members.js';
import {
  DETAIL_BAD_REQUEST_HASH,
  DETAIL_DEADLINE_RANGE,
  DETAIL_PERMIT_DIGEST_MISMATCH,
  DETAIL_NO_DESTINATION,
  DETAIL_NO_PREHASH,
  DETAIL_NO_REQUEST_HASH,
  CommitmentError,
  compareExpected,
  echo,
  emptyResult,
  isJsonBlank,
  isWellFormedText,
  parseHash32,
  signedDigestProblem,
  withOutcome,
} from './commitment-rules.js';
import { MAX_DESTINATION_BYTES } from './destination.js';
import { sameAddress } from './utils.js';
import type {
  CommitmentExpectation,
  CommitmentOptions,
  CommitmentOutcome,
  CommitmentResult,
} from './commitment-rules.js';

type JsonObject = Record<string, unknown>;
type Refusal = { outcome: CommitmentOutcome; detail: string };

/**
 * The EVM and Tron arm: the prehash is the Permit2 typed data the depositor signed, with the
 * commitment in message.witness. Who signed is left to Permit2, which checks the signature on chain
 * for key and contract (ERC-1271) accounts alike. `tronChainIds` is the verifier's, as
 * `tronNumericChainId` reads it. Mirrors the Go `verifyPermitCommitment`.
 */
export function verifyPermitCommitment(
  r: CommitmentResult,
  namespace: string,
  network: string,
  deposit: SignedMessageInput,
  expected: CommitmentExpectation,
  tronChainIds?: CommitmentOptions['tronChainIds'],
): CommitmentResult {
  const prehash = readPrehash(deposit.message_prehash);
  if ('outcome' in prehash) return withOutcome(r, prehash.outcome, prehash.detail);
  const root = prehash.root;
  const destination = readCommitmentMember(root, DETAIL_NO_DESTINATION, [
    'message',
    'witness',
    'destination',
  ]);
  if (typeof destination !== 'string')
    return withOutcome(r, destination.outcome, destination.detail);
  r = { ...r, signedDestination: echo(wellFormed(destination)) };
  const hashText = readCommitmentMember(root, DETAIL_NO_REQUEST_HASH, [
    'message',
    'witness',
    'depositRequestHash',
  ]);
  if (typeof hashText !== 'string') return withOutcome(r, hashText.outcome, hashText.detail);
  r = { ...r, signedDepositRequestHash: echo(wellFormed(hashText)) };
  const hash = parseHash32(hashText);
  if (hash === undefined) return withOutcome(r, 'prehash_mismatch', DETAIL_BAD_REQUEST_HASH);
  r = compareExpected(r, destination, hash, expected);
  if (r.outcome !== 'verified') return r;
  const detail = bindPermitDigest(
    namespace,
    network,
    root,
    deposit.message,
    destination,
    hash,
    tronChainIds,
  );
  if (detail !== '') return withOutcome(r, 'prehash_mismatch', detail);
  return r;
}

const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Recovers the signer of a 0x-hex 32-byte digest from a 0x-hex 65-byte secp256k1 signature whose
 * recovery id is 0, 1, 27 or 28. Any other spelling throws, so a deposit has exactly one accepted
 * signature string. Mirrors the Go `recoverEVMAddress`.
 */
export function recoverEvmSigner(message: string, signature: string): string {
  if (typeof message !== 'string' || !DIGEST.test(message)) {
    throw new Error('the message is not a 0x-prefixed 32-byte hex digest');
  }
  if (typeof signature !== 'string' || !EVM_SIGNATURE.test(signature)) {
    throw new Error('the signature is not a 0x-prefixed 65-byte hex secp256k1 signature');
  }
  const v = parseInt(signature.slice(130), 16);
  if (v !== 0 && v !== 1 && v !== 27 && v !== 28) {
    throw new Error('the signature recovery id is not 0, 1, 27 or 28');
  }
  return recoverAddress(message, signature);
}

/**
 * Whether the secp256k1 signature over the signed digest recovers to `account` (EVM hex, or a Tron
 * address in base58 or hex). Mirrors the Go `permitSignerIs`.
 */
export function permitSignerIs(
  namespace: string,
  deposit: SignedMessageInput,
  account: string,
): boolean {
  try {
    const recovered = recoverEvmSigner(deposit.message, deposit.signature);
    return sameAddress(recovered, namespace === 'tron' ? normalizeAddress(account) : account);
  } catch {
    return false;
  }
}

/**
 * Scans message_prehash for ambiguous member names (with no exemption) and parses it. Member names
 * are unique afterwards, so `JSON.parse` reads what every exact-key reader reads.
 */
export function readPrehash(prehash: unknown): { root: JsonObject } | Refusal {
  if (
    prehash === undefined ||
    prehash === null ||
    (typeof prehash === 'string' && isJsonBlank(prehash))
  ) {
    return { outcome: 'commitment_absent', detail: DETAIL_NO_PREHASH };
  }
  if (typeof prehash !== 'string') {
    return { outcome: 'prehash_mismatch', detail: 'message_prehash is not a string' };
  }
  // Lone surrogates become U+FFFD first, as they would reach a Go reader.
  const text = wellFormed(prehash);
  let path: string | undefined;
  try {
    path = scanMembers(text, false);
  } catch {
    return {
      outcome: 'prehash_mismatch',
      detail: 'message_prehash is not a single valid JSON document',
    };
  }
  if (path !== undefined) {
    return {
      outcome: 'prehash_mismatch',
      detail: `message_prehash carries two members that differ only in letter case, at ${echo(path)}`,
    };
  }
  const root: unknown = JSON.parse(text);
  if (!isObject(root)) {
    return {
      outcome: 'prehash_mismatch',
      detail: 'message_prehash is not readable: the document is not an object',
    };
  }
  return { root };
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Follows an exact-name path. `found` is false when a member on the path is absent or null;
 * `notObject` names the first value on the path that is present but not an object.
 */
export function memberAt(
  root: JsonObject,
  path: readonly string[],
): { value?: unknown; found: boolean; notObject?: string } {
  let current: JsonObject = root;
  for (let i = 0; i < path.length; i++) {
    const name = path[i]!;
    const value = Object.hasOwn(current, name) ? current[name] : undefined;
    if (value === undefined || value === null) return { found: false };
    if (i === path.length - 1) return { value, found: true };
    if (!isObject(value)) return { found: false, notObject: path.slice(0, i + 1).join('.') };
    current = value;
  }
  return { found: false };
}

const PAYMENT_ID_KEY = foldMemberName('paymentid');
const REQUEST_HASH_KEY = foldMemberName('depositrequesthash');

/**
 * The member a name denotes once case, underscores and the payment_id alias are set aside. A deposit
 * record naming one member twice this way is ambiguous to a reader that rewrites snake_case to
 * camelCase or accepts that alias.
 */
function recordMemberKey(name: string): string {
  const key = foldMemberName(name.replaceAll('_', ''));
  return key === PAYMENT_ID_KEY ? REQUEST_HASH_KEY : key;
}

/** Whether a flat deposit record (Solana, Stellar) names one member twice by that rule. */
export function recordSpelledTwice(root: JsonObject): boolean {
  const seen = new Set<string>();
  for (const name of Object.keys(root)) {
    const key = recordMemberKey(name);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** Reads a flat deposit record's string member: absent or blank is commitment_absent, a non-string prehash_mismatch. */
export function readMember(
  root: JsonObject,
  name: string,
  absentDetail: string,
): string | { outcome: CommitmentOutcome; detail: string } {
  const { value, found } = memberAt(root, [name]);
  if (!found) return { outcome: 'commitment_absent', detail: absentDetail };
  if (typeof value !== 'string')
    return {
      outcome: 'prehash_mismatch',
      detail: `message_prehash is not readable: ${name} is not a string`,
    };
  if (isJsonBlank(value)) return { outcome: 'commitment_absent', detail: absentDetail };
  return value;
}

/** Reads a committed string member: absent, null or blank is commitment_absent; any other non-string is prehash_mismatch. */
function readCommitmentMember(
  root: JsonObject,
  absentDetail: string,
  path: readonly string[],
): string | Refusal {
  const { value, found, notObject } = memberAt(root, path);
  if (notObject !== undefined) {
    return {
      outcome: 'prehash_mismatch',
      detail: `message_prehash is not readable: ${notObject} is not an object`,
    };
  }
  if (!found) return { outcome: 'commitment_absent', detail: absentDetail };
  if (typeof value !== 'string') {
    return {
      outcome: 'prehash_mismatch',
      detail: `message_prehash is not readable: ${path.join('.')} is not a string`,
    };
  }
  if (isJsonBlank(value)) return { outcome: 'commitment_absent', detail: absentDetail };
  return value;
}

const PERMIT_WITNESS_PRIMARY_TYPE = 'PermitWitnessTransferFrom';
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Rebuilds the Permit2 digest from the prehash and requires it to equal the signed message, so the
 * commitment read above is the one inside the signature. The chain id comes from the payment's source
 * network; the verifying contract comes from the prehash, because an attacker who changes it changes
 * the digest. Returns "" when bound, else the refusal detail. Mirrors the Go `bindPermitDigest`.
 */
function bindPermitDigest(
  namespace: string,
  network: string,
  root: JsonObject,
  message: string,
  destination: string,
  hash: string,
  tronChainIds: CommitmentOptions['tronChainIds'],
): string {
  const rebuilt = permitDigest(
    namespace,
    network,
    root,
    destination,
    hash,
    undefined,
    tronChainIds,
  );
  if (typeof rebuilt === 'string') return rebuilt;
  return signedDigestProblem(message, rebuilt.digest, DETAIL_PERMIT_DIGEST_MISMATCH);
}

/**
 * Reads the prehash strictly and rebuilds its Permit2 digest over the canonical types, with the chain
 * id of the payment's source network, read with `tronChainIds` on Tron. `verifyingContract`, when
 * given, replaces the prehash's own (recoverAndVerify pins the Permit2 the escrow actually uses). A
 * string is the refusal detail. Mirrors the Go `permitDigest`.
 */
export function permitDigest(
  namespace: string,
  network: string,
  root: JsonObject,
  destination: string,
  hash: string,
  verifyingContract?: string,
  tronChainIds?: CommitmentOptions['tronChainIds'],
): { digest: string; fields: PermitFields } | string {
  const undecodable = 'message_prehash commits a destination but is not decodable typed data: ';
  let chainId: number;
  try {
    chainId =
      namespace === 'eip155' ? evmChainId(network) : tronNumericChainId(network, tronChainIds);
  } catch (e) {
    return undecodable + (e as Error).message;
  }
  const fields = readPermitFields(root, chainId);
  if (typeof fields === 'string') return undecodable + fields;
  // Addresses are lowercased for the encoders so none applies a checksum rule to a value that is
  // only an address; the digest does not depend on case.
  const permit2 = (verifyingContract ?? fields.verifyingContract).toLowerCase();
  const lower = {
    token: fields.token.toLowerCase(),
    spender: fields.spender.toLowerCase(),
    reserver: fields.reserver.toLowerCase(),
    releaser: fields.releaser.toLowerCase(),
  };
  let canonical: { types: unknown };
  let digest: string;
  try {
    if (namespace === 'eip155') {
      const typedData = createPermitWitnessTransferFromPrehashWithDestination({
        chainId,
        verifyingContract: permit2,
        token: lower.token,
        amount: fields.amount,
        spender: lower.spender,
        nonce: fields.nonce,
        deadline: fields.deadline,
        depositRequestHash: hash,
        destination,
        reserver: lower.reserver,
        releaser: lower.releaser,
      });
      canonical = typedData;
      digest = hashPermitWitnessTransferFrom(typedData);
    } else {
      const typedData = createTvmPermitWitnessTransferFromPrehashWithDestination({
        chainId,
        permit2Address: permit2,
        tokenAddress: lower.token,
        amount: fields.amount,
        spenderAddress: lower.spender,
        nonce: fields.nonce,
        deadline: fields.deadline,
        reserverAddress: lower.reserver,
        releaserAddress: lower.releaser,
        depositRequestHash: hash,
        destination,
      });
      canonical = typedData;
      digest = hashTvmPermitWitnessTransferFrom(typedData);
    }
  } catch (e) {
    return undecodable + (e as Error).message;
  }
  if (
    !sameMessageTypes(Object.hasOwn(root, 'types') ? root['types'] : undefined, canonical.types)
  ) {
    return undecodable + 'types are not the Permit2 deposit witness types';
  }
  return { digest, fields };
}

/** A Permit2 deposit read strictly for recoverAndVerify. */
export interface VerifiedPermit {
  fields: PermitFields;
  destination: string;
  hashText: string;
  hash: string;
  digest: string;
}

/** The largest deadline, in Unix seconds, a verifier accepts: the largest integer both languages represent exactly. */
export const MAX_DEADLINE_SEC = Number.MAX_SAFE_INTEGER;

/**
 * Reads a Permit2 deposit for recoverAndVerify: the same strict reading the commitment check uses,
 * with the digest rebuilt over `permit2`, which the signed message must equal. Every refusal carries
 * its commitment outcome. A prehash that commits no destination or request hash throws
 * `CommitmentError`; any other unusable prehash throws `MalformedPrehashError`. Mirrors the Go
 * `readPermitForVerify`.
 */
export function readPermitForVerify(
  namespace: string,
  signed: SignedMessageInput,
  source: { network: string },
  permit2: string,
  commitment: CommitmentExpectation,
): VerifiedPermit {
  const read = readPrehash(signed.message_prehash);
  if ('outcome' in read) throw malformedPrehash(namespace, read.outcome, read.detail);
  const root = read.root;
  const destination = readCommitmentMember(root, DETAIL_NO_DESTINATION, [
    'message',
    'witness',
    'destination',
  ]);
  if (typeof destination !== 'string') {
    if (destination.outcome === 'commitment_absent') {
      throw commitmentRefusal(namespace, destination.outcome, destination.detail);
    }
    throw malformedPrehash(namespace, destination.outcome, destination.detail);
  }
  const hashText = readCommitmentMember(root, DETAIL_NO_REQUEST_HASH, [
    'message',
    'witness',
    'depositRequestHash',
  ]);
  if (typeof hashText !== 'string') {
    if (hashText.outcome === 'commitment_absent') {
      throw new CommitmentError({
        ...emptyResult(),
        ...hashText,
        namespace,
        signedDestination: echo(wellFormed(destination)),
      });
    }
    throw malformedPrehash(namespace, hashText.outcome, hashText.detail);
  }
  const hash = parseHash32(hashText);
  if (hash === undefined)
    throw malformedPrehash(namespace, 'prehash_mismatch', DETAIL_BAD_REQUEST_HASH);
  // The encoders take the signed destination as it is, so one that can never match is refused first,
  // with the outcome the commitment check gives it.
  if (
    !isWellFormedText(destination) ||
    new TextEncoder().encode(destination).length > MAX_DESTINATION_BYTES
  ) {
    requireCommitment(namespace, destination, hashText, hash, commitment);
    throw malformedPrehash(
      namespace,
      'destination_mismatch',
      'the signed destination cannot be committed to',
    );
  }
  const rebuilt = permitDigest(namespace, source.network, root, destination, hash, permit2);
  if (typeof rebuilt === 'string') throw malformedPrehash(namespace, 'prehash_mismatch', rebuilt);
  const digestProblem = signedDigestProblem(
    signed.message,
    rebuilt.digest,
    DETAIL_PERMIT_DIGEST_MISMATCH,
  );
  if (digestProblem !== '') throw commitmentRefusal(namespace, 'prehash_mismatch', digestProblem);
  if (BigInt(rebuilt.fields.deadline) > BigInt(MAX_DEADLINE_SEC)) {
    throw malformedPrehash(namespace, 'prehash_mismatch', DETAIL_DEADLINE_RANGE);
  }
  return { fields: rebuilt.fields, destination, hashText, hash, digest: rebuilt.digest };
}

/** Compares a signed commitment with the payment's own and returns the result; a mismatch throws `CommitmentError`. */
export function requireCommitment(
  namespace: string,
  signedDestination: string,
  signedHashText: string,
  signedHash: string,
  commitment: CommitmentExpectation,
): CommitmentResult {
  const r = compareExpected(
    { ...emptyResult(), namespace, signedDepositRequestHash: echo(wellFormed(signedHashText)) },
    signedDestination,
    signedHash,
    commitment,
  );
  if (r.outcome !== 'verified') throw new CommitmentError(r);
  return r;
}

/** A `CommitmentError` with the given outcome. */
export function commitmentRefusal(
  namespace: string,
  outcome: CommitmentOutcome,
  detail: string,
): CommitmentError {
  return new CommitmentError({ ...emptyResult(), outcome, detail, namespace });
}

/** An unusable prehash, reported as `MalformedPrehashError` carrying the commitment outcome it maps to. */
export function malformedPrehash(
  namespace: string,
  outcome: CommitmentOutcome,
  detail: string,
): MalformedPrehashError {
  const result: CommitmentResult = { ...emptyResult(), outcome, detail, namespace };
  return new MalformedPrehashError(
    `sender_auth: malformed message_prehash: sender_auth: ${outcome}: ${detail}`,
    result,
  );
}

export interface PermitFields {
  verifyingContract: string;
  token: string;
  spender: string;
  reserver: string;
  releaser: string;
  amount: string;
  nonce: string;
  deadline: string;
}

/**
 * Every member the Permit2 deposit typed data may carry, per object. Anything else is refused: no
 * reader needs it, and an unread member is room for a second meaning.
 */
const PERMIT_MEMBERS: ReadonlyArray<
  [path: readonly string[] | undefined, allowed: readonly string[]]
> = [
  [undefined, ['types', 'primaryType', 'domain', 'message']],
  [['domain'], ['name', 'version', 'chainId', 'verifyingContract', 'salt']],
  [['message'], ['permitted', 'spender', 'nonce', 'deadline', 'witness']],
  [
    ['message', 'permitted'],
    ['token', 'amount'],
  ],
  [
    ['message', 'witness'],
    ['depositRequestHash', 'destination', 'reserver', 'releaser'],
  ],
];
const CHAIN_ID = /^0x[1-9a-fA-F][0-9a-fA-F]*$/;

/** Reads the typed-data members the digest is rebuilt from, validated strictly; a string is the reason for refusal. */
function readPermitFields(root: JsonObject, chainId: number): PermitFields | string {
  for (const [path, allowed] of PERMIT_MEMBERS) {
    const object = path === undefined ? root : memberAt(root, path).value;
    if (!isObject(object)) return `${path!.join('.')} is not an object`;
    if (Object.keys(object).some((name) => !allowed.includes(name))) {
      return `${path === undefined ? 'the typed data' : path.join('.')} carries a member the Permit2 deposit typed data does not define`;
    }
  }
  if (!Object.hasOwn(root, 'primaryType') || root['primaryType'] !== PERMIT_WITNESS_PRIMARY_TYPE) {
    return `primaryType is not ${PERMIT_WITNESS_PRIMARY_TYPE}`;
  }
  const domain = root['domain'] as JsonObject;
  if (domain['name'] !== 'Permit2') return 'domain.name is not Permit2';
  for (const optional of ['version', 'salt']) {
    if (Object.hasOwn(domain, optional) && domain[optional] !== '')
      return `domain.${optional} must be empty`;
  }
  const id = domain['chainId'];
  if (
    typeof id !== 'string' ||
    !CHAIN_ID.test(id) ||
    id.slice(2).toLowerCase() !== chainId.toString(16)
  ) {
    return 'domain.chainId is not the source chain';
  }
  const out: Record<string, string> = {};
  const addresses: Array<[keyof PermitFields, string[]]> = [
    ['verifyingContract', ['domain', 'verifyingContract']],
    ['token', ['message', 'permitted', 'token']],
    ['spender', ['message', 'spender']],
    ['reserver', ['message', 'witness', 'reserver']],
    ['releaser', ['message', 'witness', 'releaser']],
  ];
  for (const [key, path] of addresses) {
    const { value } = memberAt(root, path);
    if (typeof value !== 'string' || !HEX_ADDRESS.test(value)) {
      return `${path.join('.')} is not a 0x-prefixed 20-byte hex address`;
    }
    out[key] = value;
  }
  const numbers: Array<[keyof PermitFields, string[]]> = [
    ['amount', ['message', 'permitted', 'amount']],
    ['nonce', ['message', 'nonce']],
    ['deadline', ['message', 'deadline']],
  ];
  for (const [key, path] of numbers) {
    const { value } = memberAt(root, path);
    if (typeof value !== 'string' || !UINT.test(value))
      return `${path.join('.')} is not a decimal integer string`;
    if (BigInt(value) > MAX_UINT256) return `${path.join('.')} exceeds uint256`;
    out[key] = value;
  }
  return out as unknown as PermitFields;
}

/**
 * Whether the prehash declares exactly the canonical message types. An EIP712Domain entry is ignored
 * on both sides: the digest is rebuilt over the canonical domain.
 */
export function sameMessageTypes(declared: unknown, canonical: unknown): boolean {
  if (!isObject(declared) || !isObject(canonical)) return false;
  const strip = (types: JsonObject): JsonObject =>
    Object.fromEntries(Object.entries(types).filter(([name]) => name !== 'EIP712Domain'));
  return jsonEqual(strip(declared), strip(canonical));
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonEqual(v, b[i]))
    );
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return a === b;
}
