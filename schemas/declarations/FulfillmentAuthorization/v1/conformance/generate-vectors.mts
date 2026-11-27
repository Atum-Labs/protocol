// Generates the FulfillmentAuthorization conformance vectors with the settler's own code, so the
// vectors are the documents settlers sign rather than a second implementation's idea of them.
//
// It imports from a settler-agent checkout: the EIP-3009 typed data and digest
// (packages/agent/src/fulfillment/eip3009.ts), the quote signer, and the identity signer
// (packages/agent/src/fulfillment/sign-authorization.ts). The settler signs EIP-3009 through
// its key-management signer's signTypedData; here a local key signs the same typed data.
//
// Keys are the public Hardhat development accounts. Every signature is deterministic (RFC 6979)
// and the clock is pinned, so a rerun at the same settler-agent commit reproduces the files.
//
// Run from schemas/declarations (it needs this package's ethers), with settler-agent installed:
//
//   SETTLER_AGENT=/path/to/settler-agent \
//     /path/to/settler-agent/packages/agent/node_modules/.bin/tsx \
//     FulfillmentAuthorization/v1/conformance/generate-vectors.mts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Wallet } from "ethers";

const SETTLER_AGENT = process.env.SETTLER_AGENT;
if (!SETTLER_AGENT) {
  throw new Error("set SETTLER_AGENT to a settler-agent checkout");
}
const settlerSrc = join(SETTLER_AGENT, "packages", "agent", "src");
const load = (path: string) => import(pathToFileURL(join(settlerSrc, path)).href);

// Hardhat accounts #0 (the settler) and #1 (someone else). The recipient is account #2.
const SETTLER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ASSET = `eip155:${CHAIN_ID}/erc20:${USDC}`;
// Base mainnet, and its USDC: a real chain and a real token, so the domain mismatch vectors are
// documents a settler pointed at the wrong network would actually produce.
const OTHER_CHAIN_ID = 8453;
const OTHER_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const AMOUNT = "100000";
// The fraction is deliberate: the settler floors the deadline to whole seconds for validBefore.
const FULFILLMENT_DEADLINE = "2030-01-02T00:00:00.335Z";
const DEADLINE_SECONDS = BigInt(Math.floor(Date.parse(FULFILLMENT_DEADLINE) / 1000));
const SIGNED_AT = "2029-12-31T23:00:00.000Z";

interface Vector {
  file: string;
  valid: boolean;
  description: string;
  error_contains?: string;
  /**
   * The verdict when the caller allows a contract signature (Go's AllowContractSignature,
   * TypeScript's `{ allowContractSignature: true }`). Absent means the option does not change
   * this vector, so both suites only run it in the default, strict mode.
   */
  contract_signatures_allowed?: { valid: boolean; error_contains?: string };
}

/**
 * Inserts a raw member at the front of the object that starts at the first `{` after `anchor`.
 * JSON.stringify cannot write a member twice, and a twin is the whole point of these vectors, so
 * they are built as text.
 */
function insertMember(json: string, anchor: string, member: string): string {
  const at = json.indexOf("{", json.indexOf(anchor) + anchor.length);
  if (at < 0) throw new Error(`no object after ${anchor}`);
  return `${json.slice(0, at + 1)}${member},${json.slice(at + 1)}`;
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function main(): Promise<void> {
  pinClock(SIGNED_AT);
  const { eip3009AuthorizationHash, eip3009MessagePrehash, EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES } =
    await load("fulfillment/eip3009.ts");
  const { signQuoteWithSigner, rawKeySettlerProofSigner } = await load("ld-signing/sign.ts");
  const { signFulfillmentAuthorizationWithSigner } = await load("fulfillment/sign-authorization.ts");

  const settler = new Wallet(SETTLER_KEY);
  const other = new Wallet(OTHER_KEY);
  const verificationMethod = `did:pkh:eip155:${CHAIN_ID}:${settler.address.toLowerCase()}#blockchainAccountId`;

  const paymentRequest = {
    version: "1.0",
    request_id: "fa-conformance-1",
    source: { asset_identifier: "eip155:421614/erc20:0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", account: RECIPIENT },
    destination: [{ asset_identifier: ASSET, account: RECIPIENT }],
    fulfillment_amount: AMOUNT,
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: FULFILLMENT_DEADLINE,
    fulfillment_verifier: { account: "0x0000000000000000000000000000000000000004", endpoint: "https://veri-fill.example.com" },
    escrow_contract_address: "0x0000000000000000000000000000000000000003",
    executor: { deposit: "settler", reserve: "settler", fulfill: "originator" },
  };
  const { signedQuote, quoteHash } = await signQuoteWithSigner(
    {
      version: "1.0",
      source_amount: "100100",
      award_deadline: "2030-01-01T00:00:00Z",
      source: { id: paymentRequest.source.asset_identifier, account: RECIPIENT },
      destination: { id: ASSET, account: RECIPIENT },
      settler_address: settler.address.toLowerCase(),
      payment_request_json: JSON.stringify(paymentRequest),
    },
    rawKeySettlerProofSigner(SETTLER_KEY),
    { verificationMethod },
  );
  const quoteJson = JSON.stringify(signedQuote);

  const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
  const transfer = {
    from: settler.address,
    to: RECIPIENT,
    value: BigInt(AMOUNT),
    validAfter: 0n,
    validBefore: DEADLINE_SECONDS,
    nonce: quoteHash,
  };

  // The settler's planOriginatorFulfill, then publishOriginatorAuthorization, with a local key.
  // `signingDomain` is the EIP-712 domain the settler signs under; the default is the destination
  // token's, and the domain vectors sign under another one.
  async function settlerSigned(message: typeof transfer, signer: Wallet = settler, signingDomain: typeof domain = domain) {
    const signature = await signer.signTypedData(signingDomain, EIP3009_TRANSFER_WITH_AUTHORIZATION_TYPES, message);
    return signFulfillmentAuthorizationWithSigner(
      {
        version: "1.0",
        scheme: "EIP-3009",
        authorization: {
          message: eip3009AuthorizationHash(signingDomain, message),
          message_prehash: eip3009MessagePrehash(signingDomain, message),
          signature,
        },
        fulfillment_quote_json: quoteJson,
        evidence: { transaction_id: `0x${"ab".repeat(32)}`, log_index: 7 },
      },
      rawKeySettlerProofSigner(SETTLER_KEY),
      verificationMethod,
    );
  }

  const base = await settlerSigned(transfer);
  const { "@context": _context, type: _type, proof: _proof, ...declaration } = base;
  void _context;
  void _type;
  void _proof;

  const tamperedNonce = structuredClone(base);
  const prehash = JSON.parse(tamperedNonce.authorization.message_prehash);
  prehash.message.nonce = `0x${"11".repeat(32)}`;
  tamperedNonce.authorization.message_prehash = JSON.stringify(prehash);

  const payloadOnly = structuredClone(base) as Record<string, any>;
  const signed = JSON.parse(base.authorization.message_prehash).message;
  payloadOnly.authorization = {
    message: base.authorization.message,
    signature: base.authorization.signature,
    payload: {
      from: signed.from,
      to: signed.to,
      value: signed.value,
      asset: ASSET,
      nonce: signed.nonce,
      valid_before: Number(signed.validBefore),
    },
  };

  const wrongType = { ...structuredClone(base), type: "FulfillmentQuote" };

  // A contract (ERC-1271) signature: not 65 bytes, so it cannot be recovered offline. Every token
  // in the EIP-3009 list verifies through SignatureChecker, which sends a signer with code to its
  // isValidSignature, so the chain can accept this. Refused by default all the same, because
  // nothing here can tell a contract settler from an EOA one and a pass would stop proving the
  // settler signed (CORE-2955); accepted under AllowContractSignature, on the token's authority.
  // chain-vectors.json judges it, and the other signature vectors, with a chain reader; that
  // manifest is written by hand, since it names no new document.
  const contractSignature = structuredClone(base) as Record<string, any>;
  contractSignature.authorization.signature = `0x${"ab".repeat(96)}`;

  // The first of CORE-2955's reproduction cases: a signature too short to be anything, on a
  // settler that is an EOA. Before the strict default this passed, unverified.
  const shortSignature = structuredClone(base) as Record<string, any>;
  shortSignature.authorization.signature = "0x11";

  // An empty signature is refused in both languages and in both modes: there is nothing for
  // either the validator or the chain to check.
  const emptySignature = structuredClone(base) as Record<string, any>;
  emptySignature.authorization.signature = "0x";

  // A document whose quote carries a twin: the quote hash and the settler's proof both ignore it,
  // because URDNA2015 drops members the context does not define, so only a scan can refuse it.
  const quoteTwin = {
    ...base,
    fulfillment_quote_json: insertMember(quoteJson, "", '"Settler_Address":"0x0000000000000000000000000000000000000009"'),
  };
  // The twin goes into the request's own text, which is then re-embedded: payment_request_json
  // carries the request as a string, so inserting into the quote's text would land inside it.
  const requestTwin = {
    ...base,
    fulfillment_quote_json: JSON.stringify({
      ...signedQuote,
      payment_request_json: insertMember(JSON.stringify(paymentRequest), "", '"Fulfillment_Deadline":"2031-01-02T00:00:00.335Z"'),
    }),
  };

  const recoveryIdZero = structuredClone(base);
  recoveryIdZero.authorization.signature = `${base.authorization.signature.slice(0, -2)}00`;

  const requestMissingEscrow = {
    ...base,
    fulfillment_quote_json: JSON.stringify({
      ...signedQuote,
      payment_request_json: JSON.stringify(withoutMember(paymentRequest, "escrow_contract_address")),
    }),
  };

  const vectors: Array<Vector & ({ document: unknown } | { text: string })> = [
    {
      file: "settler-signed.json",
      valid: true,
      description: "Identity-signed FulfillmentAuthorization as the settler publishes it; validBefore is the floored fulfillment deadline.",
      document: base,
    },
    {
      file: "settler-signed-declaration-only.json",
      valid: true,
      description: "The same document without @context, type and proof.",
      document: declaration,
    },
    {
      file: "expiry-after-deadline.json",
      valid: false,
      description: "Signed by the settler with validBefore one second after the fulfillment deadline.",
      error_contains: "after the fulfillment deadline",
      document: await settlerSigned({ ...transfer, validBefore: DEADLINE_SECONDS + 1n }),
    },
    {
      file: "expiry-before-deadline.json",
      valid: false,
      description: "Signed by the settler with validBefore one second before the fulfillment deadline.",
      error_contains: "before the fulfillment deadline",
      document: await settlerSigned({ ...transfer, validBefore: DEADLINE_SECONDS - 1n }),
    },
    {
      file: "valid-after-after-valid-before.json",
      valid: false,
      description: "Signed by the settler with validAfter later than validBefore. EIP-3009 pins validAfter to 0, so that rule refuses it first.",
      error_contains: "validAfter must be 0",
      document: await settlerSigned({ ...transfer, validAfter: DEADLINE_SECONDS + 1n }),
    },
    {
      file: "nonce-not-quote-hash.json",
      valid: false,
      description: "Signed by the settler with a nonce that is not the embedded quote's hash.",
      error_contains: "does not equal quote hash",
      document: await settlerSigned({ ...transfer, nonce: `0x${"22".repeat(32)}` }),
    },
    {
      file: "domain-chain-not-destination.json",
      valid: false,
      description:
        "Signed by the settler under Base mainnet's chain id (8453) for a quote whose destination is Base Sepolia (84532). On chain the token would reject it, since chainId is in the domain separator; here the domain is bound to the destination so a pass means the authorization is for this payment (CORE-2991).",
      error_contains: "domain.chainId 8453 is not the quote destination's chain eip155:84532",
      document: await settlerSigned(transfer, settler, { ...domain, chainId: OTHER_CHAIN_ID }),
    },
    {
      file: "domain-contract-not-destination.json",
      valid: false,
      description:
        "Signed by the settler under another token's address as verifyingContract, for a quote whose destination is Base Sepolia USDC. Same binding as the chain id vector, on the other domain field.",
      error_contains: `domain.verifyingContract ${OTHER_USDC} is not the quote destination's token ${USDC}`,
      document: await settlerSigned(transfer, settler, { ...domain, verifyingContract: OTHER_USDC }),
    },
    {
      file: "domain-contract-lowercase.json",
      valid: true,
      description:
        "Signed by the settler with verifyingContract in lower case while the quote's destination is checksummed. The same token: the domain is compared as the asset and recipient are, folded, not by string equality.",
      document: await settlerSigned(transfer, settler, { ...domain, verifyingContract: USDC.toLowerCase() }),
    },
    {
      file: "tampered-nonce.json",
      valid: false,
      description: "settler-signed.json with message_prehash's nonce edited after signing.",
      error_contains: "is not the EIP-712 digest of message_prehash",
      document: tamperedNonce,
    },
    {
      file: "signer-not-settler.json",
      valid: false,
      description: "A valid EIP-3009 authorization from an account that is not the quote's settler_address.",
      error_contains: "does not equal settler_address",
      document: await settlerSigned({ ...transfer, from: other.address }, other),
    },
    {
      file: "signature-not-from.json",
      valid: false,
      description: "message.from is the settler but another key signed the typed data.",
      error_contains: "recovers to",
      document: await settlerSigned(transfer, other),
    },
    {
      file: "valid-after-nonzero.json",
      valid: false,
      description: "Signed by the settler with validAfter a minute before validBefore: executable, but it shortens the window the originator was quoted.",
      error_contains: "validAfter must be 0",
      document: await settlerSigned({ ...transfer, validAfter: DEADLINE_SECONDS - 60n }),
    },
    {
      file: "recovery-id-zero.json",
      valid: false,
      description: "settler-signed.json with the signature's recovery id written as 0 instead of 27, which FiatToken's ECRecover reverts on.",
      error_contains: "accepts only 27 and 28",
      document: recoveryIdZero,
    },
    {
      file: "authorization-unknown-member.json",
      valid: false,
      description: "An extra member in the authorization, which no signature covers and no rule reads.",
      error_contains: "unknown member",
      document: { ...base, authorization: { ...base.authorization, note: "pay me instead" } },
    },
    {
      file: "document-ambiguous-member.json",
      valid: false,
      description: "scheme written twice with the same value. An exact duplicate is the case no other rule can see: every value stays what the settler signed, so the digest still matches and additionalProperties has nothing to flag.",
      error_contains: "ambiguous member",
      text: insertMember(`${JSON.stringify(base, null, 2)}\n`, "", '"scheme": "EIP-3009"'),
    },
    {
      file: "quote-ambiguous-member.json",
      valid: false,
      description: "A Settler_Address twin inside the embedded quote. The quote hash and the settler's proof both ignore it, so only a scan refuses it.",
      error_contains: "ambiguous member",
      document: quoteTwin,
    },
    {
      file: "request-ambiguous-member.json",
      valid: false,
      description: "A Fulfillment_Deadline twin inside the embedded payment request, which is what this PR's expiry rule reads.",
      error_contains: "ambiguous member",
      document: requestTwin,
    },
    {
      file: "prehash-ambiguous-member.json",
      valid: false,
      description: "validAfter written twice inside the signed prehash with the same value, so the digest still matches and only the scan refuses it.",
      error_contains: "ambiguous member",
      document: {
        ...base,
        authorization: {
          ...base.authorization,
          message_prehash: insertMember(base.authorization.message_prehash, '"message":', '"validAfter":"0"'),
        },
      },
    },
    {
      file: "no-evidence.json",
      valid: false,
      description: "The declaration without evidence, which schema.json requires.",
      error_contains: "evidence",
      document: withoutMember(base, "evidence"),
    },
    {
      file: "log-index-negative.json",
      valid: false,
      description: "A negative evidence log_index, below the schema's minimum.",
      error_contains: "log_index",
      document: { ...base, evidence: { ...base.evidence, log_index: -1 } },
    },
    {
      file: "version-unsupported.json",
      valid: false,
      description: "A version outside this schema's major, which its pattern refuses.",
      error_contains: "version",
      document: { ...base, version: "2.0" },
    },
    {
      file: "extra-top-level-member.json",
      valid: false,
      description: "An extra top-level member; the declaration sets additionalProperties false.",
      error_contains: "additional",
      document: { ...base, settled: true },
    },
    {
      file: "request-missing-escrow-contract-address.json",
      valid: false,
      description: "The embedded request without escrow_contract_address, which Go's generated type requires.",
      error_contains: "escrow_contract_address",
      document: requestMissingEscrow,
    },
    {
      file: "payload-only.json",
      valid: false,
      description: "The transfer carried in authorization.payload with no message_prehash, the shape the validator read before CORE-2804.",
      error_contains: "must not carry payload",
      document: payloadOnly,
    },
    {
      file: "wrong-type.json",
      valid: false,
      description: "settler-signed.json with its JSON-LD type changed.",
      error_contains: "type must be",
      document: wrongType,
    },
    {
      file: "contract-signature.json",
      valid: false,
      description: "Signed by the settler, then given a signature that is not 65 bytes, as an ERC-1271 contract wallet produces. Refused by default, because nothing offline proves the settler signed it; accepted on the token's authority when the caller allows contract signatures.",
      error_contains: "must be 65 bytes",
      contract_signatures_allowed: { valid: true },
      document: contractSignature,
    },
    {
      file: "short-signature.json",
      valid: false,
      description: "Signed by the settler, then given a one-byte signature. The settler here is an EOA, so by default this must be refused rather than read as a contract signature.",
      error_contains: "must be 65 bytes",
      contract_signatures_allowed: { valid: true },
      document: shortSignature,
    },
    {
      file: "empty-signature.json",
      contract_signatures_allowed: { valid: false, error_contains: "empty" },
      valid: false,
      description: "Signed by the settler, then given an empty signature.",
      error_contains: "signature",
      document: emptySignature,
    },
  ];

  mkdirSync(outDir, { recursive: true });
  for (const vector of vectors) {
    const body = "text" in vector ? vector.text : `${JSON.stringify(vector.document, null, 2)}\n`;
    writeFileSync(join(outDir, vector.file), body);
  }
  const manifest = vectors.map(({ file, valid, description, error_contains, contract_signatures_allowed }) => ({
    file,
    valid,
    description,
    ...(error_contains === undefined ? {} : { error_contains }),
    ...(contract_signatures_allowed === undefined ? {} : { contract_signatures_allowed }),
  }));
  writeFileSync(join(outDir, "vectors.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A shallow copy without one member, for the vectors that test a required member's absence. */
function withoutMember<T extends Record<string, unknown>>(value: T, member: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[member];
  return copy;
}

// The settler stamps proof.created with the current time; pin it so the output is reproducible.
function pinClock(iso: string): void {
  const fixed = Date.parse(iso);
  const RealDate = Date;
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...((args.length === 0 ? [fixed] : args) as ConstructorParameters<typeof Date>));
    }
    static now(): number {
      return fixed;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
}

await main();
