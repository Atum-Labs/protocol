import { getAddress } from 'ethers';

/**
 * CAIP-19 asset identifier parsing, backing the caller-facing entry points.
 *
 * Every caller-facing entry point parses here first. Downstream, the deposit builders read an
 * identifier as raw string slicing (`asset.split('/')[1]!.split(':')[1]!`) and hand the result to
 * `ethers`, which can only report a bad value as a TypeError or as `invalid address`, so the value
 * has to be named and explained before it gets there. Parsing also canonicalizes the segments CAIP
 * requires lowercase.
 */

/** An asset identifier split into its parts, canonicalized. */
export interface ParsedAssetIdentifier {
  /** CAIP-2 chain id, namespace lowercased: `eip155:421614`. */
  chainId: string;
  /** Lowercased CAIP-2 namespace: `eip155`, `tron`, `solana`. */
  namespace: string;
  /**
   * CAIP-2 chain reference, canonicalized per namespace, mirroring `manifest.CanonicalizeCAIP2`.
   * A tron reference is an ASCII cluster name and folds to lowercase, so `TRON:MAINNET` routes
   * instead of dying at a Permit2 lookup that resolves by exact chain id. A solana reference is
   * preserved: it is base58, and its cluster name is UTF-8 encoded into the escrow's on-chain
   * `cluster_id`, so folding it would change the signing domain.
   */
  reference: string;
  /** Lowercased asset namespace: `erc20`, `trc20`, `token`, … */
  assetNamespace: string;
  /** Token address, exactly as the caller wrote it. */
  tokenAddress: string;
  /** CAIP-19 token id, for the asset types that carry one. */
  tokenId?: string;
  /**
   * The identifier with the namespaces lowercased and a tron reference folded with them. The
   * PaymentRequest schema pins `asset_identifier` to lowercase namespaces, so this is the spelling
   * that goes on the wire and into the deposit builders.
   *
   * Aligned with `manifest.CanonicalizeCAIP2`, not with `blockchain.AssetIdentifier.String()`,
   * which preserves the asset namespace this lowercases. Aligning to `String()` is not an option:
   * the schema pattern rejects an uppercase asset namespace, so Go's own `ComputeRequestHash`
   * refuses to hash one.
   *
   * Not a commitment preimage. `ComputeRequestHash` covers this string verbatim, so the spelling is
   * the request's identity, but anything that hashes a CAIP-19 across independent producers has to
   * derive it from one shared implementation rather than from here, since the escrow's destination
   * commitment composes and folds the string on different rules.
   */
  normalized: string;
}

const SHAPE_EXAMPLE = 'eip155:421614/erc20:0x...';

// The segment charsets the canonical PaymentRequest schema publishes for asset_identifier
// (schemas/declarations/PaymentRequest/v1/schema.json). A value this parser accepts is one the
// gateway's schema accepts, so nothing is refused remotely that could be named here.
const NAMESPACE = /^[a-z0-9]+$/;
const CHAIN_REFERENCE = /^[a-zA-Z0-9_-]+$/;
const ASSET_NAMESPACE = /^[a-z0-9-]{3,8}$/;
const ASSET_REFERENCE = /^[-.%a-zA-Z0-9]{1,128}$/;
const TOKEN_ID = /^[-.%a-zA-Z0-9]{1,78}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// An eip155 chain reference is a decimal chain id. `parseInt` accepts `0x66eee` and yields
// 421614, so a hex spelling would sign a permit for a domain the identifier does not state.
const EIP155_REFERENCE = /^[0-9]+$/;
// Recognized only to name the decimal the caller almost certainly meant. Bounded, because past a
// plausible chain id that decimal is not worth naming.
const HEX_REFERENCE = /^0[xX][0-9a-fA-F]{1,16}$/;

/** Longest value echoed back in a message, so a huge argument cannot flood the error or the logs. */
const MAX_ECHO = 120;
/** Tighter, since a reference is echoed alongside the whole identifier it came from. */
const MAX_REFERENCE_ECHO = 32;

/**
 * Parse and validate a CAIP-19 asset identifier.
 *
 * The two namespaces are lowercased, and a tron chain reference with them. A solana reference, the
 * token address and the token id are returned as written, so a case-sensitive base58 value
 * survives. Their case still matters:
 * `ComputeRequestHash` covers the spelling verbatim, so two spellings of one asset give two
 * different `request_hash` values while leaving the deposit digest identical.
 */
export function parseAssetIdentifier(value: unknown): ParsedAssetIdentifier {
  if (typeof value !== 'string' || value === '') {
    throw new Error(shapeError(value));
  }

  const firstSlash = value.indexOf('/');
  if (firstSlash === -1) {
    throw new Error(shapeError(value));
  }

  const chainSegments = value.slice(0, firstSlash).split(':');
  if (chainSegments.length !== 2) {
    throw new Error(shapeError(value));
  }
  const namespace = chainSegments[0]!.toLowerCase();
  const reference = namespace === 'tron' ? chainSegments[1]!.toLowerCase() : chainSegments[1]!;
  if (!NAMESPACE.test(namespace) || !CHAIN_REFERENCE.test(reference)) {
    throw new Error(shapeError(value));
  }
  if (namespace === 'eip155' && !EIP155_REFERENCE.test(reference)) {
    throw new Error(eip155ReferenceError(reference, value));
  }

  const assetPart = value.slice(firstSlash + 1);
  const separator = assetPart.indexOf(':');
  if (separator === -1) {
    throw new Error(tokenAddressError(value));
  }
  const assetNamespace = assetPart.slice(0, separator).toLowerCase();
  // CAIP-19 allows a token id after the reference (`erc721:<contract>/<id>`), so the address is
  // the reference up to the next slash and anything beyond it is that id.
  const rest = assetPart.slice(separator + 1);
  const referenceSlash = rest.indexOf('/');
  const tokenAddress = referenceSlash === -1 ? rest : rest.slice(0, referenceSlash);
  const tokenId = referenceSlash === -1 ? undefined : rest.slice(referenceSlash + 1);
  if (!ASSET_NAMESPACE.test(assetNamespace)) {
    throw new Error(tokenAddressError(value));
  }
  // A native asset has no contract to deposit, so it cannot be a source or destination here.
  // Before the reference checks, whose spelling is beside the point for an asset with no contract.
  if (assetNamespace === 'slip44') {
    throw new Error(nativeAssetError(value));
  }
  if (!ASSET_REFERENCE.test(tokenAddress)) {
    throw new Error(tokenAddressError(value));
  }
  if (tokenId !== undefined && !TOKEN_ID.test(tokenId)) {
    throw new Error(tokenAddressError(value));
  }
  assertTokenAddress(namespace, tokenAddress, value);

  const chainId = `${namespace}:${reference}`;
  return {
    chainId,
    namespace,
    reference,
    assetNamespace,
    tokenAddress,
    ...(tokenId === undefined ? {} : { tokenId }),
    normalized: `${chainId}/${assetNamespace}:${tokenAddress}${tokenId === undefined ? '' : `/${tokenId}`}`,
  };
}

/**
 * The CAIP-2 chain id with its namespace lowercased, for callers that only need to route on the
 * chain. Applies the same validation, so a malformed identifier fails with the same message.
 */
export function assetChainId(value: unknown): string {
  return parseAssetIdentifier(value).chainId;
}

function echo(value: unknown, limit = MAX_ECHO): string {
  const shown = typeof value === 'string' ? value : String(value);
  return shown.length > limit ? `${shown.slice(0, limit)}…` : shown;
}

function shapeError(value: unknown): string {
  return `Invalid asset identifier "${echo(value)}": expected CAIP-19 "<chain>/<type>:<address>", e.g. ${SHAPE_EXAMPLE}`;
}

function tokenAddressError(value: string): string {
  return `Invalid token address in asset "${echo(value)}".`;
}

/**
 * Names the decimal chain id for a caller holding a hex one, and the rule for anything else.
 * `BigInt` keeps that decimal exact, where `parseInt` starts rounding above 2^53 and would state a
 * chain id nobody has.
 */
function eip155ReferenceError(reference: string, value: string): string {
  const prefix = `Invalid eip155 chain id "${echo(reference, MAX_REFERENCE_ECHO)}" in asset "${echo(value)}"`;
  if (HEX_REFERENCE.test(reference)) {
    return `${prefix}: use the decimal chain id (${BigInt(reference)}), not hex.`;
  }
  return `${prefix}: an eip155 chain id is decimal, e.g. 421614.`;
}

function nativeAssetError(value: string): string {
  return `Asset "${echo(value)}" is a native asset (slip44) and has no contract to deposit. Use the wrapped token's erc20 identifier.`;
}

/**
 * Reject an address the chain's own library rejects, while the value is still in hand to name.
 * Applied to eip155 only, where the address form is unambiguous.
 *
 * Both legs are held to this, deliberately stricter than the gateway, which treats EVM address
 * case as non-semantic, so a wrong checksum settles fine either way. It is typo protection at
 * build time rather than a settlement guard, and it covers the token address only, not the account
 * beside it. The all-lowercase form of the same bytes is accepted.
 */
function assertTokenAddress(namespace: string, tokenAddress: string, value: string): void {
  if (namespace !== 'eip155') return;
  if (!EVM_ADDRESS.test(tokenAddress)) {
    throw new Error(tokenAddressError(value));
  }
  // Per EIP-55 a single-case address makes no checksum claim, so only a mixed-case one can carry
  // a wrong checksum. Compared without the `0x` prefix, whose own case is not part of the claim.
  const body = tokenAddress.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return;
  try {
    getAddress(tokenAddress);
  } catch {
    throw new Error(
      `Token address "${tokenAddress}" has an invalid checksum. Fix the capitalization or use the all-lowercase form.`,
    );
  }
}
