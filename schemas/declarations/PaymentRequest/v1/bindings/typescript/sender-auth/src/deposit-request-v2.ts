import { keccak256, toUtf8Bytes } from 'ethers';

import { isObject } from './commitment-permit.js';
import { echo, emptyResult, refuse, requestDestination } from './commitment-rules.js';
import type { DestinationLeg } from './commitment-rules.js';
import { deriveDepositRequestHash } from './destination.js';
import { decodeUtf8, firstAmbiguousMemberIn, wellFormed } from './json-members.js';

/**
 * depositRequestHash v2 commits the payment terms, not just `request_id`, so a copy of the request
 * that any party edits no longer matches what the payer signed. It is keccak256 over a flat
 * preimage of length-prefixed fields that leaves out `sender_auth`. The preimage is pinned by
 * `PaymentRequest/v1/conformance/deposit-request-hash-v2-vectors.json`, which every implementation
 * must reproduce byte-for-byte. Mirrors the Go `deposit_request_v2.go`.
 */

/**
 * Opens every v2 preimage. 0xFF never occurs in UTF-8, so no `request_id` hashed by v1 can equal a
 * v2 preimage.
 */
const DEPOSIT_REQUEST_V2_DOMAIN = 0xff;

/** Follows the domain byte and names the derivation. */
const DEPOSIT_REQUEST_V2_TAG = 'atum:deposit-request:v2';

/**
 * The presence byte of an optional member: `V2_ABSENT` is followed by nothing, `V2_PRESENT` by the
 * value as a length-prefixed field.
 */
const V2_ABSENT = 0x00;
const V2_PRESENT = 0x01;

/** Who performs one leg of a payment. Its value is the leg's byte in the v2 preimage. */
export const EXECUTOR_SETTLER = 0x00;
export const EXECUTOR_ORIGINATOR = 0x01;
export type ExecutorRole = typeof EXECUTOR_SETTLER | typeof EXECUTOR_ORIGINATOR;

/**
 * The executor expanded to its three legs. An absent executor, and `"settler"`, are settler for
 * every leg. Mirrors the Go `ExecutorLegs`.
 */
export interface ExecutorLegs {
  deposit: ExecutorRole;
  reserve: ExecutorRole;
  fulfill: ExecutorRole;
}

/** The payment terms v2 commits, as the reader acts on them. Mirrors the Go `DepositTerms`. */
export interface DepositTerms {
  requestId: string;
  sourceAssetIdentifier: string;
  sourceAccount: string;
  /** The one destination leg, composed by `buildEscrowDestination`. */
  destination: string;
  /** The decimal amount with leading zeros stripped (`"0"` for zero). */
  fulfillmentAmount: string;
  /** Undefined when the request omits it or sets it to null. */
  maxSourceAmount: string | undefined;
  /** Unix seconds, floored. */
  quoteDeadline: bigint;
  /** Unix seconds, floored. */
  fulfillmentDeadline: bigint;
  executor: ExecutorLegs;
  /** Undefined when the request omits it or sets it to null; `""` is present. */
  fulfillmentProxy: string | undefined;
  escrowContractAddress: string;
  /** Undefined when the request omits it or sets it to null; `""` is present. */
  quoteSelector: string | undefined;
  fulfillmentVerifierAccount: string;
  fulfillmentVerifierEndpoint: string;
}

/**
 * A payment request as `readDepositRequest` reads it: the terms it acts on, the v2 hash of exactly
 * those terms, and the v1 hash of its `request_id`, each as 0x + 64 lowercase hex. A deposit
 * commits one of the two. Mirrors the Go `DepositRequest`.
 */
export interface DepositRequest {
  terms: DepositTerms;
  depositRequestHashV1: string;
  depositRequestHashV2: string;
  /**
   * The originator-executed deposit's `deposit_nonce` exactly as sent, undefined when absent.
   * Neither hash commits it: the deposit id does (`deriveDirectDeposit`).
   */
  depositNonce?: string;
}

/**
 * Reads a payment request exactly as received and returns the terms v2 commits together with their
 * v2 hash and the v1 hash of the request. Act on the returned terms, never on another decode of
 * the same bytes, so the decoder that hashes is the decoder that acts. A refusal throws
 * `CommitmentError` with outcome `request_malformed`. Mirrors the Go `ReadDepositRequest`.
 *
 * Repeated member names, including names that differ only in letter case, are refused everywhere
 * except inside `sender_auth`, `presentation` and `verifiableCredential` (see `REQUEST_SHAPE`).
 * Every root member name is still checked, so a twin of `sender_auth` or `verifiableCredential`
 * itself is refused. Inside those three v2 hashes nothing and this reader acts on nothing, and they
 * are scanned where they are read: `sender_auth` by the commitment check, a presentation and its
 * credentials by `verifyVP` and `verifyVCProof`. The other opaque members, `proof`,
 * `originator_auth` and `settler_auth_required`, are scanned here, because their readers do not
 * scan them. In audit the commitment check only reports this reader's refusals, so ingress keeps
 * its whole-body twin scan until it enforces.
 */
export function readDepositRequest(request: string | Uint8Array): DepositRequest {
  let text: string;
  let path: string | undefined;
  try {
    text = typeof request === 'string' ? request : decodeUtf8(request);
    path = firstAmbiguousMemberIn(text, STRICT_READ_MEMBERS);
  } catch {
    return refuseDepositRequest('the payment request is not a single valid JSON document');
  }
  if (path !== undefined)
    return refuseDepositRequest(
      `the payment request carries two members that differ only in letter case, at ${echo(path)}`,
    );
  // Lone surrogates become U+FFFD, as they would reach a Go reader, so both languages read the same text.
  const root: unknown = JSON.parse(wellFormed(text));
  if (!isObject(root))
    return refuseDepositRequest(
      'the payment request is not readable: the document is not an object',
    );
  const unknown = firstUnknownMember(root, REQUEST_SHAPE, '$');
  if (unknown !== undefined)
    return refuseDepositRequest(
      `the payment request is not readable: ${echo(unknown)} is not a PaymentRequest member`,
    );
  const terms = readDepositTerms(root);
  if (typeof terms === 'string')
    return refuseDepositRequest(`the payment request is not readable: ${terms}`);
  // The nonce names a deposit the payer funded itself. On any other request it is not a member, as
  // before the schema had it, so this reader and the rules agree without the rules running.
  let depositNonce: string | undefined;
  if (Object.hasOwn(root, 'deposit_nonce')) {
    if (terms.executor.deposit !== EXECUTOR_ORIGINATOR)
      return refuseDepositRequest(
        'the payment request is not readable: $.deposit_nonce is only a member of an originator-executed deposit',
      );
    const nonce = own(root, 'deposit_nonce');
    if (typeof nonce !== 'string')
      return refuseDepositRequest(
        'the payment request is not readable: $.deposit_nonce is not a string',
      );
    depositNonce = nonce;
  }
  const preimage = depositRequestPreimageV2(terms);
  if (preimage === undefined)
    return refuseDepositRequest(
      'the payment request is not readable: a member is longer than a uint32 length prefix can count',
    );
  return {
    terms,
    depositRequestHashV1: deriveDepositRequestHash(terms.requestId),
    depositRequestHashV2: keccak256(preimage),
    ...(depositNonce === undefined ? {} : { depositNonce }),
  };
}

/**
 * Returns the v2 depositRequestHash of a payment request exactly as received: `readDepositRequest`'s
 * hash. Mirrors the Go `DepositRequestHashV2`.
 */
export function depositRequestHashV2(request: string | Uint8Array): string {
  return readDepositRequest(request).depositRequestHashV2;
}

/** Refuses as `request_malformed` with `detail`. Mirrors the Go `refuseDepositRequest`. */
export function refuseDepositRequest(detail: string): never {
  return refuse(emptyResult(), 'request_malformed', detail);
}

type JsonObject = Record<string, unknown>;

// Strings are read as Go decodes them: a lone surrogate escape becomes U+FFFD.
const own = (object: JsonObject, name: string): unknown => {
  const value = Object.hasOwn(object, name) ? object[name] : undefined;
  return typeof value === 'string' ? wellFormed(value) : value;
};

/**
 * What the PaymentRequest schema allows at one position of a request: the members of an object and
 * their shapes, and the shape of an array's elements. A position with neither holds a scalar. An
 * opaque position is never walked for unknown members: v2 does not hash it, and no reader acts on it
 * from a copy authenticated by v2. It is still scanned for repeated names unless `scannedWhereRead`:
 * its readers scan it themselves. Mirrors the Go `memberShape`.
 */
interface MemberShape {
  members?: Readonly<Record<string, MemberShape>>;
  elems?: MemberShape;
  opaque?: true;
  scannedWhereRead?: true;
}

const SCALAR: MemberShape = {};
const OPAQUE: MemberShape = { opaque: true };
/**
 * An opaque member whose readers scan it for repeated names: `sender_auth` by the commitment check,
 * a presentation and its credentials by `verifyVP` and `verifyVCProof`. A repeated name there is
 * theirs to refuse, so a credential a reader accepts does not make the request unreadable. Mirrors
 * the Go `scannedWhereReadShape`.
 */
const SCANNED_WHERE_READ: MemberShape = { opaque: true, scannedWhereRead: true };
const OWNED_ASSET: MemberShape = { members: { asset_identifier: SCALAR, account: SCALAR } };

/**
 * The PaymentRequest schema outside the opaque subtrees, checked against schema.json by the
 * request-shape test. Mirrors the Go `requestShape`.
 */
export const REQUEST_SHAPE: MemberShape = {
  members: {
    '@context': { elems: SCALAR },
    version: SCALAR,
    request_id: SCALAR,
    source: OWNED_ASSET,
    destination: { elems: OWNED_ASSET },
    fulfillment_amount: SCALAR,
    max_source_amount: SCALAR,
    quote_deadline: SCALAR,
    fulfillment_deadline: SCALAR,
    executor: { members: { deposit: SCALAR, reserve: SCALAR, fulfill: SCALAR } },
    // Read, never hashed: the deposit id binds the nonce.
    deposit_nonce: SCALAR,
    fulfillment_proxy: SCALAR,
    escrow_contract_address: SCALAR,
    quote_selector: SCALAR,
    fulfillment_verifier: { members: { account: SCALAR, endpoint: SCALAR } },
    settler_requirements: {
      members: { whitelist: { elems: SCALAR }, blacklist: { elems: SCALAR } },
    },
    // Opaque, but scanned here: their readers do not scan them.
    settler_auth_required: OPAQUE,
    originator_auth: OPAQUE,
    proof: OPAQUE,
    sender_auth: SCANNED_WHERE_READ,
    presentation: SCANNED_WHERE_READ,
    verifiableCredential: SCANNED_WHERE_READ,
  },
};

/**
 * The root members whose values `readDepositRequest` scans for repeated names: every member of
 * `REQUEST_SHAPE` except those scanned where they are read. Mirrors the Go `strictReadMembers`.
 */
const STRICT_READ_MEMBERS: readonly string[] = Object.entries(REQUEST_SHAPE.members ?? {})
  .filter(([, shape]) => shape.scannedWhereRead !== true)
  .map(([name]) => name);

/**
 * Compares strings by code point, the order Go sorts its strings in. The default sort compares
 * UTF-16 code units, which orders characters above U+FFFF differently.
 */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Returns the path of the first member under `value` that its position does not allow. Members are
 * visited in code point order, not document order, so Go and TypeScript name the same member.
 * Mirrors the Go `firstUnknownMember`, visiting in the same order, but walks an explicit stack: a
 * request may nest `MAX_JSON_DEPTH` deep, which overflows the call stack here but not in Go.
 */
function firstUnknownMember(value: unknown, shape: MemberShape, path: string): string | undefined {
  interface Visit {
    value: unknown;
    /** Undefined when the position does not allow this member. */
    shape: MemberShape | undefined;
    segment: string;
    parent: Visit | undefined;
  }
  // The path is assembled only for the member refused, so memory stays linear in the depth.
  const pathOf = (visit: Visit): string => {
    const segments: string[] = [];
    for (let v: Visit | undefined = visit; v !== undefined; v = v.parent) segments.push(v.segment);
    return segments.reverse().join('');
  };
  const stack: Visit[] = [{ value, shape, segment: path, parent: undefined }];
  for (let visit = stack.pop(); visit !== undefined; visit = stack.pop()) {
    if (visit.shape === undefined) return pathOf(visit);
    if (visit.shape.opaque) continue;
    // Pushed in reverse, so they pop in order, each walked fully before the next is checked.
    const children: Visit[] = [];
    if (Array.isArray(visit.value)) {
      const elems = visit.shape.elems ?? SCALAR;
      for (const [i, elem] of visit.value.entries())
        children.push({ value: elem, shape: elems, segment: `[${i}]`, parent: visit });
    } else if (isObject(visit.value)) {
      const object = visit.value;
      const members = visit.shape.members;
      // Names are sorted, printed and looked up as Go decodes them, a lone surrogate as U+FFFD; the
      // raw name still reads the value. firstAmbiguousMemberIn has already kept the decoded names
      // unique everywhere this walks.
      const names = Object.keys(object).map((raw) => ({ raw, name: wellFormed(raw) }));
      for (const { raw, name } of names.sort((a, b) => byCodePoint(a.name, b.name)))
        children.push({
          value: object[raw],
          shape: members !== undefined && Object.hasOwn(members, name) ? members[name] : undefined,
          segment: `.${name}`,
          parent: visit,
        });
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return undefined;
}

/**
 * The schema's version pattern. v2 does not hash version, but a request of another major is not a
 * PaymentRequest v1 and is refused. Mirrors the Go `requestVersionPattern`.
 */
const REQUEST_VERSION_PATTERN = /^1\.[0-9]+$/;

/**
 * Bounds `request_id` to ASCII that can never contain the 0xFF domain byte, so no v1 hash of a
 * `request_id` can equal a v2 hash. `readDepositRequest` refuses any other request_id, so a
 * producer can check an id against it before building a request. Mirrors the Go
 * `requestIDPattern`.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The `@context` lists a PaymentRequest v1 signer injects, one per signature suite. Mirrors the Go
 * `requestContextLists`.
 */
const REQUEST_CONTEXT_LISTS: readonly (readonly string[])[] = [
  [
    'https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld',
    'https://w3id.org/security/suites/secp256k1recovery-2020/v2',
  ],
  [
    'https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld',
    'https://w3id.org/security/suites/ed25519-2020/v1',
  ],
];

/**
 * Whether a top-level `@context` value is absent (or null), or exactly one of the context lists, in
 * order. Mirrors the Go `isRequestContext`.
 */
function isRequestContext(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!Array.isArray(value)) return false;
  return REQUEST_CONTEXT_LISTS.some(
    (want) => value.length === want.length && want.every((url, i) => value[i] === url),
  );
}

/** Reads the terms by exact member name; a string names the first member that cannot be read. */
function readDepositTerms(doc: JsonObject): DepositTerms | string {
  if (!isRequestContext(own(doc, '@context')))
    return '@context is neither absent nor one of the PaymentRequest v1 context lists';
  const version = own(doc, 'version');
  if (typeof version !== 'string') return 'version is not a string';
  if (!REQUEST_VERSION_PATTERN.test(version))
    return 'version is not a PaymentRequest v1 version (1.<minor>)';
  const requestId = own(doc, 'request_id');
  if (typeof requestId !== 'string') return 'request_id is not a string';
  if (!REQUEST_ID_PATTERN.test(requestId))
    return 'request_id is not 1 to 128 of A-Z, a-z, 0-9, ".", "_" and "-"';
  const source = own(doc, 'source');
  if (!isObject(source)) return 'source is not an object';
  const sourceAssetIdentifier = own(source, 'asset_identifier');
  if (typeof sourceAssetIdentifier !== 'string') return 'source.asset_identifier is not a string';
  const sourceAccount = own(source, 'account');
  if (typeof sourceAccount !== 'string') return 'source.account is not a string';
  const legs = own(doc, 'destination');
  if (!Array.isArray(legs)) return 'destination is not an array';
  const destinations: DestinationLeg[] = [];
  for (const [i, leg] of legs.entries()) {
    const name = `destination[${i}]`;
    if (!isObject(leg)) return `${name} is not an object`;
    const asset = own(leg, 'asset_identifier');
    const account = own(leg, 'account');
    if (typeof asset !== 'string' || typeof account !== 'string')
      return `${name} asset_identifier and account must be strings`;
    destinations.push({ asset_identifier: asset, account });
  }
  const destination = requestDestination(destinations);
  if (typeof destination !== 'string') return destination.detail;
  const fulfillmentAmount = own(doc, 'fulfillment_amount');
  if (typeof fulfillmentAmount !== 'string') return 'fulfillment_amount is not a string';
  const amount = readAmount(fulfillmentAmount, 'fulfillment_amount');
  if (amount instanceof Problem) return amount.detail;
  const maxSourceText = readOptionalString(doc, 'max_source_amount');
  if (maxSourceText instanceof Problem) return maxSourceText.detail;
  const maxSourceAmount =
    maxSourceText === undefined ? undefined : readAmount(maxSourceText, 'max_source_amount');
  if (maxSourceAmount instanceof Problem) return maxSourceAmount.detail;
  const quoteDeadline = readDeadline(doc, 'quote_deadline');
  if (typeof quoteDeadline === 'string') return quoteDeadline;
  const fulfillmentDeadline = readDeadline(doc, 'fulfillment_deadline');
  if (typeof fulfillmentDeadline === 'string') return fulfillmentDeadline;
  const executor = readExecutor(doc);
  if (executor instanceof Problem) return executor.detail;
  const fulfillmentProxy = readOptionalString(doc, 'fulfillment_proxy');
  if (fulfillmentProxy instanceof Problem) return fulfillmentProxy.detail;
  const escrowContractAddress = own(doc, 'escrow_contract_address');
  if (typeof escrowContractAddress !== 'string') return 'escrow_contract_address is not a string';
  const quoteSelector = readOptionalString(doc, 'quote_selector');
  if (quoteSelector instanceof Problem) return quoteSelector.detail;
  const verifier = own(doc, 'fulfillment_verifier');
  if (!isObject(verifier)) return 'fulfillment_verifier is not an object';
  const fulfillmentVerifierAccount = own(verifier, 'account');
  if (typeof fulfillmentVerifierAccount !== 'string')
    return 'fulfillment_verifier.account is not a string';
  const fulfillmentVerifierEndpoint = own(verifier, 'endpoint');
  if (typeof fulfillmentVerifierEndpoint !== 'string')
    return 'fulfillment_verifier.endpoint is not a string';
  return {
    requestId,
    sourceAssetIdentifier,
    sourceAccount,
    destination,
    fulfillmentAmount: amount,
    maxSourceAmount,
    quoteDeadline,
    fulfillmentDeadline,
    executor,
    fulfillmentProxy,
    escrowContractAddress,
    quoteSelector,
    fulfillmentVerifierAccount,
    fulfillmentVerifierEndpoint,
  };
}

/** 2^256-1, the largest amount v2 commits. Per-chain limits stay in the chain adapters. */
const MAX_AMOUNT = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

/**
 * Reads a decimal amount and strips its leading zeros, so `"0010"` and `"10"` commit the same
 * value. Zero is `"0"`. The bound is compared on the stripped digits, so no big-integer parse
 * decides it. Mirrors the Go `readAmount`.
 */
export function readAmount(text: string, name: string): string | Problem {
  const refused = new Problem(`${name} is not a decimal amount up to 2^256-1`);
  if (!/^[0-9]+$/.test(text)) return refused;
  const amount = text.replace(/^0+/, '') || '0';
  if (
    amount.length > MAX_AMOUNT.length ||
    (amount.length === MAX_AMOUNT.length && amount > MAX_AMOUNT)
  )
    return refused;
  return amount;
}

/** Why a member cannot be read. A class, so it cannot be mistaken for a member's string value. */
class Problem {
  constructor(readonly detail: string) {}
}

/** Reads an optional string member: undefined when it is absent or null. */
function readOptionalString(doc: JsonObject, name: string): string | undefined | Problem {
  const value = own(doc, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return new Problem(`${name} is not a string`);
  return value;
}

const EXECUTOR_ROLES: Readonly<Record<string, ExecutorRole>> = {
  settler: EXECUTOR_SETTLER,
  originator: EXECUTOR_ORIGINATOR,
};

/**
 * Expands the executor to its three legs: a role names every leg, and the object form must name
 * each leg. Mirrors the Go `readExecutor`.
 */
function readExecutor(doc: JsonObject): ExecutorLegs | Problem {
  const value = own(doc, 'executor');
  if (value === undefined || value === null)
    return { deposit: EXECUTOR_SETTLER, reserve: EXECUTOR_SETTLER, fulfill: EXECUTOR_SETTLER };
  if (typeof value === 'string') {
    const role = readExecutorRole(value, 'executor');
    if (role instanceof Problem) return role;
    return { deposit: role, reserve: role, fulfill: role };
  }
  if (!isObject(value)) return new Problem('executor is neither a string nor an object');
  const legs: ExecutorRole[] = [];
  for (const leg of ['deposit', 'reserve', 'fulfill'] as const) {
    const name = `executor.${leg}`;
    const text = own(value, leg);
    if (typeof text !== 'string') return new Problem(`${name} is not a string`);
    const role = readExecutorRole(text, name);
    if (role instanceof Problem) return role;
    legs.push(role);
  }
  return { deposit: legs[0]!, reserve: legs[1]!, fulfill: legs[2]! };
}

function readExecutorRole(text: string, name: string): ExecutorRole | Problem {
  if (!Object.hasOwn(EXECUTOR_ROLES, text))
    return new Problem(`${name} is neither settler nor originator`);
  return EXECUTOR_ROLES[text]!;
}

/**
 * The one RFC 3339 form v2 accepts: uppercase T and Z, at most nine fractional digits, and a
 * numeric offset. It is checked, and the instant computed, by this code alone, never by a date
 * parser, so Go and TypeScript cannot read one deadline as two instants. Mirrors the Go
 * `deadlinePattern`.
 */
const DEADLINE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Reads an RFC 3339 instant as Unix seconds, floored. Fractional seconds are dropped: the offset is
 * whole minutes, so the floor of the instant is its whole-second part. Mirrors the Go
 * `readDeadline`.
 */
function readDeadline(doc: JsonObject, name: string): bigint | string {
  const text = own(doc, name);
  if (typeof text !== 'string') return `${name} is not a string`;
  const m = DEADLINE_PATTERN.exec(text);
  if (m === null || (m[7] === '-' && m[8] === '00' && m[9] === '00'))
    return `${name} is not an RFC 3339 date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM)`;
  // The pattern admits only digits, or undefined for Z.
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const offsetHour = Number(m[8] ?? 0);
  const offsetMinute = Number(m[9] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return `${name} is not a valid date and time`;
  let seconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  if (m[7] === '+') seconds -= offsetHour * 3600 + offsetMinute * 60;
  if (m[7] === '-') seconds += offsetHour * 3600 + offsetMinute * 60;
  if (seconds < 0) return `${name} is before 1970-01-01T00:00:00Z`;
  // The spec (thread 1) also refuses a deadline above 2^53-1 seconds. No check is needed: the latest
  // instant this grammar admits, 9999-12-31T23:59:59-23:59, is 253402387139 seconds.
  return BigInt(seconds);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * The days from 1970-01-01 to a proleptic Gregorian date, for years 0 to 9999 (Howard Hinnant's
 * days_from_civil). Mirrors the Go `daysFromCivil`.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month <= 2 ? month + 9 : month - 3) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * The keccak256 input of v2: the domain byte, then every field in the specified order, each
 * variable-length field prefixed with its byte length as a big-endian uint32. Undefined when a
 * field is too long for its prefix to count. Mirrors the Go `depositRequestPreimageV2`.
 */
export function depositRequestPreimageV2(t: DepositTerms): Uint8Array | undefined {
  const parts = [
    Uint8Array.of(DEPOSIT_REQUEST_V2_DOMAIN),
    field(DEPOSIT_REQUEST_V2_TAG),
    field(t.requestId),
    field(t.sourceAssetIdentifier),
    field(t.sourceAccount),
    field(t.destination),
    field(t.fulfillmentAmount),
    optional(t.maxSourceAmount),
    uint64(t.quoteDeadline),
    uint64(t.fulfillmentDeadline),
    Uint8Array.of(t.executor.deposit, t.executor.reserve, t.executor.fulfill),
    optional(t.fulfillmentProxy),
    field(t.escrowContractAddress),
    optional(t.quoteSelector),
    field(t.fulfillmentVerifierAccount),
    field(t.fulfillmentVerifierEndpoint),
  ];
  if (parts.some((p) => p === undefined)) return undefined;
  const out = new Uint8Array(parts.reduce((n, p) => n + p!.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p!, offset);
    offset += p!.length;
  }
  return out;
}

/**
 * A field's length prefix. A length a uint32 cannot count is refused rather than wrapped: a
 * wrapped prefix would let a longer field encode like a shorter one. Mirrors the Go
 * `v2FieldLength`.
 */
export function v2FieldLength(n: number): number | undefined {
  return n > 0xffffffff ? undefined : n;
}

function field(value: string): Uint8Array | undefined {
  const bytes = toUtf8Bytes(value);
  const length = v2FieldLength(bytes.length);
  if (length === undefined) return undefined;
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, length);
  out.set(bytes, 4);
  return out;
}

function optional(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) return Uint8Array.of(V2_ABSENT);
  const bytes = field(value);
  if (bytes === undefined) return undefined;
  const out = new Uint8Array(1 + bytes.length);
  out[0] = V2_PRESENT;
  out.set(bytes, 1);
  return out;
}

function uint64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}
