// A payment states its payee twice: signed, inside the deposit witness (destination and
// depositRequestHash), and unsigned, in payment_request.destination[0] and request_id. The escrow
// stores only the signed copy, while settlement pays the unsigned one, so every party that acts on a
// payment must confirm the two agree. The functions in this file are that check, identical in Go and
// TypeScript. Mirrors commitment.go.

import { evmChainId, namespaceOf, stellarNetworkString, tronNumericChainId } from './chain-id.js';
import { TronChainIdError } from './errors.js';
import { parseSourceAsset } from './utils.js';
import { isObject, verifyPermitCommitment } from './commitment-permit.js';
import { verifySolanaCommitment } from './commitment-solana.js';
import { verifyStellarCommitment } from './commitment-stellar.js';
import { decodeUtf8, firstAmbiguousMemberIn, wellFormed } from './json-members.js';
import { readDepositRequest } from './deposit-request-v2.js';
import {
  CommitmentError,
  DETAIL_BAD_REQUEST_HASH,
  DETAIL_NO_DESTINATION,
  DETAIL_NO_REQUEST_HASH,
  compareExpected,
  depositRequestHashV2Off,
  echo,
  emptyResult,
  finish,
  isJsonBlank,
  parseHash32,
  quoteValue,
  refuse,
  requestDepositRequestHash,
  requestDestination,
} from './commitment-rules.js';
import type {
  CommitmentExpectation,
  CommitmentOptions,
  CommitmentOutcome,
  CommitmentResult,
  DestinationLeg,
  SignedDeposit,
  SolanaDomain,
} from './commitment-rules.js';
import type { SignedMessageInput } from './types.js';

export { CommitmentError, commitmentResultOf } from './commitment-rules.js';
export type {
  CommitmentExpectation,
  CommitmentOptions,
  CommitmentOutcome,
  CommitmentResult,
  DestinationLeg,
  SignedDeposit,
  SolanaDomain,
} from './commitment-rules.js';

/** The result as structured log fields. The keys are the same in both languages. */
export function commitmentLogFields(result: CommitmentResult): Record<string, string> {
  return {
    sender_auth_result: result.outcome,
    scheme: result.scheme,
    source_namespace: result.namespace,
    signed_destination: result.signedDestination,
    request_destination: result.expectedDestination,
    signed_deposit_request_hash: result.signedDepositRequestHash,
    request_deposit_request_hash: result.expectedDepositRequestHash,
    detail: result.detail,
    // The depositRequestHash v2 fields, only when set, so an unopted check logs the same keys.
    ...(result.depositRequestHashVersion && {
      deposit_request_hash_version: result.depositRequestHashVersion,
    }),
    ...(result.expectedDepositRequestHashV2 && {
      request_deposit_request_hash_v2: result.expectedDepositRequestHashV2,
    }),
    ...(result.strictDetail && { strict_detail: result.strictDetail }),
  };
}

/**
 * Message schemes that can authorise a payment from each source namespace. The scheme is not signed,
 * so it is checked against the namespace and never dispatched on.
 */
const PERMITTED_SCHEMES: Readonly<Record<string, readonly string[]>> = {
  eip155: ['EVM_PERMIT2', 'EVM_PERMIT2_ESCROW'],
  tron: ['EVM_PERMIT2', 'EVM_PERMIT2_ESCROW', 'TRON'],
  solana: ['SOLANA'],
  stellar: ['STELLAR'],
};

/**
 * Checks that the signed deposit commits to exactly the payee and request the payment states,
 * reading the source chain from the payment and never from message_scheme. On Solana it also
 * verifies the ed25519 signature against the source account. On EVM and Tron the signature is
 * checked on chain by Permit2, which accepts contract accounts (ERC-1271) whose signature comes
 * from an owner key, so this check does not recover the signer; `recoverAndVerify` does, for key
 * accounts. The token, amount, roles and freshness are `recoverAndVerify`'s. `solana` is required
 * for a Solana source and ignored otherwise; `options.tronChainIds` is read for a Tron source and
 * ignored otherwise. Returns the result when verified; throws `CommitmentError` otherwise.
 *
 * @deprecated The caller reads the inputs out of the request itself, so the check cannot see the
 * text it acts on, and it accepts depositRequestHash v2 only if the caller derives it: any
 * `depositRequestHashV2Mode`, `retire` included, is refused as `verifier_misconfigured`, so it never
 * admits a v1 deposit a retiring caller meant to refuse. Use `verifyRequestCommitment` with the
 * request as received.
 */
export function verifyCommitment(
  signed: SignedDeposit,
  expected: CommitmentExpectation,
  solana?: SolanaDomain,
  options?: CommitmentOptions,
): CommitmentResult {
  if (!depositRequestHashV2Off(options?.depositRequestHashV2Mode))
    return refuse(
      emptyResult(),
      'verifier_misconfigured',
      'verifyCommitment cannot read depositRequestHash v2 from the request; use verifyRequestCommitment for depositRequestHashV2',
    );
  return checkCommitment(signed, expected, solana, options);
}

/** `verifyCommitment`, for the entry points that read the request themselves. */
function checkCommitment(
  signed: SignedDeposit,
  expected: CommitmentExpectation,
  solana?: SolanaDomain,
  options?: CommitmentOptions,
): CommitmentResult {
  const r = emptyResult();
  if (!isSignedDeposit(signed) || !isExpectation(expected)) {
    return refuse(r, 'request_malformed', 'the commitment inputs do not have the expected types');
  }
  r.scheme = echo(signed.messageScheme);
  const tronChainIds = options?.tronChainIds;
  const source = sourceNetwork(signed.sourceAssetIdentifier, tronChainIds);
  r.namespace = echo(source.namespace);
  if (signed.signedMessages.length === 0) {
    return refuse(
      r,
      'commitment_absent',
      'no signed messages, so the destination the payer signed cannot be read',
    );
  }
  if (source.detail !== '') return refuse(r, source.outcome, source.detail);
  if (!(PERMITTED_SCHEMES[source.namespace] ?? []).includes(signed.messageScheme)) {
    return refuse(
      r,
      'scheme_mismatch',
      `message_scheme ${quoteValue(signed.messageScheme)} cannot authorise a payment sourced on ${source.namespace}`,
    );
  }
  const deposit = signed.signedMessages[0]!;
  if (source.namespace === 'solana') {
    return finish(verifySolanaCommitment(r, signed.sourceAccount, deposit, expected, solana));
  }
  if (source.namespace === 'stellar') {
    return finish(
      verifyStellarCommitment(
        r,
        source.network,
        signed.sourceAccount,
        deposit,
        expected,
        options?.stellarEscrow,
      ),
    );
  }
  return finish(
    verifyPermitCommitment(r, source.namespace, source.network, deposit, expected, tronChainIds),
  );
}

/**
 * Compares already-extracted signed commitment values with the payment's own: exactly one destination
 * leg, a byte-exact destination, and depositRequestHash equal to keccak256(request_id), or to
 * `expected.depositRequestHashV2` when set. Use it when the signed values come from a deposit
 * builder rather than a message_prehash.
 *
 * @deprecated It compares values the caller extracted, and accepts depositRequestHash v2 only if the
 * caller derives it. Judge a deposit with `verifyRequestCommitment` on the signed request as received.
 * When the deposit's values come from your own builder, compare them with the `destination` and the
 * `depositRequestHash` or `depositRequestHashV2` that `requiredCommitmentOf` returns.
 */
export function compareCommitment(
  signedDestination: string,
  signedDepositRequestHash: string,
  expected: CommitmentExpectation,
): CommitmentResult {
  const r = emptyResult();
  if (
    typeof signedDestination !== 'string' ||
    typeof signedDepositRequestHash !== 'string' ||
    !isExpectation(expected)
  ) {
    return refuse(r, 'request_malformed', 'the commitment inputs do not have the expected types');
  }
  r.signedDestination = echo(signedDestination);
  r.signedDepositRequestHash = echo(signedDepositRequestHash);
  if (isJsonBlank(signedDestination)) return refuse(r, 'commitment_absent', DETAIL_NO_DESTINATION);
  if (isJsonBlank(signedDepositRequestHash))
    return refuse(r, 'commitment_absent', DETAIL_NO_REQUEST_HASH);
  const hash = parseHash32(signedDepositRequestHash);
  if (hash === undefined) return refuse(r, 'prehash_mismatch', DETAIL_BAD_REQUEST_HASH);
  return finish(compareExpected(r, signedDestination, hash, expected));
}

/**
 * The source network and namespace, and a refusal when the chain is not supported: `scheme_mismatch`,
 * or `verifier_misconfigured` when a supplied Tron chain id cannot be used. `outcome` is read only
 * when `detail` is not empty. Mirrors the Go `sourceNetwork`.
 */
function sourceNetwork(
  assetIdentifier: string,
  tronChainIds: CommitmentOptions['tronChainIds'],
): {
  network: string;
  namespace: string;
  outcome: CommitmentOutcome;
  detail: string;
} {
  let network: string;
  try {
    network = parseSourceAsset(assetIdentifier).network;
  } catch {
    return {
      network: '',
      namespace: '',
      outcome: 'scheme_mismatch',
      detail: `source asset_identifier ${quoteValue(String(assetIdentifier))} is not a valid CAIP-19 asset`,
    };
  }
  const namespace = namespaceOf(network);
  if (
    namespace !== 'eip155' &&
    namespace !== 'tron' &&
    namespace !== 'solana' &&
    namespace !== 'stellar'
  ) {
    return {
      network,
      namespace,
      outcome: 'scheme_mismatch',
      detail: `source chain namespace ${quoteValue(namespace)} has no destination commitment rule`,
    };
  }
  try {
    if (namespace === 'eip155' && network !== `eip155:${evmChainId(network)}`)
      throw new Error('non-canonical chain reference');
    if (namespace === 'tron') tronNumericChainId(network, tronChainIds);
    if (namespace === 'stellar') stellarNetworkString(network);
  } catch (e) {
    if (e instanceof TronChainIdError) {
      return { network, namespace, outcome: 'verifier_misconfigured', detail: e.detail };
    }
    return {
      network,
      namespace,
      outcome: 'scheme_mismatch',
      detail: `source chain ${quoteValue(network)} is not a supported ${namespace} network`,
    };
  }
  return { network, namespace, outcome: 'scheme_mismatch', detail: '' };
}

/**
 * Runs `verifyCommitment` on a payment request exactly as received. It refuses a request whose
 * member names are ambiguous in what it reads, then reads every field by exact name, so the values
 * it checks are the values any exact-key reader of the same text acts on. Pass the bytes as
 * received when you have them, so invalid UTF-8 is refused. Prefer it over `verifyCommitment`
 * whenever the raw request is available.
 *
 * `options.depositRequestHashV2Mode` opts it into depositRequestHash v2: the request is also read with
 * `readDepositRequest`, and a deposit may commit either v1 or that reading's v2. Without it, it is
 * exactly as before v2. In `retire` mode it admits only v2. Mirrors the Go
 * `VerifyRequestCommitment`.
 */
export function verifyRequestCommitment(
  request: string | Uint8Array,
  solana?: SolanaDomain,
  options?: CommitmentOptions,
): CommitmentResult {
  return checkRequestCommitment(request, solana, options, true);
}

/**
 * `verifyRequestCommitment`, reading `retire` only when `readsRetire`. `verifyPaymentRequestJSON`
 * passes false, so it refuses `retire` after reading the request, as the Go
 * `VerifyPaymentRequestJSON` does.
 *
 * @internal
 */
export function checkRequestCommitment(
  request: string | Uint8Array,
  solana: SolanaDomain | undefined,
  options: CommitmentOptions | undefined,
  readsRetire: boolean,
): CommitmentResult {
  const { signed, expected } = readRequest(request);
  const mode = options?.depositRequestHashV2Mode;
  const reading = readsRetire
    ? readRequestDepositRequestHashV2(request, mode, expected)
    : { ...readDepositRequestHashV2(request, mode, expected), v1Retired: false };
  return verdict(reading, () => checkCommitment(signed, reading.expected, solana, options));
}

/** The refusal of a deposit that commits v1 in `retire` mode. Mirrors the Go detail. */
const DETAIL_DEPOSIT_REQUEST_HASH_V1_RETIRED =
  'the deposit commits depositRequestHash v1, keccak256(request_id), which this verifier no longer accepts: sign depositRequestHash v2';

/**
 * How `verifyRequestCommitment` and `requiredCommitmentOf` read depositRequestHash v2 in a request:
 * the reading of `readDepositRequestHashV2`, and whether v1 is retired. Mirrors the Go
 * `requestReading`.
 */
interface RequestReading {
  detail: string;
  expected: CommitmentExpectation;
  v1Retired: boolean;
}

/**
 * `readDepositRequestHashV2` for the two entry points that read `retire`, which reads the request as
 * `enforce` does with v1 retired. Mirrors the Go `readRequestDepositRequestHashV2`.
 */
function readRequestDepositRequestHashV2(
  request: string | Uint8Array,
  mode: CommitmentOptions['depositRequestHashV2Mode'],
  expected: CommitmentExpectation,
): RequestReading {
  const v1Retired = mode === 'retire';
  return {
    ...readDepositRequestHashV2(request, v1Retired ? 'enforce' : mode, expected),
    v1Retired,
  };
}

/**
 * The check's result on the request as read: marked as audit's reading by `auditFallback`, and, once
 * v1 is retired, refused as `request_hash_mismatch` unless the deposit matched v2. Mirrors the Go
 * `requestReading.verdict`.
 */
function verdict(reading: RequestReading, check: () => CommitmentResult): CommitmentResult {
  const result = auditFallback(reading.detail, check);
  if (!reading.v1Retired || result.depositRequestHashVersion === 'v2') return result;
  const { depositRequestHashVersion: _matched, ...rest } = result;
  return refuse(rest, 'request_hash_mismatch', DETAIL_DEPOSIT_REQUEST_HASH_V1_RETIRED);
}

/**
 * Applies the depositRequestHash v2 mode to a request already read by exact name. When
 * `readDepositRequest` admits the request, its v2 goes into the returned expectation. When it refuses
 * it, enforce throws the refusal and audit returns its detail for `auditFallback`. Off reads nothing.
 * Any other mode, `retire` included, is refused as `verifier_misconfigured`, so
 * `verifyPaymentRequestJSON`, which reads its mode here as given, fails closed on `retire`. Mirrors
 * the Go `readDepositRequestHashV2`.
 */
function readDepositRequestHashV2(
  request: string | Uint8Array,
  mode: CommitmentOptions['depositRequestHashV2Mode'],
  expected: CommitmentExpectation,
): { detail: string; expected: CommitmentExpectation } {
  if (depositRequestHashV2Off(mode)) return { detail: '', expected };
  if (mode !== 'audit' && mode !== 'enforce') {
    return refuse(
      emptyResult(),
      'verifier_misconfigured',
      `the depositRequestHash v2 mode ${quoteValue(String(mode))} is not one of audit or enforce`,
    );
  }
  try {
    const read = readDepositRequest(request);
    return {
      detail: '',
      expected: { ...expected, depositRequestHashV2: read.depositRequestHashV2 },
    };
  } catch (e) {
    if (mode === 'enforce' || !(e instanceof CommitmentError)) throw e;
    return { detail: e.result.detail, expected };
  }
}

/**
 * Marks a check that read the request as before v2 because `readDepositRequest` refused it with
 * `detail`: `strictDetail` is set on the result and on the result its refusal carries, and an
 * admission matched v1, the only version that reading accepts. An empty detail changes nothing.
 * Mirrors the Go `auditFallback`.
 */
function auditFallback(detail: string, check: () => CommitmentResult): CommitmentResult {
  if (detail === '') return check();
  try {
    return { ...check(), strictDetail: detail, depositRequestHashVersion: 'v1' };
  } catch (e) {
    if (e instanceof CommitmentError)
      throw new CommitmentError({ ...e.result, strictDetail: detail });
    throw e;
  }
}

/** The commitment any deposit for a payment request must carry. The keys are the same in both languages. */
export interface RequiredCommitment {
  /** The CAIP-2 namespace of the source chain: `eip155`, `tron` or `solana`. */
  namespace: string;
  /** The destination the deposit must commit, as `buildEscrowDestination` composes it. */
  destination: string;
  /**
   * The depositRequestHash v1 the deposit must commit unless it commits `depositRequestHashV2`:
   * keccak256(request_id), 0x + 64 lowercase hex. In `retire` mode it is `depositRequestHashV2`
   * instead, so a consumer that admits either value admits only v2.
   */
  depositRequestHash: string;
  /**
   * The request's depositRequestHash v2, which the deposit may commit instead of `depositRequestHash`,
   * once opted in with `depositRequestHashV2Mode`. Absent otherwise.
   */
  depositRequestHashV2?: string;
  /**
   * Why `readDepositRequest` refused the request, with `depositRequestHashV2Mode: 'audit'`. The commitment
   * is then the one before v2. Absent in every other mode.
   */
  strictDetail?: string;
}

/**
 * Returns the commitment any deposit for this payment request must carry: its source namespace, the
 * destination and the depositRequestHash. Use it where you quote or bid, before the deposit exists,
 * whether or not the request is signed yet. It never judges a deposit: once the deposit is signed into
 * the request, judge it with `verifyRequestCommitment` on the request as received.
 *
 * `options.depositRequestHashV2Mode` opts it into depositRequestHash v2 as it does
 * `verifyRequestCommitment`: the request is also read with `readDepositRequest`, and the commitment
 * carries both candidates, `depositRequestHash` (v1) and `depositRequestHashV2`; the deposit may
 * commit either. Enforce refuses a request `readDepositRequest` refuses; audit returns the v1
 * commitment with the refusal in `strictDetail`. Without it, it is exactly as before v2.
 * `retire` refuses what `enforce` refuses and requires v2, as it does in `verifyRequestCommitment`:
 * `depositRequestHash` is the v2 too.
 *
 * It reads the request exactly as `verifyRequestCommitment` does, so the same text is refused with
 * the same outcome and detail. If `signed_messages[0]` carries a `message_prehash`, even a blank one,
 * it then runs the check `verifyRequestCommitment` runs, with `solana` as the Solana escrow domain
 * and `options` as given, and refuses exactly as it does; on success it returns the commitment that
 * check compared. On EVM and Tron that check binds the prehash to `signed_messages[0].message` but
 * verifies no signature (Permit2 does, on chain); on Solana it verifies the ed25519 signature.
 * Otherwise no signed commitment can be read (`sender_auth` or `signed_messages` is absent, or
 * `signed_messages[0]` has no `message_prehash`, absent or null), and it applies only the payment's
 * side of the rules: a supported source chain (reading `options.tronChainIds` for a Tron source),
 * exactly one destination that can be composed, and a well-formed, non-empty request_id. That path
 * reads no Solana domain, does not require `sender_auth`, never compares
 * `message_scheme` and verifies no signature, so its refusals never carry a scheme. It is not
 * verification: it refuses only a request no deposit could satisfy, and a signed request whose
 * `message_prehash` or `sender_auth` was removed takes it with whatever payee it names.
 *
 * Throws `CommitmentError` on refusal; `commitmentResultOf` reads the outcome, the detail and the
 * values known before the refusal. Mirrors the Go `RequiredCommitmentOf`.
 */
export function requiredCommitmentOf(
  request: string | Uint8Array,
  solana?: SolanaDomain,
  options?: CommitmentOptions,
): RequiredCommitment {
  const read = readRequest(request);
  const { signed } = read;
  const reading = readRequestDepositRequestHashV2(
    request,
    options?.depositRequestHashV2Mode,
    read.expected,
  );
  const { expected } = reading;
  const v2 = expected.depositRequestHashV2;
  const withV2Fields = (commitment: RequiredCommitment): RequiredCommitment => ({
    ...commitment,
    ...(v2 !== undefined && {
      depositRequestHashV2: v2,
      ...(reading.v1Retired && { depositRequestHash: v2 }),
    }),
    ...(reading.detail !== '' && { strictDetail: reading.detail }),
  });
  if (signed.signedMessages[0]?.message_prehash !== undefined) {
    const v = verdict(reading, () => checkCommitment(signed, expected, solana, options));
    return withV2Fields({
      namespace: v.namespace,
      destination: v.expectedDestination,
      depositRequestHash: v.expectedDepositRequestHash,
    });
  }
  const r = emptyResult();
  if (reading.detail !== '') r.strictDetail = reading.detail;
  const source = sourceNetwork(signed.sourceAssetIdentifier, options?.tronChainIds);
  r.namespace = echo(source.namespace);
  if (source.detail !== '') return refuse(r, source.outcome, source.detail);
  const destination = requestDestination(expected.destinations);
  if (typeof destination !== 'string') return refuse(r, destination.outcome, destination.detail);
  r.expectedDestination = destination;
  const hash = requestDepositRequestHash(expected.requestId);
  if (typeof hash !== 'string') return refuse(r, hash.outcome, hash.detail);
  return withV2Fields({ namespace: source.namespace, destination, depositRequestHash: hash });
}

/** The root members `readPaymentRequest` reads. Mirrors the Go `requestReadMembers`. */
const REQUEST_READ_MEMBERS = ['source', 'destination', 'request_id', 'sender_auth'] as const;

/**
 * Refuses an ambiguous or unreadable request and returns the commitment inputs read by exact name.
 * Every root member name is checked, but only the values of the root members it reads are scanned,
 * so a twin inside a member carried for others, such as a credential, does not refuse the request.
 * Mirrors the Go `readRequest`.
 */
function readRequest(request: string | Uint8Array): {
  signed: SignedDeposit;
  expected: CommitmentExpectation;
} {
  const r = emptyResult();
  let text: string;
  let path: string | undefined;
  try {
    if (typeof request === 'string') text = request;
    else if (request instanceof Uint8Array) text = decodeUtf8(request);
    else throw new Error();
    path = firstAmbiguousMemberIn(text, REQUEST_READ_MEMBERS);
  } catch {
    return refuse(
      r,
      'request_malformed',
      'the payment request is not a single valid JSON document',
    );
  }
  if (path !== undefined) {
    return refuse(
      r,
      'request_malformed',
      `the payment request carries two members that differ only in letter case, at ${echo(path)}`,
    );
  }
  // Lone surrogates become U+FFFD, as they would reach a Go reader, so both languages check the same text.
  const root: unknown = JSON.parse(wellFormed(text));
  if (!isObject(root))
    return refuse(
      r,
      'request_malformed',
      'the payment request is not readable: the document is not an object',
    );
  const read = readPaymentRequest(root);
  if (typeof read === 'string')
    return refuse(r, 'request_malformed', `the payment request is not readable: ${read}`);
  return read;
}

type JsonObject = Record<string, unknown>;

// Strings are read as Go decodes them: a lone surrogate escape becomes U+FFFD.
const own = (object: JsonObject, name: string): unknown => {
  const value = Object.hasOwn(object, name) ? object[name] : undefined;
  return typeof value === 'string' ? wellFormed(value) : value;
};

/**
 * Extracts the commitment inputs by exact member name; a string names the first member of the wrong
 * type. A root member read here must be in `REQUEST_READ_MEMBERS`.
 */
function readPaymentRequest(
  doc: JsonObject,
): { signed: SignedDeposit; expected: CommitmentExpectation } | string {
  const source = own(doc, 'source');
  if (!isObject(source)) return 'source is not an object';
  const sourceAssetIdentifier = own(source, 'asset_identifier');
  if (typeof sourceAssetIdentifier !== 'string') return 'source.asset_identifier is not a string';
  const sourceAccount = own(source, 'account');
  if (typeof sourceAccount !== 'string') return 'source.account is not a string';

  const legs = own(doc, 'destination');
  if (!Array.isArray(legs)) return 'destination is not an array';
  const destinations: DestinationLeg[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg: unknown = legs[i];
    const name = `destination[${i}]`;
    if (!isObject(leg)) return `${name} is not an object`;
    const asset = own(leg, 'asset_identifier');
    const account = own(leg, 'account');
    if (typeof asset !== 'string' || typeof account !== 'string')
      return `${name} asset_identifier and account must be strings`;
    destinations.push({ asset_identifier: asset, account });
  }
  const requestId = own(doc, 'request_id');
  if (typeof requestId !== 'string') return 'request_id is not a string';

  const signed: SignedDeposit = {
    sourceAssetIdentifier,
    sourceAccount,
    messageScheme: '',
    signedMessages: [],
  };
  const expected: CommitmentExpectation = { destinations, requestId };
  const auth = own(doc, 'sender_auth');
  if (auth === undefined || auth === null) return { signed, expected };
  if (!isObject(auth)) return 'sender_auth is not an object';
  const scheme = own(auth, 'message_scheme');
  if (scheme !== undefined && scheme !== null) {
    if (typeof scheme !== 'string') return 'sender_auth.message_scheme is not a string';
    signed.messageScheme = scheme;
  }
  const messages = own(auth, 'signed_messages');
  if (messages === undefined || messages === null) return { signed, expected };
  if (!Array.isArray(messages)) return 'sender_auth.signed_messages is not an array';
  const inputs: SignedMessageInput[] = [];
  for (let i = 0; i < messages.length; i++) {
    const name = `sender_auth.signed_messages[${i}]`;
    const m: unknown = messages[i];
    if (!isObject(m)) return `${name} is not an object`;
    const message = optionalString(m, 'message');
    if (message === undefined) return `${name}.message is not a string`;
    const signature = optionalString(m, 'signature');
    if (signature === undefined) return `${name}.signature is not a string`;
    const input: SignedMessageInput = { message, signature };
    const prehash = own(m, 'message_prehash');
    if (prehash !== undefined && prehash !== null) {
      if (typeof prehash !== 'string') return `${name}.message_prehash is not a string`;
      input.message_prehash = prehash;
    }
    const payload = own(m, 'payload');
    if (payload !== undefined && payload !== null) {
      if (!isObject(payload)) return `${name}.payload is not an object`;
      input.payload = payload;
    }
    inputs.push(input);
  }
  return { signed: { ...signed, signedMessages: inputs }, expected };
}

/** An optional string member: absent or null reads as ""; undefined means present with another type. */
function optionalString(m: JsonObject, name: string): string | undefined {
  const v = own(m, name);
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : undefined;
}

function isSignedDeposit(value: unknown): value is SignedDeposit {
  const v = value as SignedDeposit | undefined;
  return (
    isObject(v) &&
    typeof v.sourceAssetIdentifier === 'string' &&
    typeof v.sourceAccount === 'string' &&
    typeof v.messageScheme === 'string' &&
    Array.isArray(v.signedMessages) &&
    v.signedMessages.every(isObject)
  );
}

function isExpectation(value: unknown): value is CommitmentExpectation {
  const v = value as CommitmentExpectation | undefined;
  return (
    isObject(v) &&
    Array.isArray(v.destinations) &&
    v.destinations.every(
      (leg) =>
        isObject(leg) &&
        typeof leg.asset_identifier === 'string' &&
        typeof leg.account === 'string',
    ) &&
    typeof v.requestId === 'string'
  );
}
