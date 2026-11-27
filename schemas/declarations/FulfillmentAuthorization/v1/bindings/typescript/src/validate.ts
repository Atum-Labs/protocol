import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { Signature, TypedDataEncoder, getAddress, isHexString, recoverAddress } from "ethers";
// The scanner the sender-auth bindings use, not a second copy: two scanners are two chances to
// disagree about which documents are ambiguous.
import { firstAmbiguousMember, scanMembers } from "../../../../../PaymentRequest/v1/bindings/typescript/sender-auth/src/json-members.js";
import { computeQuoteHash } from "../../../../../FulfillmentQuote/v1/bindings/typescript/signing/src/quote-hash.js";
// The schemas are imported statically, as the x402 bindings do, so a bundler inlines them: a
// runtime read would resolve relative to the emitted file. schema.json is the same document the
// Go binding embeds, so both languages check the shape against one source.
import schemaJson from "../../../schema.json" with { type: "json" };
import fulfillmentQuoteSchema from "../../../../../FulfillmentQuote/v1/schema.json" with { type: "json" };
import paymentRequestSchema from "../../../../../PaymentRequest/v1/schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// Compiled lazily on first use, so importing this module does no work up front.
let documentValidator: ValidateFunction | undefined;

// Go decodes the embedded quote and request through generated types, whose UnmarshalJSON refuses a
// document missing a required member. Reading the same `required` lists keeps the two in step
// without making TypeScript stricter than Go by running these schemas in full.
const QUOTE_REQUIRED: readonly string[] = fulfillmentQuoteSchema.required;
const REQUEST_REQUIRED: readonly string[] = paymentRequestSchema.required;

// The members the settler adds when it identity-signs the declaration. They are not declaration
// fields, so schema.json does not list them.
const IDENTITY_MEMBERS = ["@context", "type", "proof"] as const;

export class FulfillmentAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FulfillmentAuthorizationError";
  }
}

/**
 * The document names a scheme the schema lists and no validator here implements (SOROBAN-AUTH
 * today).
 *
 * This is NOT a pass, and it does not mean the document is acceptable. When it is thrown only the
 * schema and the parsing of the embedded quote and payment request have run. None of the binding
 * rules ran (expiry, signer, amount, asset, recipient, nonce) and neither did the signature check,
 * so a caller that defers to a scheme-specific verifier must run every one of those itself, in that
 * verifier, before it accepts the document.
 *
 * A caller that must tell "not implemented" from "malformed" tests `instanceof`, never the message.
 * A scheme the schema does not list is refused by the schema, before this, and is a plain
 * {@link FulfillmentAuthorizationError}.
 */
export class SchemeNotImplementedError extends FulfillmentAuthorizationError {
  readonly scheme: string;
  constructor(scheme: string) {
    super(`scheme ${scheme} is not implemented`);
    this.name = "SchemeNotImplementedError";
    this.scheme = scheme;
  }
}

/**
 * The signer is a contract and its isValidSignature reverted or returned anything but the ERC-1271
 * magic value. It says the contract answered no, at the block that was asked. It does not say the
 * token would refuse: a token whose SignatureChecker tries the key first (OpenZeppelin 4.9's, which
 * PYUSD uses) accepts an EIP-7702 account whose own key signed, whatever its delegate answers, and
 * an answer can change with contract state. See {@link ValidateOptions.signatureChecker}.
 */
export class ContractSignatureRejectedError extends FulfillmentAuthorizationError {
  constructor(message: string) {
    super(`contract signature rejected: ${message}`);
    this.name = "ContractSignatureRejectedError";
  }
}

/**
 * A chain read the proof needs failed. It is a REFUSAL, not a pass, and not a signal to fall back to
 * anything: treat it as a refusal wherever a pass gates something (releasing funds, publishing an
 * authorization, accepting a document from a counterparty). The only thing it licenses is a retry.
 *
 * Do not read it as "the token decides": that is `allowContractSignature`'s semantics, which
 * accepts a signature nobody proved, and a settler can steer into it. A reader reports a failed
 * isValidSignature call that is not a revert, such as one that runs out of gas or hits an invalid
 * opcode, as an error (atum-core's evmclient.IsValidSignatureAs does, deliberately), so a wallet
 * whose isValidSignature does that makes every proof of its authorizations unverifiable. Never
 * thrown for a document that is wrong offline.
 */
export class SignatureUnverifiableError extends FulfillmentAuthorizationError {
  constructor(message: string) {
    super(`signature unverifiable: the chain could not be read: ${message}`);
    this.name = "SignatureUnverifiableError";
  }
}

/** What an isValidSignature call returned: its return data (0x-hex), or a revert. */
export interface ContractSignatureAnswer {
  /** The call reverted. A revert is the contract's answer, not a failure to ask. */
  reverted: boolean;
  /** The return data when it did not revert. */
  returnData?: string;
}

/**
 * Reads the two chain facts the token branches on. Accounts reach it as 0x-prefixed lowercase
 * 20-byte hex and `network` is the CAIP-2 id (`eip155:<chainId>`) of the chain the authorization is
 * for. A rejected promise from either method means the chain could not be read, and is reported as
 * {@link SignatureUnverifiableError}, never as a contract refusal, and that is a refusal for the
 * caller.
 *
 * A reader must reject for a network it does not serve, rather than answer from another chain:
 * the document's network is passed, and an account has different code, or none, on another chain.
 *
 * `block` is the block to read at, or undefined for the latest. It is the same value for both
 * methods of one proof (see {@link ValidateOptions.block}), so a caller that needs the code and the
 * call to describe one state, or to ask about the block a transfer executed in, passes one.
 */
export interface SettlerSignatureChecker {
  /**
   * Whether `account` has code at `block`: the token's isContract(signer). An EIP-7702 delegation
   * designator (0xef0100 || delegate) is code.
   */
  hasCode(network: string, account: string, block?: bigint): Promise<boolean>;
  /**
   * Calls `account.isValidSignature(digest, signature)` at `block` with msg.sender set to `caller`,
   * which is the token: a contract may answer only the callers it trusts. A revert must come back as
   * `{ reverted: true }`, not as a rejection. The answer depends on contract state, so it must never
   * be cached.
   */
  isValidSignatureFrom(
    network: string,
    account: string,
    digest: string,
    signature: string,
    caller: string,
    block?: bigint,
  ): Promise<ContractSignatureAnswer>;
}

type Json = Record<string, unknown>;

/**
 * The transfer a scheme's signed authorization lets anyone execute, read from what the
 * settler signed. Every scheme reduces its authorization to this, and the shared rules
 * check it against the quote and payment request.
 */
interface AuthorizedTransfer {
  /** The address that signed the authorization and pays the transfer. */
  from: string;
  to: string;
  /** Amount in the asset's base units. */
  value: bigint;
  /** CAIP-19 identifier of the token the authorization moves. */
  asset: string;
  /** The authorization's nonce, which the scheme binds to the quote hash. */
  nonce: string;
  /** Earliest unix second the authorization is usable, when the scheme has a lower bound. */
  notBefore?: bigint;
  /**
   * The scheme's own expiry field as signed, in unix seconds: EIP-3009's validBefore. A scheme
   * without one cannot be bounded by the fulfillment deadline and must not be added.
   */
  expiry: bigint;
  /**
   * The part of proving the signature that needs the chain, when the caller supplied a checker. It
   * runs after every offline rule has passed, so a document that fails one costs no chain read and
   * an account the quote does not name is never asked about.
   */
  verifySignature?: () => Promise<void>;
}

/**
 * What a caller accepts. The default — an empty object, or nothing at all — is strict, so a pass
 * proves the signature recovered to `message.from`.
 */
export interface ValidateOptions {
  /**
   * Accept a signature that is not the 65-byte r‖s‖v form an EOA produces, on the token's
   * authority rather than this validator's.
   *
   * Without it, a signature that is not 65 bytes is refused. That is the default because this
   * validator cannot tell an EOA settler from a contract one — that needs an eth_call, and these
   * functions are pure — so the permissive branch is reachable for any settler.
   *
   * Pass it only when the settler genuinely may be a contract wallet. The authorization is then
   * accepted with a byte-validity check and nothing more: no offline check can prove an ERC-1271
   * signature, so a pass under this option does NOT show the settler authorised the transfer.
   *
   * @deprecated `signatureChecker` proves a contract signature instead of leaving it to the token,
   * which is the better answer wherever the caller can read the chain. This stays for a caller that
   * cannot, and for the callers that already use it.
   */
  allowContractSignature?: boolean;
  /**
   * Proves the settler's signature with the rule the token applies on chain
   * (SignatureChecker.isValidSignatureNow, in USDC's FiatTokenV2_2, PYUSD, USDT0's
   * ArbitrumExtensionV2 and TetherTokenCeloExtension): a signer with no code must have signed the
   * digest with its key, and a signer with code must answer ERC-1271 isValidSignature with the
   * magic value, to a call whose msg.sender is the token. This is the Go binding's
   * `ValidateWithChain`.
   *
   * Everything else is checked first, in the same order, and the chain is read only after every
   * offline rule has passed. A pass means the settler's key signed (no code) or its contract
   * vouched for the signature (code), at the block that was asked (the latest by default). It is
   * not a promise about the block the transfer lands in, so keep the token as the authority and
   * never cache a verdict.
   *
   * A refusal throws {@link ContractSignatureRejectedError} only when the contract answered; a
   * chain that could not be read throws {@link SignatureUnverifiableError}. BOTH ARE REFUSALS.
   * `SignatureUnverifiableError` permits a retry and nothing else: do not fall back to the token as
   * the authority, which is `allowContractSignature`'s semantics and accepts a signature nobody
   * proved. A settler can make its own authorizations unverifiable (a wallet whose isValidSignature
   * runs out of gas or hits an invalid opcode is an error to a reader that cannot tell it from a
   * node fault), so wherever a pass gates anything, an unverifiable result must gate it shut.
   * `allowContractSignature` has no effect when this is set: the signature is proved, not allowed.
   *
   * By default both chain reads are at the latest block, and they are two reads, so they can land on
   * different blocks. Set {@link ValidateOptions.block} to read both at one block.
   *
   * For an EIP-7702 account (an EOA that delegated to code, which has code and can also sign with
   * its own key) the tokens differ. Circle's SignatureChecker (USDC's FiatTokenV2_2) tests code
   * first and sends the signature to the delegate, which is the order used here. OpenZeppelin 4.9's
   * tries the key first and calls ERC-1271 only when that fails; PYUSD's two listed deployments use
   * it, so a delegated settler whose own key signed executes there even if its delegate would refuse
   * the signature. For such an account on a key-first token this throws
   * {@link ContractSignatureRejectedError} where the token would accept: the safe direction, and a
   * divergence this binding does not close, since it holds no per-token table and which ordering a
   * deployed implementation has cannot be shown offline. USDT0's ArbitrumExtensionV2 and
   * TetherTokenCeloExtension were not checked against either ordering.
   *
   * What this does not prove: that the token accepts the signature. The token still checks the
   * nonce, the balance, the validity window and its own domain name and version, and a 64-byte
   * EIP-2098 signature from an account with no code, which FiatTokenV2_2 accepts, is refused here
   * because only the 65-byte form is.
   */
  signatureChecker?: SettlerSignatureChecker;
  /**
   * The block `signatureChecker` reads the signer's code and makes the isValidSignature call at,
   * both at this one block. Undefined is the latest, for each read separately. Use it to ask about
   * the block a transfer executed in. It has no effect without a `signatureChecker`.
   */
  block?: bigint;
}

/**
 * Reads a scheme's signed authorization into the transfer it authorizes, and proves it is
 * what was signed: the signed message must be the scheme's digest of the readable form, and
 * the signature must recover to its signer. It is handed the quote's destination asset
 * (CAIP-19) so it can bind whatever its signing domain names to the token the authorization is
 * for, by the field names the settler signed; the shared rules then compare the asset it
 * reports as a whole. A new scheme (Permit2, CORE-2709) adds an entry and reports its own
 * expiry field as `expiry`; the shared rules then bound it by the fulfillment deadline.
 */
const SCHEME_PARSERS: Record<string, (authorization: Json, destination: string, options: ValidateOptions) => AuthorizedTransfer> = {
  "EIP-3009": parseEIP3009,
};

/**
 * Checks a FulfillmentAuthorization from its JSON text. This is the full-strength entry point:
 * only the bytes carry the member names, so it is the one that can refuse a document whose
 * members fold together. Prefer it wherever the text is in hand, which is what a consumer
 * reading a stored or transmitted document has.
 */
export async function validateFulfillmentAuthorizationJSON(documentJson: string, options: ValidateOptions = {}): Promise<void> {
  refuseAmbiguousMembers(documentJson, "fulfillment authorization", true);
  let document: unknown;
  try {
    document = JSON.parse(documentJson);
  } catch (err) {
    throw new FulfillmentAuthorizationError(`fulfillment authorization is not valid JSON: ${(err as Error).message}`);
  }
  await validateFulfillmentAuthorization(asRecord(document, "fulfillment authorization"), options);
}

/**
 * Shared FulfillmentAuthorization checks: the declaration schema, then the rules every consumer
 * applies on top — expiry, signer, amount, asset, recipient, and the EIP-3009 nonce.
 *
 * Accepts the declaration on its own or as the settler identity-signs it, with `@context`,
 * `type` and `proof` alongside the declaration fields. The identity proof is not verified.
 *
 * `JSON.parse` has already collapsed any members of this object that fold together, so this
 * entry point can only scan the documents that are still text: the embedded quote, the request
 * inside it, and the signed prehash. Call `validateFulfillmentAuthorizationJSON` instead when
 * the document's own bytes are available.
 */
export async function validateFulfillmentAuthorization(document: Json, options: ValidateOptions = {}): Promise<void> {
  if (document.type !== undefined && document.type !== "FulfillmentAuthorization") {
    throw new FulfillmentAuthorizationError(`type must be "FulfillmentAuthorization", got ${JSON.stringify(document.type)}`);
  }
  // The schema describes the declaration fields only, so the identity members come off first.
  // Go does the same before handing the document to gojsonschema.
  const declaration: Json = { ...document };
  for (const member of IDENTITY_MEMBERS) delete declaration[member];
  documentValidator ??= ajv.compile(schemaJson as object);
  if (!documentValidator(declaration)) {
    throw new FulfillmentAuthorizationError(`fulfillment authorization does not match its schema: ${ajv.errorsText(documentValidator.errors)}`);
  }

  const authorization = asRecord(document.authorization, "authorization");
  const quoteJson = document.fulfillment_quote_json as string;
  refuseAmbiguousMembers(quoteJson, "fulfillment_quote_json", true);
  const quote = parseEmbedded(quoteJson, "fulfillment_quote_json");
  requireMembers(quote, QUOTE_REQUIRED, "fulfillment quote");

  const requestJson = quote.payment_request_json;
  if (typeof requestJson !== "string") {
    throw new FulfillmentAuthorizationError("fulfillment quote payment_request_json is missing");
  }
  refuseAmbiguousMembers(requestJson, "payment_request_json", true);
  const paymentRequest = parseEmbedded(requestJson, "payment_request_json");
  requireMembers(paymentRequest, REQUEST_REQUIRED, "payment request");

  // Object.hasOwn, not a bare index: a plain lookup resolves inherited members such as
  // "constructor", so a document naming one as its scheme would reach a function that is not a
  // scheme parser.
  const scheme = String(document.scheme);
  const parse = Object.hasOwn(SCHEME_PARSERS, scheme) ? SCHEME_PARSERS[scheme] : undefined;
  if (!parse) {
    throw new SchemeNotImplementedError(scheme);
  }
  const destination = asRecord(quote.destination, "fulfillment_quote.destination");
  const transfer = parse(authorization, String(destination.id), options);
  // fulfillment_quote_json stays the original string so the quote hash uses those bytes.
  await validateTransfer(transfer, quote, paymentRequest, quoteJson);
  await transfer.verifySignature?.();
}

/** The rules every scheme shares. */
async function validateTransfer(transfer: AuthorizedTransfer, quote: Json, paymentRequest: Json, quoteJSON: string): Promise<void> {
  validateExpiry(transfer, paymentRequest);
  if (!sameAccount(transfer.from, String(quote.settler_address))) {
    throw new FulfillmentAuthorizationError(`signer ${transfer.from} does not equal settler_address ${String(quote.settler_address)}`);
  }
  const amount = parseUint256(paymentRequest.fulfillment_amount);
  if (amount === undefined || transfer.value !== amount) {
    throw new FulfillmentAuthorizationError(`amount ${transfer.value} does not equal fulfillment_amount ${String(paymentRequest.fulfillment_amount)}`);
  }
  const destination = String(asRecord(quote.destination, "fulfillment_quote.destination").id);
  if (!sameAsset(transfer.asset, destination)) {
    throw new FulfillmentAuthorizationError(`asset ${transfer.asset} does not equal quote destination ${destination}`);
  }
  const paymentDestinations = paymentRequest.destination;
  if (!Array.isArray(paymentDestinations)) {
    throw new FulfillmentAuthorizationError("payment request destination is missing");
  }
  const matched = paymentDestinations.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const dest = entry as Json;
    return sameAccount(transfer.to, String(dest.account)) && sameAsset(transfer.asset, String(dest.asset_identifier));
  });
  if (!matched) {
    throw new FulfillmentAuthorizationError(`recipient ${transfer.to} does not equal a payment request destination for asset ${transfer.asset}`);
  }
  const quoteHash = await computeQuoteHash(quoteJSON);
  if (transfer.nonce.toLowerCase() !== String(quoteHash).toLowerCase()) {
    throw new FulfillmentAuthorizationError(`nonce ${transfer.nonce} does not equal quote hash ${String(quoteHash)}`);
  }
}

/**
 * Requires the authorization to expire exactly at the payment request's fulfillment
 * deadline, in whole unix seconds (the deadline's fraction is dropped, as the settler and the
 * destination contract both do). Later would let the originator move the settler's funds
 * after the deadline, when the escrow can already refund the sender. Earlier would cut short
 * the window the originator was promised to fulfill in.
 */
function validateExpiry(transfer: AuthorizedTransfer, paymentRequest: Json): void {
  if (transfer.notBefore !== undefined && transfer.notBefore >= transfer.expiry) {
    throw new FulfillmentAuthorizationError(
      `not-before ${transfer.notBefore} is not earlier than expiry ${transfer.expiry}, so the authorization is never usable`,
    );
  }
  const deadlineMs = Date.parse(String(paymentRequest.fulfillment_deadline));
  if (Number.isNaN(deadlineMs)) {
    throw new FulfillmentAuthorizationError("payment request fulfillment_deadline is not a date-time");
  }
  const deadline = BigInt(Math.floor(deadlineMs / 1000));
  const label = `${deadline} (${String(paymentRequest.fulfillment_deadline)})`;
  if (transfer.expiry > deadline) {
    throw new FulfillmentAuthorizationError(`expiry ${transfer.expiry} is after the fulfillment deadline ${label}`);
  }
  if (transfer.expiry < deadline) {
    throw new FulfillmentAuthorizationError(`expiry ${transfer.expiry} is before the fulfillment deadline ${label}; it must equal it`);
  }
}

// An EIP-3009 authorization carries its typed data as a JSON string in
// authorization.message_prehash, the EIP-712 digest of that typed data in
// authorization.message, and the settler's signature over the digest in
// authorization.signature. It has no payload.
const EIP3009_PRIMARY_TYPE = "TransferWithAuthorization";
const EIP3009_AUTHORIZATION_MEMBERS = ["message", "message_prehash", "signature"];
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const TYPED_DATA_KEYS = ["domain", "types", "primaryType", "message"];
const DOMAIN_KEYS = ["name", "version", "chainId", "verifyingContract"];
const MESSAGE_KEYS = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MAX_UINT256 = (1n << 256n) - 1n;

function parseEIP3009(authorization: Json, destination: string, options: ValidateOptions): AuthorizedTransfer {
  if (authorization.payload !== undefined) {
    throw new FulfillmentAuthorizationError("EIP-3009 authorization must not carry payload; the transfer is read from message_prehash");
  }
  // An allowlist, not just a payload refusal: anything else in here is a member no signature
  // covers and no rule reads, so a reader could take meaning from it that the settler never gave.
  for (const member of Object.keys(authorization)) {
    if (!EIP3009_AUTHORIZATION_MEMBERS.includes(member)) {
      throw new FulfillmentAuthorizationError(`EIP-3009 authorization has unknown member ${member}`);
    }
  }
  if (typeof authorization.message_prehash !== "string" || authorization.message_prehash === "") {
    throw new FulfillmentAuthorizationError(
      "EIP-3009 authorization requires message_prehash (the TransferWithAuthorization typed data as JSON)",
    );
  }
  // No @context exemption: a signed prehash carries no JSON-LD, so every member of it is checked.
  refuseAmbiguousMembers(authorization.message_prehash, "message_prehash", false);
  const { transfer, digest, chainId, verifyingContract } = decodeEIP3009(authorization.message_prehash);

  const message = authorization.message;
  if (typeof message !== "string" || !isHexString(message, 32) || message.toLowerCase() !== digest.toLowerCase()) {
    throw new FulfillmentAuthorizationError(`authorization.message ${String(message)} is not the EIP-712 digest of message_prehash (${digest})`);
  }
  // The settler's signature has three outcomes, by who can prove it:
  //
  //   - signatureChecker: the chain is read, and the signature is proved by the rule the token
  //     applies. That check is deferred to after every offline rule, in verifySignature.
  //   - A 65-byte signature: recovered here and matched to message.from. A pass proves the
  //     settler's key signed.
  //   - Anything else: refused, unless the caller passed allowContractSignature. This validator
  //     cannot tell an EOA settler from a contract one without an eth_call, so the permissive branch
  //     is reachable for any settler, and accepting it by default meant a pass no longer proved the
  //     settler signed (CORE-2955). Under the option the token is the authority.
  //
  // Contract signatures are real: every token in the EIP-3009 list verifies through
  // SignatureChecker.isValidSignatureNow, which sends an EOA signer to ECRecover and a signer WITH
  // CODE to its ERC-1271 isValidSignature — USDC's FiatTokenV2_2, PYUSD, USDT0's
  // ArbitrumExtensionV2 and TetherTokenCeloExtension all do.
  let verifySignature: (() => Promise<void>) | undefined;
  const checker = options.signatureChecker;
  if (checker !== undefined) {
    const signature = requireSignatureHex(authorization.signature);
    verifySignature = () => proveSignature(checker, transfer.from, chainId, verifyingContract, digest, signature, options.block);
  } else if (isEOASignature(authorization.signature)) {
    requireEOASigner(digest, authorization.signature, transfer.from);
  } else if (!options.allowContractSignature) {
    throw notEOASignature(authorization.signature);
  } else {
    requireSignatureBytes(authorization.signature);
  }
  requireDomainBinding(chainId, verifyingContract, destination);
  return verifySignature === undefined ? transfer : { ...transfer, verifySignature };
}

/**
 * Ties the EIP-712 domain to the quote's destination asset, which is the token the authorization
 * is for: `domain.chainId` must be the destination's chain reference and
 * `domain.verifyingContract` its token address. The message fields are bound to the quote (from to
 * the settler, to to the recipient, value to the amount, nonce to the quote hash, validBefore to
 * the deadline, validAfter to 0), and a consumer takes a pass as "this authorization is for this
 * payment", so these two domain fields are bound the same way (CORE-2991).
 *
 * `domain.name` and `domain.version` sit in the same domain separator and are NOT bound: they are
 * only type-checked, so a pass does not prove the token will accept the signature. An
 * authorization signed under a name or version the token does not hash reverts on chain.
 *
 * Not a hole on chain: both fields are in the EIP-712 domain separator, so the destination token
 * computes a different digest and rejects a signature made under another domain. The shared asset
 * rule also compares the whole CAIP-19 identifier the domain reduces to; this check runs first and
 * names the field that differs, in the words the settler signed. Both halves are compared as the
 * shared rules compare accounts and assets: folded, so a checksummed and a lower-case spelling of
 * one address are the same token.
 */
function requireDomainBinding(chainId: bigint, verifyingContract: string, destination: string): void {
  const slash = destination.indexOf("/");
  const chain = slash < 0 ? destination : destination.slice(0, slash);
  const asset = slash < 0 ? "" : destination.slice(slash + 1);
  const colon = asset.indexOf(":");
  const token = colon < 0 ? "" : asset.slice(colon + 1);
  if (!sameAsset(`eip155:${chainId}`, chain)) {
    throw new FulfillmentAuthorizationError(`message_prehash domain.chainId ${chainId} is not the quote destination's chain ${chain}`);
  }
  if (!sameAccount(verifyingContract, token)) {
    throw new FulfillmentAuthorizationError(
      `message_prehash domain.verifyingContract ${verifyingContract} is not the quote destination's token ${token}`,
    );
  }
}

/**
 * Reads message_prehash, which must be exactly the TransferWithAuthorization typed data the
 * settler signs, and returns the transfer it describes, its EIP-712 digest, and the two domain
 * fields the digest covers, kept apart from the transfer so the scheme can bind each to the quote
 * by its signed name.
 */
function decodeEIP3009(prehash: string): {
  transfer: AuthorizedTransfer;
  digest: string;
  chainId: bigint;
  verifyingContract: string;
} {
  let typed: Json;
  try {
    typed = asRecord(JSON.parse(prehash), "message_prehash");
  } catch (err) {
    throw new FulfillmentAuthorizationError(`message_prehash is not EIP-3009 typed data: ${(err as Error).message}`);
  }
  const domain = asRecord(typed.domain, "message_prehash domain");
  const message = asRecord(typed.message, "message_prehash message");
  for (const [record, keys, label] of [
    [typed, TYPED_DATA_KEYS, "message_prehash"],
    [domain, DOMAIN_KEYS, "message_prehash domain"],
    [message, MESSAGE_KEYS, "message_prehash message"],
  ] as const) {
    const unknown = Object.keys(record).filter((key) => !(keys as readonly string[]).includes(key));
    if (unknown.length > 0) {
      throw new FulfillmentAuthorizationError(`message_prehash is not EIP-3009 typed data: ${label} has unknown field ${unknown[0]}`);
    }
  }
  if (typed.primaryType !== EIP3009_PRIMARY_TYPE) {
    throw new FulfillmentAuthorizationError(`message_prehash primaryType ${JSON.stringify(typed.primaryType)} is not ${EIP3009_PRIMARY_TYPE}`);
  }
  if (JSON.stringify(typed.types) !== JSON.stringify(EIP3009_TYPES)) {
    throw new FulfillmentAuthorizationError("message_prehash types must be exactly the EIP-3009 TransferWithAuthorization type");
  }

  const chainId = parseUint256(typeof domain.chainId === "number" && Number.isSafeInteger(domain.chainId) ? String(domain.chainId) : domain.chainId);
  if (chainId === undefined || chainId === 0n) {
    throw new FulfillmentAuthorizationError(`message_prehash domain.chainId ${JSON.stringify(domain.chainId)} is not a positive integer`);
  }
  if (typeof domain.verifyingContract !== "string" || !EVM_ADDRESS.test(domain.verifyingContract)) {
    throw new FulfillmentAuthorizationError(`message_prehash domain.verifyingContract ${JSON.stringify(domain.verifyingContract)} is not an EVM address`);
  }
  if (typeof domain.name !== "string" || typeof domain.version !== "string") {
    throw new FulfillmentAuthorizationError("message_prehash is not EIP-3009 typed data: domain.name and domain.version must be strings");
  }
  const { from, to, nonce } = message;
  if (typeof from !== "string" || !EVM_ADDRESS.test(from) || typeof to !== "string" || !EVM_ADDRESS.test(to)) {
    throw new FulfillmentAuthorizationError("message_prehash message.from and message.to must be EVM addresses");
  }
  const value = parseUint256(message.value);
  const validAfter = parseUint256(message.validAfter);
  const validBefore = parseUint256(message.validBefore);
  if (value === undefined || validAfter === undefined || validBefore === undefined) {
    throw new FulfillmentAuthorizationError("message_prehash message.value, validAfter and validBefore must be uint256 decimal strings");
  }
  // The settler signs validAfter 0 and the README documents it. A later not-before is a
  // transfer the token refuses until it passes, so it only shortens the window the originator
  // was quoted, and an authorization no one can execute reads as one that can.
  if (validAfter !== 0n) {
    throw new FulfillmentAuthorizationError(`message_prehash message.validAfter must be 0, got ${String(message.validAfter)}`);
  }
  if (typeof nonce !== "string" || !isHexString(nonce, 32)) {
    throw new FulfillmentAuthorizationError(`message_prehash message.nonce ${JSON.stringify(nonce)} is not bytes32 hex`);
  }

  const digest = TypedDataEncoder.hash(
    { name: domain.name, version: domain.version, chainId, verifyingContract: domain.verifyingContract },
    EIP3009_TYPES,
    { from, to, value, validAfter, validBefore, nonce },
  );
  return {
    transfer: {
      from,
      to,
      value,
      asset: `eip155:${chainId}/erc20:${domain.verifyingContract}`,
      nonce,
      notBefore: validAfter,
      expiry: validBefore,
    },
    digest,
    chainId,
    verifyingContract: domain.verifyingContract,
  };
}

/**
 * Whether the signature is the 65-byte r‖s‖v form an EOA produces, and so one this validator can
 * verify offline. Anything else is a contract (ERC-1271) signature, whose shape is the wallet's
 * own business and whose validity only the chain can answer.
 */
function isEOASignature(signature: unknown): signature is string {
  return typeof signature === "string" && isHexString(signature, 65);
}

/**
 * The strict-default refusal: the signature is not the 65-byte EOA form, and the caller did not
 * say its settler may be a contract wallet.
 */
function notEOASignature(signature: unknown): FulfillmentAuthorizationError {
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return new FulfillmentAuthorizationError("authorization.signature must be 0x-prefixed hex");
  }
  const bytes = Math.floor((signature.length - 2) / 2);
  return new FulfillmentAuthorizationError(
    `authorization.signature must be 65 bytes, got ${bytes}; set allowContractSignature if this settler may be a contract wallet`,
  );
}

/**
 * The only check a contract signature gets here: that it is hex, and not empty. ERC-1271 puts no
 * shape on the bytes, so there is nothing else to assert offline.
 */
function requireSignatureBytes(signature: unknown): void {
  if (typeof signature !== "string" || !isHexString(signature) || signature.length <= 2) {
    throw new FulfillmentAuthorizationError("authorization.signature must be non-empty 0x-prefixed hex");
  }
}

/** The offline rule for a 65-byte signature: it recovers to `from`. */
function requireEOASigner(digest: string, signature: string, from: string): void {
  const signer = recoverSigner(digest, signature);
  if (signer !== getAddress(from)) {
    throw new FulfillmentAuthorizationError(`authorization.signature recovers to ${signer}, not message.from ${from}`);
  }
}

// What is handed to an eth_call is bounded: in characters with the 0x, 32767 bytes, as the
// depositor side bounds it, so one reader refuses the same values for both bindings.
const MAX_CONTRACT_SIGNATURE_LENGTH = 65536;

/**
 * The offline check a signature gets before the chain is read: hex of whole bytes, and bounded.
 * Whether it is empty is the chain's business, since a wallet that approved the digest on chain
 * answers for an empty one.
 */
function requireSignatureHex(signature: unknown): string {
  if (typeof signature !== "string" || !isHexString(signature, true)) {
    throw new FulfillmentAuthorizationError("authorization.signature must be 0x-prefixed hex of whole bytes");
  }
  if (signature.length > MAX_CONTRACT_SIGNATURE_LENGTH) {
    throw new FulfillmentAuthorizationError(`authorization.signature is longer than ${MAX_CONTRACT_SIGNATURE_LENGTH} characters`);
  }
  return signature;
}

// The only return data the token accepts: isValidSignature's own selector, 0x1626ba7e, as a
// left-aligned bytes32.
const ERC1271_MAGIC_WORD = `0x1626ba7e${"00".repeat(28)}`;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The token's rule, evaluated off chain. See {@link ValidateOptions.signatureChecker}. */
async function proveSignature(
  checker: SettlerSignatureChecker,
  from: string,
  chainId: bigint,
  token: string,
  digest: string,
  signature: string,
  block: bigint | undefined,
): Promise<void> {
  const network = `eip155:${chainId}`;
  const account = from.toLowerCase();
  let hasCode: boolean;
  try {
    hasCode = await checker.hasCode(network, account, block);
  } catch (err) {
    throw new SignatureUnverifiableError(`the signer's code could not be read: ${errorText(err)}`);
  }
  if (!hasCode) {
    // No code: the token recovers a key, so the rule is the offline one. A signature that is not
    // 65 bytes cannot be one.
    const bytes = (signature.length - 2) / 2;
    if (bytes !== 65) {
      throw new FulfillmentAuthorizationError(
        `authorization.signature must be 65 bytes, got ${bytes}: the signer ${from} has no code on ${network}, so only its key can sign`,
      );
    }
    requireEOASigner(digest, signature, from);
    return;
  }
  let answer: ContractSignatureAnswer;
  try {
    answer = await checker.isValidSignatureFrom(network, account, digest, signature, token.toLowerCase(), block);
  } catch (err) {
    throw new SignatureUnverifiableError(`isValidSignature could not be called on ${from}: ${errorText(err)}`);
  }
  if (answer.reverted) {
    throw new ContractSignatureRejectedError(`isValidSignature on ${from} reverted`);
  }
  const data = typeof answer.returnData === "string" && isHexString(answer.returnData, true) ? answer.returnData.toLowerCase() : "0x";
  if (data.length >= 66 && data.slice(0, 66) === ERC1271_MAGIC_WORD) return;
  throw new ContractSignatureRejectedError(`isValidSignature on ${from} returned ${data.slice(0, 66)}, not the ERC-1271 magic value`);
}

/**
 * Recovers the address that produced a 65-byte r‖s‖v signature over digest. Refuses high-s
 * signatures, which EIP-3009 tokens reject on chain.
 */
function recoverSigner(digest: string, signature: unknown): string {
  if (typeof signature !== "string" || !isHexString(signature, 65)) {
    throw new FulfillmentAuthorizationError("authorization.signature must be 65 bytes of 0x-prefixed hex");
  }
  // Only 27 and 28. FiatToken's ECRecover reverts on 0 and 1, so accepting them here would pass
  // an authorization whose transferWithAuthorization cannot be executed, and a go-ethereum
  // producer that skips the +27 (CORE-2772) would clear this gate.
  const v = parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) {
    throw new FulfillmentAuthorizationError(`authorization.signature has recovery id ${v}; EIP-3009 accepts only 27 and 28`);
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  if (r === 0n || s === 0n || s > SECP256K1_HALF_N) {
    throw new FulfillmentAuthorizationError("authorization.signature is not a canonical secp256k1 signature");
  }
  const normalized = `${signature.slice(0, 130)}${(v < 27 ? v + 27 : v).toString(16)}`;
  try {
    return recoverAddress(digest, Signature.from(normalized));
  } catch (err) {
    throw new FulfillmentAuthorizationError(`authorization.signature does not recover: ${(err as Error).message}`);
  }
}

/** Reads a canonical unsigned decimal string (no sign, no leading zeros) that fits uint256. */
function parseUint256(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const n = BigInt(value);
  return n > MAX_UINT256 ? undefined : n;
}

/**
 * Refuses a document with sibling members that fold to one name, exact duplicates included,
 * before anything reads it. Go's encoding/json matches member names case-insensitively and keeps
 * the last match, while JSON.parse keeps each spelling apart, so such a document means different
 * things to the two languages; and because URDNA2015 drops members the context does not define, a
 * twin changes neither the quote hash nor the settler's proof. The shared scanner is the one the
 * sender-auth bindings already use.
 */
function refuseAmbiguousMembers(document: string, label: string, exemptContext: boolean): void {
  let path: string | undefined;
  try {
    path = exemptContext ? firstAmbiguousMember(document) : scanMembers(document, false);
  } catch (err) {
    throw new FulfillmentAuthorizationError(`${label} is not valid JSON: ${(err as Error).message}`);
  }
  if (path !== undefined) {
    throw new FulfillmentAuthorizationError(`${label} has ambiguous member ${path}: two members of one object fold to the same name`);
  }
}

function parseEmbedded(text: string, label: string): Json {
  try {
    return asRecord(JSON.parse(text), label);
  } catch (err) {
    if (err instanceof FulfillmentAuthorizationError) throw err;
    throw new FulfillmentAuthorizationError(`${label} is not valid JSON: ${(err as Error).message}`);
  }
}

/** The members Go's generated type requires, checked by name so the two languages agree. */
function requireMembers(document: Json, required: readonly string[], label: string): void {
  for (const member of required) {
    if (!Object.hasOwn(document, member)) {
      throw new FulfillmentAuthorizationError(`${label} is missing required member ${member}`);
    }
  }
}

function asRecord(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FulfillmentAuthorizationError(`${label} is missing`);
  }
  return value as Json;
}

function sameAccount(a: string, b: string): boolean {
  return trimASCIISpace(a).toLowerCase() === trimASCIISpace(b).toLowerCase();
}

/**
 * Compares CAIP-19 identifiers, and the CAIP-2 chain identifiers that start them, whole: trimmed
 * and case folded. EVM addresses inside them may be checksummed or not, and an eip155 reference is
 * decimal, so folding it changes nothing. A chain whose reference is case sensitive would need its
 * own comparison.
 */
function sameAsset(a: string, b: string): boolean {
  return trimASCIISpace(a).toLowerCase() === trimASCIISpace(b).toLowerCase();
}

/**
 * Trims the four ASCII whitespace characters and nothing else. JavaScript's trim() also strips
 * U+FEFF and keeps U+0085, while Go's strings.TrimSpace does the opposite; the same bytes would
 * then pass in one language and be refused in the other. The Go binding's trimASCIISpace trims
 * exactly this set.
 */
function trimASCIISpace(s: string): string {
  const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  let start = 0;
  let end = s.length;
  while (start < end && isSpace(s.charCodeAt(start))) start++;
  while (end > start && isSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}
