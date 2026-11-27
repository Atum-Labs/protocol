import {
  Address,
  CONTRACT_ADDRESS,
  MAX_DEPOSIT_VALIDITY_SECS,
  MAX_I128,
  Pubkey,
  computeDepositHash,
  newEscrowDomain,
  type EscrowDomain,
} from '@atum-labs/stellar-escrow-encoding';

import type { SignedMessageInput } from './types.js';
import { stellarNetworkString } from './chain-id.js';
import { wellFormed } from './json-members.js';
import {
  commitmentRefusal,
  isObject,
  malformedPrehash,
  memberAt,
  readMember,
  readPrehash,
  recordSpelledTwice,
} from './commitment-permit.js';
import {
  DETAIL_BAD_REQUEST_HASH,
  DETAIL_NO_DESTINATION,
  DETAIL_NO_REQUEST_HASH,
  compareExpected,
  echo,
  hexBytes,
  isJsonBlank,
  parseHash32,
  signedDigestProblem,
  withOutcome,
} from './commitment-rules.js';
import type {
  CommitmentExpectation,
  CommitmentOutcome,
  CommitmentResult,
} from './commitment-rules.js';
import { verifyEd25519Strict } from './commitment-solana.js';

type JsonObject = Record<string, unknown>;

/**
 * The Stellar arm. The payer's delegate signer signs, with ed25519, the escrow's deposit digest; the
 * prehash is the flat record that digest is computed from. The digest is recomputed with the network
 * the payment names and the escrow the verifier is configured with, and the signature is checked
 * against it, so the commitment read from the record is the one the delegate signed. Whether that
 * delegate is registered for the depositor is on chain state (`create_delegate`), which no offline
 * check can read. Mirrors the Go `verifyStellarCommitment`.
 */
export function verifyStellarCommitment(
  r: CommitmentResult,
  network: string,
  sourceAccount: string,
  deposit: SignedMessageInput,
  expected: CommitmentExpectation,
  escrow: string | undefined,
): CommitmentResult {
  const domain = stellarEscrowDomain(network, escrow);
  if (typeof domain === 'string') return withOutcome(r, 'verifier_misconfigured', domain);
  const prehash = readPrehash(deposit.message_prehash);
  if ('outcome' in prehash) return withOutcome(r, prehash.outcome, prehash.detail);
  const root = prehash.root;
  if (recordSpelledTwice(root))
    return withOutcome(r, 'prehash_mismatch', 'message_prehash spells one member two ways');
  const destination = readMember(root, 'destination', DETAIL_NO_DESTINATION);
  if (typeof destination !== 'string')
    return withOutcome(r, destination.outcome, destination.detail);
  r = { ...r, signedDestination: echo(wellFormed(destination)) };
  const hashText = readMember(root, 'deposit_request_hash', DETAIL_NO_REQUEST_HASH);
  if (typeof hashText !== 'string') return withOutcome(r, hashText.outcome, hashText.detail);
  r = { ...r, signedDepositRequestHash: echo(wellFormed(hashText)) };
  const hash = parseHash32(hashText);
  if (hash === undefined) return withOutcome(r, 'prehash_mismatch', DETAIL_BAD_REQUEST_HASH);
  r = compareExpected(r, destination, hash, expected);
  if (r.outcome !== 'verified') return r;
  const record = readStellarRecord(root);
  if (typeof record === 'string')
    return withOutcome(r, 'prehash_mismatch', STELLAR_UNREADABLE + record);
  const refusal = bindStellarDeposit(domain, record, deposit, sourceAccount);
  return refusal === undefined ? r : withOutcome(r, refusal.outcome, refusal.detail);
}

/** Why a Stellar verification is refused when the expected reserver or releaser is absent. */
export const STELLAR_ROLES_UNSET =
  'the Stellar verifier must be given the expected reserver and releaser, and none was';

/** A Stellar deposit read for recoverAndVerify. */
export interface StellarDepositForVerify {
  record: StellarRecord;
  destination: string;
  hashText: string;
  root: JsonObject;
  domain: EscrowDomain;
}

/**
 * Reads a Stellar deposit for recoverAndVerify with the commitment check's rules and outcomes. A
 * missing or unusable escrow, or a record that commits no destination or request hash, throws
 * `CommitmentError`; any other unusable prehash throws `MalformedPrehashError` carrying its outcome.
 * Mirrors the Go `stellarCanonical`.
 */
export function readStellarDepositForVerify(
  deposit: SignedMessageInput,
  network: string,
  escrow: string | undefined,
  roles: { reserver?: string; releaser?: string },
): StellarDepositForVerify {
  const fail = (outcome: CommitmentOutcome, detail: string) =>
    malformedPrehash('stellar', outcome, detail);
  const domain = stellarEscrowDomain(network, escrow);
  if (typeof domain === 'string')
    throw commitmentRefusal('stellar', 'verifier_misconfigured', domain);
  // Fail closed, deliberately stricter than EVM and Solana (where omitted roles skip the check): the
  // reserver and releaser are free members of the signed record, so a verifier that does not pin them
  // would admit a deposit whose releaser the requester controls.
  if (!roles.reserver || !roles.releaser) {
    throw commitmentRefusal('stellar', 'verifier_misconfigured', STELLAR_ROLES_UNSET);
  }
  const prehash = readPrehash(deposit.message_prehash);
  if ('outcome' in prehash) throw fail(prehash.outcome, prehash.detail);
  const root = prehash.root;
  if (recordSpelledTwice(root)) {
    throw fail('prehash_mismatch', 'message_prehash spells one member two ways');
  }
  for (const [name, absent] of [
    ['destination', DETAIL_NO_DESTINATION],
    ['deposit_request_hash', DETAIL_NO_REQUEST_HASH],
  ] as const) {
    const member = readMember(root, name, absent);
    if (typeof member !== 'string' && member.outcome === 'commitment_absent') {
      throw commitmentRefusal('stellar', member.outcome, member.detail);
    }
  }
  const destination = readMember(root, 'destination', DETAIL_NO_DESTINATION);
  if (typeof destination !== 'string') throw fail(destination.outcome, destination.detail);
  const hashText = readMember(root, 'deposit_request_hash', DETAIL_NO_REQUEST_HASH);
  if (typeof hashText !== 'string') throw fail(hashText.outcome, hashText.detail);
  if (parseHash32(hashText) === undefined) throw fail('prehash_mismatch', DETAIL_BAD_REQUEST_HASH);
  const record = readStellarRecord(root);
  if (typeof record === 'string') {
    throw fail('prehash_mismatch', STELLAR_UNREADABLE + record);
  }
  return { record, destination, hashText, root, domain };
}

/**
 * The escrow domain for a `stellar:<reference>` network and the verifier's own escrow contract; a
 * string is the reason it is unusable. The escrow comes from verifier configuration, never from the
 * payment.
 */
export function stellarEscrowDomain(
  network: string,
  escrow: string | undefined,
): EscrowDomain | string {
  let networkString: string;
  try {
    networkString = stellarNetworkString(network);
  } catch {
    return 'the Stellar network is not one the verifier knows';
  }
  if (typeof escrow !== 'string' || escrow === '') {
    return 'the Stellar escrow contract was not supplied';
  }
  let address: Address;
  try {
    address = Address.fromStrkey(escrow);
  } catch {
    return 'the Stellar escrow is not a contract (C...) address';
  }
  if (address.type !== CONTRACT_ADDRESS)
    return 'the Stellar escrow is not a contract (C...) address';
  try {
    return newEscrowDomain(networkString, address);
  } catch {
    return 'the Stellar escrow is not a usable contract (C...) address';
  }
}

/** Prefix of the reason a Stellar deposit record cannot be read. */
const STELLAR_UNREADABLE =
  'message_prehash commits a destination but is not a readable Stellar deposit record: ';

/** Every member a Stellar deposit record carries. */
const STELLAR_RECORD_MEMBERS = [
  'deposit_request_hash',
  'destination',
  'depositor',
  'token',
  'epoch',
  'amount',
  'reserver',
  'releaser',
  'nonce',
  'issued_at',
  'deadline',
] as const;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;
const ED25519_SIGNATURE = /^0x[0-9a-fA-F]{128}$/;
export { DIGEST as STELLAR_DIGEST, ED25519_SIGNATURE as STELLAR_SIGNATURE };
const MAX_U64 = (1n << 64n) - 1n;

export interface StellarRecord {
  params: Parameters<typeof computeDepositHash>[0];
  destination: string;
  fields: Record<string, string>;
}

/** Reads the deposit record the escrow hashes; a string is the reason it is unreadable. Mirrors the Go `readStellarRecord`. */
export function readStellarRecord(root: JsonObject): StellarRecord | string {
  if (
    Object.keys(root).some((name) => !(STELLAR_RECORD_MEMBERS as readonly string[]).includes(name))
  ) {
    return 'it carries a member the Stellar deposit record does not define';
  }
  const fields: Record<string, string> = {};
  for (const name of STELLAR_RECORD_MEMBERS) {
    const { value } = memberAt(root, [name]);
    if (typeof value !== 'string') return `${name} is not a string`;
    fields[name] = value;
  }
  const destination = fields['destination']!;
  if (isJsonBlank(destination)) return 'destination is blank';
  const hash = parseHash32(fields['deposit_request_hash']!);
  if (hash === undefined) return 'deposit_request_hash is not a 32-byte hex value';
  // The depositor and token are G or C strkeys. A muxed (M, W) or other strkey has no 33 byte form
  // the contract accepts, so it is refused here rather than hashed into a digest no deposit can use.
  const addresses: Record<string, Address> = {};
  for (const name of ['depositor', 'token']) {
    try {
      addresses[name] = Address.fromStrkey(fields[name]!);
    } catch {
      return `${name} is not a G or C strkey`;
    }
  }
  const keys: Record<string, Pubkey> = {};
  for (const name of ['reserver', 'releaser']) {
    try {
      keys[name] = Pubkey.fromStrkey(fields[name]!);
    } catch {
      return `${name} is not a G strkey`;
    }
    if (keys[name]!.isZero()) return `${name} is the zero key`;
  }
  const numbers: Record<string, bigint> = {};
  for (const name of ['epoch', 'amount', 'nonce', 'issued_at', 'deadline']) {
    if (!UINT.test(fields[name]!)) return `${name} is not a decimal integer string`;
    numbers[name] = BigInt(fields[name]!);
  }
  for (const name of ['epoch', 'nonce', 'issued_at', 'deadline']) {
    if (numbers[name]! > MAX_U64) return `${name} exceeds u64`;
  }
  // The first record of a (depositor, token) has epoch 1: the contract never assigns 0.
  if (numbers['epoch'] === 0n) return 'epoch is zero';
  if (numbers['deadline']! <= numbers['issued_at']!) return 'deadline is not after issued_at';
  if (numbers['deadline']! - numbers['issued_at']! > MAX_DEPOSIT_VALIDITY_SECS) {
    return 'deadline is more than 86400 seconds after issued_at';
  }
  if (numbers['amount']! > MAX_I128) return 'amount exceeds i128';
  if (numbers['amount'] === 0n) return 'amount is zero';
  return {
    destination,
    fields,
    params: {
      depositRequestHash: hexBytes(hash),
      // As Go decodes the text: a lone surrogate becomes U+FFFD, so both hash the same bytes.
      destination: wellFormed(destination),
      depositor: addresses['depositor']!,
      token: addresses['token']!,
      epoch: numbers['epoch']!,
      amount: numbers['amount']!,
      reserver: keys['reserver']!,
      releaser: keys['releaser']!,
      nonce: numbers['nonce']!,
      issuedAt: numbers['issued_at']!,
      deadline: numbers['deadline']!,
    },
  };
}

/**
 * The delegate signer a Stellar signed message names: `payload.delegate_signer`, a G strkey. It is
 * required, because the signature is by that key and not by the depositor. Returns the 32 byte key,
 * or a string with the reason it is unusable. Mirrors the Go `stellarDelegateKey`.
 */
export function stellarDelegateKey(payload: unknown): Uint8Array | string {
  const v = isObject(payload) ? payload['delegate_signer'] : undefined;
  if (typeof v !== 'string') return 'payload.delegate_signer is required and must be a G strkey';
  try {
    return Pubkey.fromStrkey(v).toBytes();
  } catch {
    return 'payload.delegate_signer is not a G strkey';
  }
}

/**
 * Recomputes the deposit digest from the record, requires it to be the signed message, and verifies
 * the delegate signer's ed25519 signature over it. The record's depositor must be the payment's
 * source account. Returns undefined when bound.
 */
export function bindStellarDeposit(
  domain: EscrowDomain,
  rec: StellarRecord,
  deposit: SignedMessageInput,
  sourceAccount: string,
): { outcome: CommitmentOutcome; detail: string } | undefined {
  const prehash = (detail: string) => ({ outcome: 'prehash_mismatch' as const, detail });
  const signer = (detail: string) => ({ outcome: 'signer_mismatch' as const, detail });
  let digest: Uint8Array;
  try {
    digest = computeDepositHash(rec.params, domain);
  } catch (e) {
    return prehash(STELLAR_UNREADABLE + (e as Error).message);
  }
  const digestProblem = signedDigestProblem(
    deposit.message,
    Buffer.from(digest).toString('hex'),
    'the signed digest is not the Stellar deposit digest of message_prehash',
  );
  if (digestProblem !== '') return prehash(digestProblem);
  if (rec.fields['depositor'] !== sourceAccount)
    return signer("the signed deposit's depositor is not the payment's source account");
  const key = stellarDelegateKey(deposit.payload);
  if (typeof key === 'string') return signer(key);
  const signature = deposit.signature;
  if (typeof signature !== 'string' || !ED25519_SIGNATURE.test(signature))
    return signer('the signature is not a 64-byte hex ed25519 signature');
  if (!verifyEd25519Strict(key, digest, hexBytes(signature))) {
    return signer("the ed25519 signature does not verify against the payload's delegate signer");
  }
  return undefined;
}
