import { keccak256, toUtf8Bytes } from 'ethers';

/**
 * Escrow commitments for sender_auth producers: the deposit request hash and the plaintext
 * destination. Both are pinned by `PaymentRequest/v1/conformance/destination-vectors.json`, which
 * every implementation of this grammar must reproduce byte-for-byte.
 */

/**
 * Mirrors `MAX_DESTINATION_BYTES` in Escrow.sol. Over this the contract reverts
 * `DestinationTooLong`, so a longer destination could never be redeemed.
 */
export const MAX_DESTINATION_BYTES = 256;

/** The one CAIP-2 namespace whose identifiers are entirely case-insensitive hex. */
const NAMESPACE_EIP155 = 'eip155';

/**
 * Returns `keccak256(utf8Bytes(requestId))`, depositRequestHash v1: the depositor's commitment to
 * the off-chain payment request id. The escrow treats the value as opaque, so this derivation is the
 * specification, pinned by the `depositRequestHashes` conformance vectors. v1 covers the request id
 * alone. depositRequestHash v2, the hash of the payment terms without sender_auth, is
 * `readDepositRequest`'s `depositRequestHashV2`; a producer picks the version with
 * `depositRequestHashVersion`. Mirrors the Go `DeriveDepositRequestHash`.
 */
export function deriveDepositRequestHash(requestId: string): string {
  if (requestId === '') {
    throw new Error(
      'sender_auth: cannot derive deposit_request_hash: request_id is empty, and keccak256("") ' +
        'is a perfectly valid non-zero bytes32, so this would silently commit every empty-id ' +
        'deposit to the same hash instead of failing',
    );
  }
  return keccak256(toUtf8Bytes(requestId));
}

/**
 * Composes the plaintext destination committed in the deposit witness:
 *
 *     <caip2-chain-id>/<asset-namespace>:<asset-reference>@<account-address>
 *     eip155:8453/erc20:0x833589f...02913@0xc0ffee2...54979
 *
 * The escrow stores only `keccak256(bytes(destination))`, so every producer and verifier must
 * compose identical bytes. Casing is per-namespace: eip155 hex is lowercased (not EIP-55), and
 * base58 values, including every Solana segment, are preserved byte-for-byte. Non-canonical input
 * is rejected rather than normalised. The asset namespace has no allow-list, so compose the
 * destination once per payment and carry it verbatim rather than re-deriving it.
 */
export function buildEscrowDestination(assetIdentifier: string, account: string): string {
  if (assetIdentifier === '') {
    throw new Error('sender_auth: destination asset_identifier is empty');
  }
  if (account === '') {
    throw new Error('sender_auth: destination account is empty');
  }
  // Every chain identifier and address is printable ASCII. Anything else is refused, so no
  // Unicode case mapping, whose tables differ between languages and versions, shapes the bytes.
  if (!isPrintableAscii(assetIdentifier) || !isPrintableAscii(account)) {
    throw new Error(
      'sender_auth: destination asset_identifier and account must be printable ASCII',
    );
  }
  // "@" is the field separator, so neither side may contain one or the composed string
  // would be ambiguous to any parser splitting on it.
  if (assetIdentifier.includes('@') || account.includes('@')) {
    throw new Error(
      `sender_auth: destination asset_identifier (${JSON.stringify(assetIdentifier)}) and account ` +
        `(${JSON.stringify(account)}) must not contain '@': it is the separator between them in ` +
        'the committed destination grammar',
    );
  }

  const namespace = caip2Namespace(assetIdentifier);

  let asset = assetIdentifier;
  let acct = account;
  if (namespace === NAMESPACE_EIP155) {
    // Every segment of an eip155 destination is ASCII hex or a lowercase keyword, so
    // lowercasing the whole side is safe here and ONLY here.
    asset = asset.toLowerCase();
    acct = acct.toLowerCase();
  }

  const destination = `${asset}@${acct}`;
  // Solidity measures bytes(destination).length, so the cap is over UTF-8 BYTES, not code
  // points: a 256-character string of multibyte characters is over the cap.
  const byteLength = toUtf8Bytes(destination).length;
  if (byteLength > MAX_DESTINATION_BYTES) {
    throw new Error(
      `sender_auth: composed destination is ${byteLength} bytes, over the escrow's ` +
        `MAX_DESTINATION_BYTES of ${MAX_DESTINATION_BYTES}: the contract reverts ` +
        'DestinationTooLong, so this deposit could never be redeemed',
    );
  }
  return destination;
}

/**
 * Extracts the CAIP-2 namespace from a CAIP-19 asset identifier and validates the
 * surrounding shape. Only the namespace is needed (it selects the casing rule), but a
 * malformed identifier is rejected rather than passed through, because the destination is
 * signed and the contract cannot check it.
 */
function caip2Namespace(assetIdentifier: string): string {
  const slash = assetIdentifier.indexOf('/');
  const chainPart = slash === -1 ? '' : assetIdentifier.slice(0, slash);
  const assetPart = slash === -1 ? '' : assetIdentifier.slice(slash + 1);
  if (slash === -1 || chainPart === '' || assetPart === '') {
    // The `solana:<chain-ref>:<mint>` form lands here: the commitment is over exact bytes, so
    // only the CAIP-19 spelling is accepted.
    const colonSeparated = !assetIdentifier.includes('/') && countChar(assetIdentifier, ':') === 2;
    const hint = colonSeparated
      ? ' (this looks like the deprecated `<chain>:<ref>:<asset>` form; migrate it to ' +
        '`<chain>:<ref>/<asset-namespace>:<asset-reference>`)'
      : '';
    throw new Error(
      `sender_auth: destination asset_identifier ${JSON.stringify(assetIdentifier)} is not CAIP-19: ` +
        `expected <caip2-chain-id>/<asset-namespace>:<asset-reference>${hint}`,
    );
  }

  const assetColon = assetPart.indexOf(':');
  if (assetColon <= 0 || assetColon === assetPart.length - 1) {
    throw new Error(
      `sender_auth: destination asset_identifier ${JSON.stringify(assetIdentifier)} has a malformed ` +
        `asset part ${JSON.stringify(assetPart)}: expected <asset-namespace>:<asset-reference>`,
    );
  }

  const assetNamespace = assetPart.slice(0, assetColon);
  // Namespaces must be lowercase, and a variant spelling is refused rather than normalised: only
  // eip155 is lowercased wholesale, so "Token" and "token" would otherwise commit two different
  // hashes for one payee. The asset reference is case-significant (base58 mints, Tron addresses).
  if (assetNamespace !== assetNamespace.toLowerCase()) {
    throw new Error(
      `sender_auth: destination asset_identifier ${JSON.stringify(assetIdentifier)} has a ` +
        `non-canonical asset namespace ${JSON.stringify(assetNamespace)}: the ratified grammar ` +
        `requires it lowercase (${JSON.stringify(assetNamespace.toLowerCase())}). It is rejected ` +
        'rather than normalised because the destination commitment is over these exact bytes',
    );
  }

  const chainColon = chainPart.indexOf(':');
  if (chainColon <= 0 || chainColon === chainPart.length - 1) {
    throw new Error(
      `sender_auth: destination asset_identifier ${JSON.stringify(assetIdentifier)} has a malformed ` +
        `chain part ${JSON.stringify(chainPart)}: expected <namespace>:<reference>`,
    );
  }

  const namespace = chainPart.slice(0, chainColon);
  // The chain namespace selects the casing rule, so it must already be lowercase: lowercasing
  // "SOLANA:..." to normalise it would corrupt the base58 segments that follow.
  if (namespace !== namespace.toLowerCase()) {
    throw new Error(
      `sender_auth: destination asset_identifier ${JSON.stringify(assetIdentifier)} has a ` +
        `non-canonical chain namespace ${JSON.stringify(namespace)}: the ratified grammar requires ` +
        `it lowercase (${JSON.stringify(namespace.toLowerCase())}). It is rejected rather than ` +
        'normalised because the destination commitment is over these exact bytes',
    );
  }
  return namespace;
}

function countChar(s: string, c: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === c) n++;
  }
  return n;
}

/** Whether every character of `s` is printable ASCII (0x21-0x7E). */
function isPrintableAscii(s: string): boolean {
  return /^[\x21-\x7e]*$/.test(s);
}
