// The ambiguous-member scanner lives in the sender-auth package beside this binding; it is the
// one implementation both languages are pinned to, so the two readers cannot disagree about
// which documents are ambiguous. FulfillmentAuthorization's validator reaches for it the same way.
import { firstAmbiguousMemberIn } from './sender-auth/src/json-members.js';

import { depositsAsOriginator, fulfillsAsOriginator, supportsEip3009 } from './eip3009.js';

/** Base class for every PaymentRequest rule refusal, so a caller can catch them as one group. */
export class PaymentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRequestError';
  }
}

/**
 * A destination the payment cannot be delivered to under the executor it names. It carries the
 * asset identifier so a caller can log or echo the leg it refused, and it is its own class so
 * this refusal is distinguishable from any other validation failure (`instanceof`). The Go
 * binding raises the matching `UnsupportedDestinationAssetError`, with the same message.
 */
export class UnsupportedDestinationAssetError extends PaymentRequestError {
  /** The CAIP-19 identifier of the destination that was refused. */
  readonly assetIdentifier: string;
  /**
   * That destination's CAIP-2 chain ID, split out because consumers tag metrics and logs by
   * chain. Empty when the identifier could not be read.
   */
  readonly chain: string;

  constructor(assetIdentifier: string, chain = '') {
    super(
      `destination asset "${assetIdentifier}" does not support EIP-3009 transferWithAuthorization, which originator fulfill requires`,
    );
    this.name = 'UnsupportedDestinationAssetError';
    this.assetIdentifier = assetIdentifier;
    this.chain = chain;
  }
}

/** The rules a `DirectDepositRuleError` names. Mirrors the Go `DirectDepositRule` constants. */
export type DirectDepositRule =
  | 'executor'
  | 'sender_auth'
  | 'deposit_nonce'
  | 'quote_selector'
  | 'fulfillment_verifier'
  | 'max_source_amount'
  | 'request_id'
  | 'source'
  | 'destination';

/**
 * A request the originator-executed deposit rules refuse. `rule` is a bounded name, so a consumer
 * maps it to its API error and tags metrics with it; all but `source` and `destination` are the
 * names payment-gw's direct deposit admission reports. The Go binding raises the matching `DirectDepositRuleError`, with the same
 * message.
 */
export class DirectDepositRuleError extends PaymentRequestError {
  readonly rule: DirectDepositRule;
  readonly detail: string;

  constructor(rule: DirectDepositRule, detail: string) {
    super(`originator-executed deposit: ${rule}: ${detail}`);
    this.name = 'DirectDepositRuleError';
    this.rule = rule;
    this.detail = detail;
  }
}

/** The root members the originator-executed deposit rules read, beyond executor. */
const DIRECT_DEPOSIT_MEMBERS = [
  'deposit_nonce',
  'quote_selector',
  'fulfillment_verifier',
  'max_source_amount',
  'request_id',
  'source',
] as const;

/**
 * The root members the rules read, and so the ones the ambiguous-member scan inspects.
 * `sender_auth` is read only for its presence, and a twin of a root name is refused whatever the
 * member, so its value is left to the readers that act on it.
 */
const RULE_MEMBERS = ['executor', 'destination', ...DIRECT_DEPOSIT_MEMBERS] as const;

/**
 * Shared PaymentRequest checks over the bytes as received. This is the counterpart of the Go
 * binding's `ValidateRules`, and the entry point a consumer holding raw JSON should use.
 *
 * The scan comes before the parse, not after. Go's `encoding/json` folds member names and keeps
 * the last match, so `{"executor":"originator","Executor":"settler"}` decodes there as settler
 * while `JSON.parse` keeps both spellings and this binding reads originator. The same bytes would
 * mean different payments to the two readers, so such a document is refused outright rather than
 * left to whichever reader sees it first.
 *
 * Only the root member names and the values of the members these rules act on are inspected: a
 * twin inside a part of the document carried for someone else is not this reader's to refuse. The
 * `@context` exemption is kept, because a PaymentRequest carries JSON-LD whose contexts
 * legitimately define terms differing only in case.
 */
export function validatePaymentRequestJSON(documentJson: string): void {
  // The scanner parses as it goes and rejects a document that is not exactly one valid JSON
  // value, so an unreadable document is reported from here rather than from JSON.parse below.
  let path: string | undefined;
  try {
    path = firstAmbiguousMemberIn(documentJson, RULE_MEMBERS);
  } catch (err) {
    throw new PaymentRequestError(`payment request is not valid JSON: ${(err as Error).message}`);
  }
  if (path !== undefined) {
    throw new PaymentRequestError(
      `payment request has ambiguous member ${path}: two members of one object fold to the same name`,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(documentJson);
  } catch (err) {
    throw new PaymentRequestError(`payment request is not valid JSON: ${(err as Error).message}`);
  }
  validatePaymentRequest(document);
}

/**
 * Shared PaymentRequest checks over an already-parsed document. Schema shape is enforced by the
 * declaration schema; these rules are the ones every consumer applies on top, deciding whether a
 * request of the right shape can actually be settled as written.
 *
 * Two rules: the originator-fulfill destination check below, then the originator-executed deposit
 * rules (`validateDirectDeposit`). Both mirror the Go binding, rule for rule and message for
 * message.
 *
 * A caller that still holds the bytes should use `validatePaymentRequestJSON` instead: a parsed
 * document has already lost the member twins that make two readers disagree, so the scan above
 * cannot run here.
 */
export function validatePaymentRequest(document: unknown): void {
  // The destination rule runs first, so a request it refuses is reported the same way whatever else
  // is wrong with it.
  validateOriginatorFulfillDestinations(document);
  validateDirectDeposit(document);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_UINT = /^[0-9]+$/;
const DIRECT_DEPOSIT_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** A CAIP-19 ERC-20 on an EVM chain, the only source directDeposit pulls; group 1 is the token. */
const DIRECT_DEPOSIT_SOURCE_ASSET = /^eip155:[0-9]+\/erc20:(0x[0-9a-fA-F]{40})$/;
/**
 * Mirrors MAX_DESTINATION_BYTES in Escrow.sol: a longer composed destination reverts
 * DestinationTooLong. conformance/destination-vectors.json pins it.
 */
export const DIRECT_DEPOSIT_MAX_DESTINATION_BYTES = 256;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT256_DECIMAL = MAX_UINT256.toString();

/**
 * Whether `object` has an own member `name`. `Object.hasOwn` is ES2022, and the
 * payment-gateway-client compiles this file against an older library.
 */
function hasOwn(object: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, name);
}

/** The string value of the own member `name`, or `''` when it is absent or not a string. */
function stringMember(object: unknown, name: string): string {
  if (typeof object !== 'object' || object === null || !hasOwn(object, name)) return '';
  const value = (object as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/** Whether `address`, already matched as 0x and 40 hex digits, is all zeros. */
function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/.test(address);
}

/**
 * Whether `value` is a decimal integer within uint256, and above zero when `positive` is set. The
 * leading zeros are stripped and the length checked first, so no big-integer parse runs on an
 * arbitrarily long string.
 */
function isUint256(value: string, positive: boolean): boolean {
  if (!DECIMAL_UINT.test(value)) return false;
  const digits = value.replace(/^0+/, '');
  if (digits.length > MAX_UINT256_DECIMAL.length) return false;
  const n = BigInt(`0${digits}`);
  return n <= MAX_UINT256 && (!positive || n > 0n);
}

/**
 * The originator-executed deposit rules. The payer funds the deposit with directDeposit before the
 * request exists, so the request has to name everything the deposit committed, and nothing signed
 * off chain: the chain is the authorization (CORE-3005). Any other request carries no
 * `deposit_nonce`. Mirrors the Go `validateDirectDeposit`, rule for rule and message for message;
 * both read conformance/direct-deposit-rule-vectors.json.
 */
function validateDirectDeposit(document: unknown): void {
  if (typeof document !== 'object' || document === null) return;
  const root = document as Record<string, unknown>;
  const executor = hasOwn(root, 'executor') ? root.executor : undefined;
  if (!depositsAsOriginator(executor)) {
    if (hasOwn(root, 'deposit_nonce'))
      throw new DirectDepositRuleError(
        'deposit_nonce',
        'deposit_nonce is only a member of an originator-executed deposit',
      );
    return;
  }
  if (stringMember(executor, 'reserve') !== 'settler')
    throw new DirectDepositRuleError(
      'executor',
      'an originator-executed deposit names each leg, with reserve by the settler',
    );
  if (hasOwn(root, 'sender_auth'))
    throw new DirectDepositRuleError(
      'sender_auth',
      'an originator-executed deposit carries no sender_auth',
    );
  if (!isUint256(stringMember(root, 'deposit_nonce'), false))
    throw new DirectDepositRuleError('deposit_nonce', 'deposit_nonce must be a decimal uint256');
  // The escrow refuses a zero reserver or releaser (_requireDepositWitness), so a request naming
  // one validates but can never be funded.
  const quoteSelector = stringMember(root, 'quote_selector');
  if (!EVM_ADDRESS.test(quoteSelector))
    throw new DirectDepositRuleError('quote_selector', 'quote_selector must be an EVM address');
  if (isZeroAddress(quoteSelector))
    throw new DirectDepositRuleError(
      'quote_selector',
      'quote_selector must not be the zero address',
    );
  const verifier = hasOwn(root, 'fulfillment_verifier') ? root.fulfillment_verifier : undefined;
  const verifierAccount = stringMember(verifier, 'account');
  if (!EVM_ADDRESS.test(verifierAccount))
    throw new DirectDepositRuleError(
      'fulfillment_verifier',
      'fulfillment_verifier.account must be an EVM address',
    );
  if (isZeroAddress(verifierAccount))
    throw new DirectDepositRuleError(
      'fulfillment_verifier',
      'fulfillment_verifier.account must not be the zero address',
    );
  if (!isUint256(stringMember(root, 'max_source_amount'), true))
    throw new DirectDepositRuleError(
      'max_source_amount',
      'max_source_amount must be a positive uint256',
    );
  if (!DIRECT_DEPOSIT_REQUEST_ID.test(stringMember(root, 'request_id')))
    throw new DirectDepositRuleError(
      'request_id',
      "request_id must be 1 to 128 characters from A-Z, a-z, 0-9, '.', '_' and '-'",
    );
  // The source and destination checks below are the context-free part of what the derivation and
  // the escrow refuse: directDeposit pulls an allowed ERC-20 from an account, and the witness
  // commits one destination of at most MAX_DESTINATION_BYTES.
  const source = hasOwn(root, 'source') ? root.source : undefined;
  const token = DIRECT_DEPOSIT_SOURCE_ASSET.exec(stringMember(source, 'asset_identifier'));
  if (token === null)
    throw new DirectDepositRuleError(
      'source',
      'source.asset_identifier must be an ERC-20 on an EVM chain',
    );
  if (isZeroAddress(token[1] ?? ""))
    throw new DirectDepositRuleError('source', 'the source token must not be the zero address');
  if (!EVM_ADDRESS.test(stringMember(source, 'account')))
    throw new DirectDepositRuleError('source', 'source.account must be an EVM address');
  const destinations = hasOwn(root, 'destination') ? root.destination : undefined;
  if (!Array.isArray(destinations) || destinations.length !== 1)
    throw new DirectDepositRuleError(
      'destination',
      'an originator-executed deposit names exactly one destination',
    );
  // The composed destination is asset_identifier, "@" and account; lowercasing an eip155 one does
  // not change its length. Counted in UTF-8 bytes, as the escrow and the Go binding count it.
  const leg: unknown = destinations[0];
  const composed = `${stringMember(leg, 'asset_identifier')}@${stringMember(leg, 'account')}`;
  if (new TextEncoder().encode(composed).length > DIRECT_DEPOSIT_MAX_DESTINATION_BYTES)
    throw new DirectDepositRuleError(
      'destination',
      `destination[0] composes to more than the escrow's ${DIRECT_DEPOSIT_MAX_DESTINATION_BYTES} bytes`,
    );
}

/**
 * Refuses an originator-fulfilled payment whose destination token cannot take one. Originator
 * fulfill is delivered with an EIP-3009 transferWithAuthorization signed on the destination
 * token, so a token that does not implement it can never be delivered that way: the settler
 * declines every quote, and the payer learns nothing until the deadline burns. Deciding it in the
 * bindings means the settler, the gateways and a client before it calls anything all refuse the
 * same request for the same reason (CORE-2776).
 *
 * Every destination is checked, not just the first: the executor applies to the whole request, so
 * one unlisted leg is enough to make the payment undeliverable. Destinations are checked in the
 * order they appear, so the error names the first unlisted leg.
 *
 * Settler-fulfilled requests are not checked at all, and neither is a request that names no
 * executor, which means settler.
 */
function validateOriginatorFulfillDestinations(document: unknown): void {
  if (typeof document !== 'object' || document === null) return;
  const { executor, destination } = document as { executor?: unknown; destination?: unknown };
  if (!fulfillsAsOriginator(executor)) return;
  if (!Array.isArray(destination)) return;

  for (const leg of destination) {
    const assetIdentifier =
      typeof leg === 'object' && leg !== null
        ? (leg as { asset_identifier?: unknown }).asset_identifier
        : undefined;
    if (typeof assetIdentifier !== 'string') {
      throw new UnsupportedDestinationAssetError(String(assetIdentifier));
    }
    const parsed = parseAssetIdentifier(assetIdentifier);
    // An identifier this cannot read is refused rather than skipped, matching the Go rule: the
    // schema's CAIP-19 pattern means a schema-valid document never reaches that, so it only
    // arises for an unvalidated one — where admitting an unreadable destination would be the one
    // outcome this rule exists to prevent.
    if (parsed === undefined || !deliverableByEip3009(parsed)) {
      throw new UnsupportedDestinationAssetError(assetIdentifier, parsed?.chain ?? '');
    }
  }
}

/** The only CAIP-19 asset namespace EIP-3009 applies to. */
const ERC20_NAMESPACE = 'erc20';

/** A parsed CAIP-19 asset identifier, `{chain}/{namespace}:{reference}` with an optional token ID. */
interface ParsedAssetIdentifier {
  chain: string;
  namespace: string;
  reference: string;
  /** The token ID CAIP-19 allows on a non-fungible asset, empty when absent. */
  tokenId: string;
}

/**
 * Whether an EIP-3009 transferWithAuthorization can actually move this asset. Being on the list is
 * necessary but not sufficient, because the list is keyed by chain and contract address alone:
 *
 * - The namespace must be erc20. transferWithAuthorization is an ERC-20 extension, so the same
 *   address under another namespace — `eip155:8453/erc721:<a listed address>` — names a different
 *   kind of asset that no EIP-3009 transfer can deliver, and a namespace the registry has never
 *   heard of names nothing at all.
 * - A CAIP-19 token ID must be absent. transferWithAuthorization moves a fungible value, so a
 *   document naming one token of a collection is refused rather than silently delivered as if the
 *   suffix had not been written.
 */
function deliverableByEip3009(asset: ParsedAssetIdentifier): boolean {
  return (
    asset.namespace === ERC20_NAMESPACE &&
    asset.tokenId === '' &&
    supportsEip3009(asset.chain, asset.reference)
  );
}

/**
 * Splits a CAIP-19 asset identifier into its parts: `eip155:1/erc20:0xA0b8…` yields chain
 * `eip155:1`, namespace `erc20` and reference `0xA0b8…`. A token ID is reported rather than
 * dropped, so the caller decides what naming one token of a collection means.
 */
function parseAssetIdentifier(assetIdentifier: string): ParsedAssetIdentifier | undefined {
  const slash = assetIdentifier.indexOf('/');
  if (slash <= 0) return undefined;
  const chain = assetIdentifier.slice(0, slash);
  const assetPart = assetIdentifier.slice(slash + 1);

  const colon = assetPart.indexOf(':');
  if (colon <= 0) return undefined;
  const namespace = assetPart.slice(0, colon);
  const rest = assetPart.slice(colon + 1);

  const tokenIdAt = rest.indexOf('/');
  const reference = tokenIdAt >= 0 ? rest.slice(0, tokenIdAt) : rest;
  const tokenId = tokenIdAt >= 0 ? rest.slice(tokenIdAt + 1) : '';
  if (reference === '') return undefined;

  return { chain, namespace, reference, tokenId };
}
