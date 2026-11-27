import bs58 from 'bs58';
import {
  computeDepositHashV2,
  isSmallOrderEncoding,
  matchEscrowWitness,
  messageForms,
  Pubkey,
  verifyEd25519Strict,
  WitnessKind,
  type EscrowDomain,
  type MessageScheme,
} from '@atum-labs/solana-escrow-encoding';

import type { SignedMessageInput } from './types.js';
import { clusterIdFromName } from './chain-id.js';
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
  SolanaDomain,
} from './commitment-rules.js';

type JsonObject = Record<string, unknown>;

/** Signature domain version from which the deposit hash commits the destination. */
export const SVM_DESTINATION_COMMITMENT_VERSION = 4;

/**
 * The Solana arm. The payer signs, with ed25519, the escrow program's deposit hash; the prehash is
 * the flat record that hash is computed from. The hash is recomputed with the verifier's escrow
 * domain, and the signature is checked against it, so the commitment read from the record is the one
 * the payer signed. Mirrors the Go `verifySolanaCommitment`.
 */
export function verifySolanaCommitment(
  r: CommitmentResult,
  sourceAccount: string,
  deposit: SignedMessageInput,
  expected: CommitmentExpectation,
  solana: SolanaDomain | undefined,
): CommitmentResult {
  if (solana === undefined) {
    return withOutcome(
      r,
      'verifier_misconfigured',
      'the Solana escrow domain (program id, cluster, domain version) was not supplied',
    );
  }
  const domain = solanaEscrowDomain(solana);
  if (typeof domain === 'string') return withOutcome(r, 'verifier_misconfigured', domain);
  if (domain.signatureDomainVersion < SVM_DESTINATION_COMMITMENT_VERSION) {
    return withOutcome(
      r,
      'commitment_absent',
      `the escrow's signature domain version ${domain.signatureDomainVersion} commits no destination; every deployed escrow requires version ${SVM_DESTINATION_COMMITMENT_VERSION} or later`,
    );
  }
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
  const refusal = bindSolanaDeposit(domain, root, deposit, sourceAccount, solana.messageScheme);
  return refusal === undefined ? r : withOutcome(r, refusal.outcome, refusal.detail);
}

/** A Solana deposit read for recoverAndVerify. */
export interface SolanaDepositForVerify {
  record: SolanaRecord;
  destination: string;
  hashText: string;
  root: JsonObject;
  domain: EscrowDomain;
}

/**
 * Reads a Solana deposit for recoverAndVerify with the commitment check's rules and outcomes. A
 * missing or unusable escrow domain, or a record that commits no destination or request hash,
 * throws `CommitmentError`; any other unusable prehash throws `MalformedPrehashError` carrying its
 * outcome. Mirrors the Go `solanaCanonical`.
 */
export function readSolanaDepositForVerify(
  deposit: SignedMessageInput,
  solana: SolanaDomain | undefined,
): SolanaDepositForVerify {
  const fail = (outcome: CommitmentOutcome, detail: string) =>
    malformedPrehash('solana', outcome, detail);
  if (solana === undefined) {
    throw commitmentRefusal(
      'solana',
      'verifier_misconfigured',
      'the Solana escrow domain (program id, cluster, domain version) was not supplied',
    );
  }
  const domain = solanaEscrowDomain(solana);
  if (typeof domain === 'string')
    throw commitmentRefusal('solana', 'verifier_misconfigured', domain);
  if (domain.signatureDomainVersion < SVM_DESTINATION_COMMITMENT_VERSION) {
    throw commitmentRefusal(
      'solana',
      'commitment_absent',
      `the escrow's signature domain version ${domain.signatureDomainVersion} commits no destination; every deployed escrow requires version ${SVM_DESTINATION_COMMITMENT_VERSION} or later`,
    );
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
      throw commitmentRefusal('solana', member.outcome, member.detail);
    }
  }
  const destination = readMember(root, 'destination', DETAIL_NO_DESTINATION);
  if (typeof destination !== 'string') throw fail(destination.outcome, destination.detail);
  const hashText = readMember(root, 'deposit_request_hash', DETAIL_NO_REQUEST_HASH);
  if (typeof hashText !== 'string') throw fail(hashText.outcome, hashText.detail);
  if (parseHash32(hashText) === undefined) throw fail('prehash_mismatch', DETAIL_BAD_REQUEST_HASH);
  const record = readSolanaRecord(root);
  if (typeof record === 'string') {
    throw fail(
      'prehash_mismatch',
      'message_prehash commits a destination but is not a readable Solana deposit record: ' +
        record,
    );
  }
  return { record, destination, hashText, root, domain };
}

/** Validates the verifier-supplied domain; a string is the reason it is unusable. */
export function solanaEscrowDomain(d: SolanaDomain): EscrowDomain | string {
  let programId: Pubkey;
  try {
    if (typeof d.escrowProgramId !== 'string' || !BASE58.test(d.escrowProgramId)) throw new Error();
    programId = Pubkey.fromBase58(d.escrowProgramId);
  } catch {
    return 'the Solana escrow program id is not a base58 32-byte public key';
  }
  if (programId.isZero()) return 'the Solana escrow program id is the zero key';
  if (typeof d.clusterId !== 'string' || d.clusterId === '')
    return 'the Solana escrow cluster id is empty';
  let clusterId: Uint8Array;
  try {
    clusterId = clusterIdFromName(d.clusterId);
  } catch {
    return 'the Solana escrow cluster id is longer than 32 bytes';
  }
  if (!Number.isInteger(d.domainVersion) || d.domainVersion < 1 || d.domainVersion > 255) {
    return 'the Solana escrow signature domain version must be between 1 and 255';
  }
  try {
    messageForms(d.messageScheme ?? '');
  } catch (e) {
    return 'the Solana escrow message scheme is not known: ' + (e as Error).message;
  }
  return { clusterId, signatureDomainVersion: d.domainVersion, programId };
}

/** Every member a Solana deposit record carries. */
const SOLANA_RECORD_MEMBERS = [
  'deposit_request_hash',
  'destination',
  'depositor',
  'mint',
  'amount',
  'reserver',
  'releaser',
  'nonce',
  'issued_at',
  'deadline',
] as const;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const DIGEST = /^0x[0-9a-fA-F]{64}$/;
const ED25519_SIGNATURE = /^0x[0-9a-fA-F]{128}$/;
export { BASE58 as SOLANA_BASE58, DIGEST as SOLANA_DIGEST, ED25519_SIGNATURE as SOLANA_SIGNATURE };
const MAX_U64 = (1n << 64n) - 1n;

interface SolanaRecord {
  params: Parameters<typeof computeDepositHashV2>[0];
  destination: string;
  fields: Record<string, string>;
}

/** Reads the deposit record the escrow program hashes; a string is the reason it is unreadable. Mirrors the Go `readSolanaRecord`. */
export function readSolanaRecord(root: JsonObject): SolanaRecord | string {
  if (
    Object.keys(root).some((name) => !(SOLANA_RECORD_MEMBERS as readonly string[]).includes(name))
  ) {
    return 'it carries a member the Solana deposit record does not define';
  }
  const fields: Record<string, string> = {};
  for (const name of SOLANA_RECORD_MEMBERS) {
    const { value } = memberAt(root, [name]);
    if (typeof value !== 'string') return `${name} is not a string`;
    fields[name] = value;
  }
  const destination = fields['destination']!;
  if (isJsonBlank(destination)) return 'destination is blank';
  const hash = parseHash32(fields['deposit_request_hash']!);
  if (hash === undefined) return 'deposit_request_hash is not a 32-byte hex value';
  const keys: Record<string, Pubkey> = {};
  for (const name of ['depositor', 'mint', 'reserver', 'releaser']) {
    let key: Pubkey | undefined;
    try {
      if (BASE58.test(fields[name]!)) key = Pubkey.fromBase58(fields[name]!);
    } catch {
      key = undefined;
    }
    if (key === undefined || key.isZero())
      return `${name} is not a non-zero base58 32-byte public key`;
    keys[name] = key;
  }
  const numbers: Record<string, bigint> = {};
  for (const name of ['amount', 'nonce', 'issued_at', 'deadline']) {
    if (!UINT.test(fields[name]!)) return `${name} is not a decimal integer string`;
    const value = BigInt(fields[name]!);
    if (value > MAX_U64) return `${name} exceeds u64`;
    numbers[name] = value;
  }
  if (numbers['amount'] === 0n) return 'amount is zero';
  return {
    destination,
    fields,
    params: {
      depositRequestHash: hexBytes(hash),
      depositor: keys['depositor']!,
      mint: keys['mint']!,
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
 * Whether payload.delegate_signer is absent, null, or exactly `account`; a payload that is not an
 * object is refused. Mirrors the Go `solanaDelegateIs`.
 */
export function solanaDelegateIs(payload: unknown, account: string): boolean {
  if (payload === undefined || payload === null) return true;
  if (!isObject(payload)) return false;
  if (!Object.hasOwn(payload, 'delegate_signer')) return true;
  const v = payload['delegate_signer'];
  return v === null || v === undefined || v === account;
}

/**
 * Recomputes the deposit hash from the record, requires it to be the signed message, and verifies
 * the payer's ed25519 signature over it in a form the escrow's message `scheme` accepts (the raw
 * hash by default). Returns undefined when bound.
 */
export function bindSolanaDeposit(
  domain: EscrowDomain,
  root: JsonObject,
  deposit: SignedMessageInput,
  sourceAccount: string,
  scheme: MessageScheme = '',
): { outcome: CommitmentOutcome; detail: string } | undefined {
  const prehash = (detail: string) => ({ outcome: 'prehash_mismatch' as const, detail });
  const signer = (detail: string) => ({ outcome: 'signer_mismatch' as const, detail });
  const unreadable =
    'message_prehash commits a destination but is not a readable Solana deposit record: ';
  const rec = readSolanaRecord(root);
  if (typeof rec === 'string') return prehash(unreadable + rec);
  let digest: Uint8Array;
  try {
    digest = computeDepositHashV2(rec.params, rec.destination, domain);
  } catch (e) {
    return prehash(unreadable + (e as Error).message);
  }
  const digestProblem = signedDigestProblem(
    deposit.message,
    Buffer.from(digest).toString('hex'),
    'the signed digest is not the Solana deposit hash of message_prehash',
  );
  if (digestProblem !== '') return prehash(digestProblem);
  if (rec.fields['depositor'] !== sourceAccount)
    return signer("the signed deposit's depositor is not the payment's source account");
  if (!solanaDelegateIs(deposit.payload, sourceAccount))
    return signer("the delegate signer is not the payment's source account");
  let key: Uint8Array | undefined;
  try {
    if (BASE58.test(sourceAccount)) key = bs58.decode(sourceAccount);
  } catch {
    key = undefined;
  }
  if (key === undefined || key.length !== 32)
    return signer("the payment's source account is not a base58 ed25519 public key");
  const signature = deposit.signature;
  if (typeof signature !== 'string' || !ED25519_SIGNATURE.test(signature))
    return signer('the signature is not a 64-byte hex ed25519 signature');
  const sig = hexBytes('0x' + signature.slice(2));
  if (matchEscrowWitness(scheme, WitnessKind.Deposit, digest, key, sig) === undefined) {
    return signer("the ed25519 signature does not verify against the payment's source account");
  }
  return undefined;
}

/**
 * ed25519 verification as the Solana ed25519 program performs it, and whether a point is of small
 * order. Both are the escrow encoding's.
 */
export { isSmallOrderEncoding, verifyEd25519Strict };
