/**
 * Turnkey signing implementation, in its own module (statically imports
 * @atum-labs/turnkey-signer) so turnkey.ts can load it lazily — keeping
 * @solana/web3.js off the private-key path.
 */
import {
  TurnkeyEvmSigner,
  TurnkeySolanaSigner,
  TurnkeyTronSigner,
  getOrCreateTurnkeyClient,
  noopLogger,
  noopMeter,
} from '@atum-labs/turnkey-signer';
import type { TurnkeyClient, Logger, Meter } from '@atum-labs/turnkey-signer';
import { TypedDataEncoder } from 'ethers';
// The signer's own typed-data triple, not ethers' — this function exists to feed
// `signer.signTypedData`, so it should name the types that call actually accepts.
// (ethers' domain is the wider of the two, so it still accepts what we hand it.)
import type { TypedDataDomain, TypedDataTypes } from '@atum-labs/km-core';

import { signingBytes } from '@atum-labs/solana-escrow-encoding';
import { solanaWitnessKind } from '@atum-labs/payment-request-sender-auth';

import { requirePinnedSender } from './pinned-address';
import { STELLAR_TURNKEY_UNSUPPORTED } from './stellar-turnkey';

export interface TurnkeyImplConfig {
  organizationId: string;
  walletId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  pinnedAddress?: string;
  concurrencyLimit?: number;
  requestTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  /**
   * Optional observability for the Turnkey network path (discovery, signing,
   * retries, timeouts). Both default to noop, so the CLI behavior is unchanged
   * and SDK consumers can wire their own without touching the default.
   */
  logger?: Logger;
  meter?: Meter;
}

// Turnkey has a single public API host; there is no alternate/testnet endpoint.
const TURNKEY_API_URL = 'https://api.turnkey.com';

export interface TurnkeySignResult {
  signature: string;
  delegateSigner?: string;
}

const DEFAULTS = {
  concurrencyLimit: 10,
  requestTimeoutMs: 25_000,
  discoveryTimeoutMs: 30_000,
} as const;

/**
 * Sign the sender_auth message for `chainPrefix` (eip155 | tron | solana) with a
 * Turnkey wallet. Builds/reuses a shared TurnkeyClient, then delegates to
 * `signWithTurnkeyClient`.
 */
export async function turnkeySign(
  chainPrefix: string,
  cfg: TurnkeyImplConfig,
  message: string,
  messagePrehash: string | undefined,
  svmMessageScheme?: string,
): Promise<TurnkeySignResult> {
  const client = getOrCreateTurnkeyClient({
    organizationId: cfg.organizationId,
    apiUrl: TURNKEY_API_URL,
    apiPublicKey: cfg.apiPublicKey,
    apiPrivateKey: cfg.apiPrivateKey,
    concurrencyLimit: cfg.concurrencyLimit ?? DEFAULTS.concurrencyLimit,
    requestTimeoutMs: cfg.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    log: cfg.logger ?? noopLogger,
    meter: cfg.meter ?? noopMeter,
  });
  return signWithTurnkeyClient(client, chainPrefix, cfg, message, messagePrehash, svmMessageScheme);
}

/** A Turnkey wallet account address with the format tag Turnkey returns. */
export interface TurnkeyWalletAddress {
  address: string;
  addressFormat: string;
}

/**
 * List the wallet's accounts (address + Turnkey format) in one call, as-is, for the
 * caller to map. The client retries transient failures and fails fast on terminal
 * ones internally, so there is no retry here.
 */
export async function resolveSenderAddresses(
  cfg: TurnkeyImplConfig,
): Promise<TurnkeyWalletAddress[]> {
  const client = getOrCreateTurnkeyClient({
    organizationId: cfg.organizationId,
    apiUrl: TURNKEY_API_URL,
    apiPublicKey: cfg.apiPublicKey,
    apiPrivateKey: cfg.apiPrivateKey,
    concurrencyLimit: cfg.concurrencyLimit ?? DEFAULTS.concurrencyLimit,
    requestTimeoutMs: cfg.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    log: cfg.logger ?? noopLogger,
    meter: cfg.meter ?? noopMeter,
  });
  const accounts = await client.listWalletAccounts(cfg.walletId);
  return accounts.map((a) => ({ address: a.address, addressFormat: a.addressFormat }));
}

/**
 * Drives the real Turnkey chain signers with an injectable client (tests pass a fake).
 * EVM and Tron both sign the typed-data struct, so Turnkey's policy engine can read the fields.
 * The struct is bound to the advertised digest in parsePrehash before anything is signed.
 */
export async function signWithTurnkeyClient(
  client: TurnkeyClient,
  chainPrefix: string,
  cfg: TurnkeyImplConfig,
  message: string,
  messagePrehash: string | undefined,
  svmMessageScheme?: string,
): Promise<TurnkeySignResult> {
  // A blank pin would be dropped by the spread below and take the sender-vs-wallet
  // comparison with it, so it is rejected before any network call.
  const pinnedAddress = requirePinnedSender(cfg.pinnedAddress);
  const deps = {
    walletId: cfg.walletId,
    log: cfg.logger ?? noopLogger,
    discoveryTimeoutMs: cfg.discoveryTimeoutMs ?? DEFAULTS.discoveryTimeoutMs,
    ...(pinnedAddress ? { pinnedAddress } : {}),
  };

  switch (chainPrefix) {
    case 'eip155': {
      // Validate before any network call (initialize()), so malformed input fails fast.
      const { domain, types, message: typedMessage } = parsePrehash(messagePrehash, 'EVM', message);
      const signer = new TurnkeyEvmSigner(client, deps);
      await signer.initialize();
      return { signature: await signer.signTypedData(domain, types, typedMessage) };
    }
    case 'tron': {
      const {
        domain,
        types,
        message: typedMessage,
      } = parsePrehash(messagePrehash, 'Tron', message);
      const signer = new TurnkeyTronSigner(client, deps);
      await signer.initialize();
      return { signature: await signer.signTypedData(domain, types, typedMessage) };
    }
    case 'solana': {
      // The raw hash by default; the escrow text when the escrow's message scheme says so.
      let bytes = decodeSolanaMessageHex(message);
      if (svmMessageScheme) {
        if (bytes.length !== 32) {
          throw new Error(
            'Turnkey Solana signing requires signed_messages[0].message to be the 32-byte escrow hash',
          );
        }
        bytes = signingBytes(svmMessageScheme, solanaWitnessKind(messagePrehash), bytes);
      }
      const signer = new TurnkeySolanaSigner(client, deps);
      await signer.initialize();
      const sig = await signer.signMessage(bytes);
      return {
        signature: '0x' + Buffer.from(sig).toString('hex'),
        delegateSigner: signer.identity.address,
      };
    }
    case 'stellar':
      // SEAM(turnkey-stellar): Turnkey's Stellar address format is unconfirmed; refuse, never guess.
      throw new Error(STELLAR_TURNKEY_UNSUPPORTED);
    default:
      throw new Error(`Unsupported source chain for Turnkey signing: ${chainPrefix}`);
  }
}

/** Decode a 0x-prefixed hex message to bytes, rejecting malformed hex (Buffer.from would coerce it silently). */
function decodeSolanaMessageHex(message: string | undefined): Uint8Array {
  const hex = typeof message === 'string' ? message.replace(/^0x/, '') : '';
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      'Turnkey Solana signing requires signed_messages[0].message to be a non-empty 0x-prefixed hex string',
    );
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

// Parse the message_prehash into the typed-data triple, guarding against invalid
// JSON and a missing/wrong-typed domain/types/message (ethers validates the rest).
//
// The return type names what `signer.signTypedData` accepts -- km-core's triple, per the
// import above, NOT ethers' -- so the two call sites are type-checked. That matters more
// here than anywhere else in the package: with the triple typed `any`, swapping `domain`
// and `types` at a call site compiled cleanly and failed only at signing time.
//
// Not ethers' TypedDataDomain, which is the wider of the two (it admits `name: null`)
// and for that reason is not assignable to what signTypedData takes -- substituting it
// fails to compile rather than silently loosening anything. Verified by trying it.
function parsePrehash(
  messagePrehash: string | undefined,
  label: string,
  advertisedDigest: string,
): {
  domain: TypedDataDomain;
  types: TypedDataTypes;
  message: Record<string, unknown>;
} {
  if (!messagePrehash) {
    throw new Error(`Turnkey ${label} signing requires signed_messages[0].message_prehash`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(messagePrehash);
  } catch {
    throw new Error(`Turnkey ${label} signing: message_prehash is not valid JSON`);
  }
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (
    !isObject(parsed) ||
    !isObject(parsed.domain) ||
    !isObject(parsed.types) ||
    !isObject(parsed.message)
  ) {
    throw new Error(
      `Turnkey ${label} signing: message_prehash must be a JSON object with domain, types and message`,
    );
  }
  // We sign the prehash but `message` is what downstream verifiers read, and both are caller
  // supplied, so require them to agree. Go-built prehashes carry an explicit EIP712Domain entry
  // that ethers derives itself and rejects as unused, so drop it before hashing.
  const { EIP712Domain: _derived, ...structTypes } = parsed.types as Record<string, unknown>;
  // The three casts below are the one boundary where runtime-validated shapes become the
  // signer's static types. isObject has proven each is a non-array object; nothing beyond
  // that is knowable from caller-supplied JSON, and ethers validates the rest itself.
  const domain = parsed.domain as TypedDataDomain;
  const types = structTypes as TypedDataTypes;
  const message = parsed.message as Record<string, unknown>;
  const prehashDigest = TypedDataEncoder.hash(domain, types, message);
  if (prehashDigest.toLowerCase() !== advertisedDigest.toLowerCase()) {
    throw new Error(
      `Turnkey ${label} signing: message_prehash implies digest ${prehashDigest} but message is ${advertisedDigest}`,
    );
  }
  // Return the stripped types: ethers derives EIP712Domain itself and throws on an explicit one,
  // so handing back parsed.types would pass this check and then fail inside signTypedData.
  return { domain, types, message };
}
