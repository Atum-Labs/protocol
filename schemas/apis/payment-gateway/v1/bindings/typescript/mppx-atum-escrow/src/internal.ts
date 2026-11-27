/**
 * Shared internals for the Atum escrow MPP method: the wire schemas, the method
 * definition, the shared types, and the pure chain/address helpers used by both
 * the payer ({@link ./client}) and merchant ({@link ./server}) sides.
 *
 * This module is not a public entry point — consumers import from the package
 * root, `/client`, or `/server`. The helpers here are exported only so the
 * client and server modules can share them.
 *
 * @internal
 */

import * as z from 'zod/mini';
import { normalizeAddress as normalizeTronAddress } from '@atum-labs/tvm-escrow-encoding';
import { deterministicRequestId, resolveTronPermit2 } from '@atum-labs/payment-request-sender-auth';
// `PaymentRequest` here is the framework's base64url metadata codec (the `opaque` encoding),
// unrelated to the Atum PaymentRequest declaration imported further down under the same name.
import { Method, PaymentRequest as OpaqueCodec } from 'mppx';
import type { Challenge, Credential } from 'mppx';
import type { ChainDefaults } from '@atum-labs/payment-gateway-client';
import type { PaymentRequest } from '@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript';
import type { AtumEscrowExtra, AtumEscrowRequest } from '@atum-labs/atum-escrow';

export type { PaymentRequest, AtumEscrowExtra, AtumEscrowRequest };

/** The method name advertised in MPP challenges and credentials. */
export const METHOD_NAME = 'atum-escrow';
/** The MPP intent this method implements. */
export const INTENT = 'charge';

/**
 * Challenge-metadata key carrying the merchant's per-intent payment identifier.
 *
 * The payer derives the payment's `request_id` from this value, and the gateway
 * de-duplicates on that `request_id`. So the key's lifetime defines what counts as "the same
 * payment": one value per thing being bought, reused on every retry of that purchase, never
 * shared between two purchases.
 *
 * It rides in challenge metadata rather than in the charge request because it identifies the
 * purchase, not its terms — two sequential orders for the same item have identical terms and
 * must still be two payments. Metadata is covered by the challenge-id HMAC, so a payer cannot
 * substitute another intent's identifier to have a second purchase resolve onto an
 * already-settled payment.
 *
 * Prefixed to keep it distinct from a merchant's own metadata and from the framework's
 * reserved keys.
 */
export const INTENT_ID_META_KEY = 'atumIntentId';

/**
 * Prefix every `request_id` this method emits carries, marking MPP-originated payments in
 * gateway and settler logs. Not hashed, but part of the id — so it is pinned here rather than
 * written out at each call site, and the merchant's check below reproduces the full id exactly.
 */
export const REQUEST_ID_PREFIX = 'req_mpp_';

/**
 * Derive a charge's `request_id` — the payment's identity at the gateway, which de-duplicates on
 * it. The payer derives it when building the credential; the merchant re-derives it during
 * verification to confirm the payment really is anchored to the purchase it is paying for.
 *
 * Sharing one function is what keeps those two from drifting into a check that passes everything.
 * The digest itself comes from the shared sender_auth SDK — the same implementation the settlement
 * backend links against — so the recipe cannot fork per language.
 *
 * @param intentId - the challenge's per-purchase identifier
 * @param account - the source account paying
 */
export function chargeRequestId(intentId: string, account: string): string {
  return deterministicRequestId({ anchor: intentId, account, prefix: REQUEST_ID_PREFIX });
}

/**
 * Read the per-intent identifier from a challenge, from either place it can live.
 *
 * A challenge constructed in-process carries parsed `meta`; one parsed from a
 * `WWW-Authenticate` header carries only the serialized `opaque` form, and the framework
 * hydrates `meta` from it on the merchant side but not on the payer side. Both are checked
 * here so payer and merchant read the same value from the same challenge.
 *
 * `opaque` is merchant-defined and need not be a metadata map at all, so decoding it is
 * best-effort: anything that is not a string-valued map with this key reads as absent.
 *
 * @returns the identifier, or undefined when the challenge carries none.
 */
export function intentIdOf(challenge: {
  meta?: Record<string, string> | undefined;
  opaque?: string | undefined;
}): string | undefined {
  const fromMeta = challenge.meta?.[INTENT_ID_META_KEY];
  if (typeof fromMeta === 'string' && fromMeta !== '') {
    return fromMeta;
  }
  if (challenge.opaque === undefined) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = OpaqueCodec.deserialize(challenge.opaque);
  } catch {
    return undefined;
  }
  if (typeof decoded !== 'object' || decoded === null) {
    return undefined;
  }
  const value = (decoded as Record<string, unknown>)[INTENT_ID_META_KEY];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/* ─────────────────────────────── Wire schemas ─────────────────────────────── */

/**
 * Schema for the `charge` challenge request — the method-specific data a merchant
 * publishes in an MPP `402` challenge. It describes what the merchant receives and the
 * source option the payer may fund from, so the payer can build the payment offline.
 */
export const ChargeRequestSchema = z.object({
  /** The source chain/token/cap the payer funds from (one option per challenge). */
  source: z.object({
    /** CAIP-2 source chain id (e.g. `eip155:8453`, `tron:mainnet`, `solana:<genesis>`). */
    network: z.string(),
    /** Source token address (EVM hex or base58). */
    asset: z.string(),
    /** Source spend cap (fulfillmentAmount + markup), atomic units — the authoritative `max_source_amount`. */
    amount: z.string(),
  }),
  /** The destination/corridor block (the reused x402 `extra`). */
  extra: z.object({
    /** Where the merchant receives: CAIP-2 chain, token, and receive address. */
    destination: z.object({
      network: z.string(),
      asset: z.string(),
      address: z.string(),
    }),
    /** Exact amount the merchant receives, in atomic units of the destination token. */
    fulfillmentAmount: z.string(),
    /** Source-chain escrow contract for this option; the payer's funds lock here. */
    escrow: z.string(),
    /** Destination-chain fulfillment-proxy contract. */
    fulfillmentProxy: z.string(),
    /** Role address that witnesses the escrow deposit on reservation. */
    reserver: z.string(),
    /** Role address that witnesses the escrow release on fulfillment. */
    releaser: z.string(),
    /** Endpoint used to verify fulfillment on the source chain. */
    fulfillmentVerifierEndpoint: z.string(),
    /** Quote-deadline budget in seconds, relative to signing time. */
    quoteDeadlineSeconds: z.number(),
    /** Fulfillment-deadline budget in seconds, relative to signing time. */
    fulfillmentDeadlineSeconds: z.number(),
    /** Solana-only: cluster id that domain-separates the deposit authorization. */
    svmSignatureClusterId: z.optional(z.string()),
    /**
     * Solana-only: signature domain version that domain-separates the deposit authorization.
     * Bounded 1–255 to match the wire schema (a uint8 the escrow's V3 domain uses).
     */
    svmSignatureDomainVersion: z.optional(z.number().check(z.gte(1), z.lte(255))),
    /**
     * Solana-only: merchant-stamped issue time (epoch seconds). When present, the client
     * stamps the deposit's `issued_at` from it so the 402 is self-contained (no client RPC).
     * Digits-only, matching the wire schema — so the client's `BigInt(issuedAt)` can never
     * throw on a non-numeric value or silently coerce `""`/whitespace to the Unix epoch.
     */
    issuedAt: z.optional(z.string().check(z.regex(/^[0-9]+$/))),
    /**
     * The depositRequestHash versions the payer may sign, as the x402 `extra` defines them: 1 is
     * keccak256 of the request_id, 2 is the hash of the payment terms. Absent means `[1]`. Declared
     * here because the object drops what it does not declare, and the client reads it.
     */
    depositRequestHashVersions: z.optional(
      // A tuple with a rest element: at least one version, typed as the x402 binding types it.
      z.tuple([z.int().check(z.gte(1))], z.int().check(z.gte(1))).check(
        z.refine((versions) => new Set(versions).size === versions.length, {
          message: 'depositRequestHashVersions must not repeat a version',
        }),
      ),
    ),
  }),
});

/**
 * Schema for the `charge` credential payload — the signed payment the payer returns in
 * the MPP credential. It carries the Atum payment request; the request's signatures and
 * terms are verified in full during server verification and by the Atum Payment Gateway,
 * so this envelope validates only that the request is present.
 */
export const CredentialPayloadSchema = z.object({
  paymentRequest: z.record(z.string(), z.unknown()),
});

/**
 * The `charge` challenge request — the canonical `AtumEscrowRequest` shape (source option
 * + the destination/corridor `extra`), plus the Solana issue time this scheme stamps.
 *
 * `issuedAt` is declared here rather than borrowed, because the shared x402 `extra` contract
 * does not carry it: an x402 resource server rebuilds its requirements on the paid request and
 * compares them against what the payer echoed, which no clock reading survives. MPP has no such
 * rebuild, so a merchant-stamped issue time remains coherent here — and is declared where it is
 * emitted ({@link buildChargeRequest}) rather than inherited from a contract that dropped it.
 */
export type ChargeRequest = Omit<AtumEscrowRequest, 'extra'> & {
  extra: AtumEscrowExtra & { issuedAt?: string };
};

// Compile-time guard: the runtime schema must stay structurally identical to the type this
// package publishes. If either side changes shape, this stops compiling.
//
// It is blind to a property that is optional on one side only — mutual assignability treats
// `{x}` and `{x; y?}` as equivalent — so it catches a renamed or retyped field, not an added
// optional one.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _chargeRequestMatchesSchema: Exact<z.infer<typeof ChargeRequestSchema>, ChargeRequest> = true;
void _chargeRequestMatchesSchema;

/** The `charge` credential payload, carrying the signed Atum payment request. */
export interface ChargeCredentialPayload {
  /** The signed Atum payment request: source/destination, amounts, and authorizations. */
  paymentRequest: PaymentRequest;
}

/**
 * The MPP challenge for this method. Uses the schema's inferred type for the request
 * (equal to {@link ChargeRequest} by the compile-time guard above, and compatible with
 * the framework's `Record<string, unknown>` request constraint).
 */
export type AtumEscrowChallenge = Challenge.Challenge<
  z.infer<typeof ChargeRequestSchema>,
  'charge',
  'atum-escrow'
>;
/** The MPP credential for this method. */
export type AtumEscrowCredential = Credential.Credential<
  ChargeCredentialPayload,
  AtumEscrowChallenge
>;

/* ──────────────────────────── Method definition ────────────────────────────── */

/**
 * The base `atum-escrow` charge method. Extend it with `registerClient` on the payer side
 * and `registerServer` on the merchant side.
 */
export const atumEscrowChargeMethod = Method.from({
  name: METHOD_NAME,
  intent: INTENT,
  schema: {
    request: ChargeRequestSchema,
    credential: { payload: CredentialPayloadSchema },
  },
});

/* ─────────────────────── Shared chain / address helpers ─────────────────────── */

/** The CAIP-2 namespace of a network id (the part before the first colon). */
export function namespaceOf(network: string): string {
  return network.split(':')[0];
}

/** CAIP-19 asset-type label for a network's namespace. */
export function assetTypeFor(network: string): string {
  switch (namespaceOf(network)) {
    case 'eip155':
      return 'erc20';
    case 'tron':
      return 'trc20';
    case 'solana':
      // `spl`, matching x402-atum-escrow's adapter and the live settler chain-plugin configs.
      // ONCHAIN_SPEC.md ratifies `token` for the destination grammar, so these disagree; see
      // schemas/apis/x402/v1/bindings/x402-atum-escrow/src/chain-adapters/solana.ts for why
      // that is safe today (the destination is derived once and transported verbatim, so both
      // signers hash the same bytes) and what a convergence would need. Do not "fix" only one
      // of the two SDKs.
      return 'spl';
    default:
      throw new Error(`atum-escrow: unsupported network '${network}'`);
  }
}

/** Compose a CAIP-19 asset identifier (`<caip2>/<type>:<address>`) from a network + token. */
export function assetIdentifier(network: string, asset: string): string {
  return `${network}/${assetTypeFor(network)}:${asset}`;
}

/**
 * Cross-chain address equality. EVM addresses are hex and compared case-insensitively
 * (EIP-55 is a case-only checksum, so `0xABC…` and `0xabc…` are the same address). Base58
 * addresses — Tron `T…` and, critically, Solana pubkeys — are case-sensitive: lowercasing
 * one yields a *different, still-decodable* value (Solana pubkeys carry no checksum), so
 * they must match exactly. A case-insensitive compare there would accept a byte-distinct
 * address on the signature-unprotected routing fields that verify() guards.
 */
export function sameAddress(a: string, b: string): boolean {
  // Same reason as the identifier parser below. These compare payer supplied fields that arrive
  // untyped, so a value that is not a string is not the same address as anything, and saying so
  // lets the caller report its own mismatch instead of surfacing a type error.
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  if (a.startsWith('0x') && b.startsWith('0x')) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Chain-aware address equality, keyed by the CAIP-2 chain the addresses live on. Unlike
 * {@link sameAddress}, which compares values that are both already in one spelling, this compares
 * a merchant's challenge with a trust source that may write the same Tron address as base58 or as
 * hex, so Tron addresses are normalized before comparing. EVM folds case; Solana base58 must match
 * exactly.
 */
export function caipEqual(caip2: string, a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const namespace = caip2.split(':')[0];
  if (namespace === 'eip155') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (namespace === 'tron') {
    try {
      return normalizeTronAddress(a).toLowerCase() === normalizeTronAddress(b).toLowerCase();
    } catch {
      return false; // a malformed address never matches
    }
  }
  return a === b;
}

/**
 * CAIP-19 equality for the same signature-unprotected routing fields. Both namespaces fold, since
 * CAIP pins them lowercase, and a tron chain reference folds because it is an ASCII cluster name,
 * which is also what the payment client emits. The token reference goes through `sameAddress`, and a
 * solana chain reference is compared exactly, so no base58 value is ever folded into a different one.
 */
export function sameAssetIdentifier(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = splitAssetIdentifier(a);
  const pb = splitAssetIdentifier(b);
  if (!pa || !pb || pa.namespace !== pb.namespace || pa.assetNamespace !== pb.assetNamespace) {
    return false;
  }
  const referenceMatches =
    pa.namespace === 'solana'
      ? pa.reference === pb.reference
      : pa.reference.toLowerCase() === pb.reference.toLowerCase();
  return referenceMatches && sameAddress(pa.token, pb.token);
}

function splitAssetIdentifier(identifier: string) {
  // The payer's identifier reaches verify() through a cast over a schema that types the payment
  // request as unknown values, so it can be any type at runtime. Refusing it as unparseable keeps
  // the caller's mismatch error instead of a type error from the line below.
  if (typeof identifier !== 'string') return undefined;

  const slash = identifier.indexOf('/');
  if (slash < 0) return undefined;
  const chain = identifier.slice(0, slash);
  const asset = identifier.slice(slash + 1);
  const chainColon = chain.indexOf(':');
  const assetColon = asset.indexOf(':');
  if (chainColon < 0 || assetColon < 0) return undefined;
  return {
    namespace: chain.slice(0, chainColon).toLowerCase(),
    reference: chain.slice(chainColon + 1),
    assetNamespace: asset.slice(0, assetColon).toLowerCase(),
    token: asset.slice(assetColon + 1),
  };
}

/** Map the challenge `extra` into the gateway client's ChainDefaults shape (offline build). */
export function chainDefaultsFromExtra(extra: AtumEscrowExtra, network: string): ChainDefaults {
  return {
    escrowContract: extra.escrow,
    quoteSelector: extra.reserver,
    fulfillmentVerifierAccount: extra.releaser,
    fulfillmentVerifierEndpoint: extra.fulfillmentVerifierEndpoint,
    fulfillmentProxy: extra.fulfillmentProxy,
    // Pin the Tron Permit2 so the adapter signs against the canonical address (the same one
    // verify() rebuilds against), never leaving it to the adapter's internal fallback. The
    // address is fixed per-network (not carried on the wire) — see resolveTronPermit2.
    ...(namespaceOf(network) === 'tron' ? { permit2Contract: resolveTronPermit2(network) } : {}),
    ...(extra.svmSignatureClusterId ? { svmSignatureClusterId: extra.svmSignatureClusterId } : {}),
    ...(extra.svmSignatureDomainVersion != null
      ? { svmSignatureDomainVersion: extra.svmSignatureDomainVersion }
      : {}),
    // v2 only when the merchant lists it; an absent list means [1], the builder's default.
    ...(extra.depositRequestHashVersions?.includes(2) ? { depositRequestHashVersion: 2 } : {}),
  };
}

// The Tron Permit2 address map + resolver now live in the shared
// @atum-labs/payment-request-sender-auth SDK (single source, shared with pgc + x402).
// Re-exported here so the client and server keep importing it from `./internal`.
export { resolveTronPermit2 };

/**
 * Chain-specific rewrite of the request-body routing fields (`quote_selector`,
 * `fulfillment_verifier`) that verify() compares the credential against. Only Tron needs it:
 * its `/defaults` addresses are base58 (`T…`) but the on-chain verifier and the signed
 * permit witness use canonical 20-byte hex, so the reserver/releaser are normalized to
 * match. EVM (and Solana, which routes through the deposit hash, not these fields) need no
 * rewrite and return undefined. Mirrors the payment-gateway client's internal Tron adapter
 * so the client build and this verify never diverge.
 */
export function contractOverridesFromExtra(
  network: string,
  extra: AtumEscrowExtra,
):
  | { quote_selector: string; fulfillment_verifier: { account: string; endpoint: string } }
  | undefined {
  if (namespaceOf(network) !== 'tron') {
    return undefined;
  }
  return {
    quote_selector: normalizeTronAddress(extra.reserver),
    fulfillment_verifier: {
      account: normalizeTronAddress(extra.releaser),
      endpoint: extra.fulfillmentVerifierEndpoint,
    },
  };
}

// evmChainId / tronNumericChainId / clusterIdFromName previously lived here for the
// server-side sender_auth verification. Verification now runs through the shared
// @atum-labs/payment-request-sender-auth SDK, which owns those chain-id helpers, so the
// local copies were removed (single source).
