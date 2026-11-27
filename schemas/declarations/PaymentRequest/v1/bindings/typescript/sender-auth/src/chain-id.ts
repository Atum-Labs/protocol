// Chain-id / CAIP-2 / Permit2-address / Solana-cluster helpers.

import { PASSPHRASE_PUBLIC, PASSPHRASE_TESTNET } from '@atum-labs/stellar-escrow-encoding';

import { TronChainIdError } from './errors.js';
import { quoteValue } from './commitment-rules.js';

/** The CAIP-2 namespace of a network id (the part before the first colon). */
export function namespaceOf(network: string): string {
  return network.split(':')[0]!;
}

/**
 * Largest chain id either binding accepts, per EIP-2294. Above it `Number` stops being injective,
 * so `eip155:9007199254740993` reads back as 9007199254740992 and the digest would commit to a
 * chain id the identifier does not name. The Go mirror refuses the same values, so one binding
 * never signs a reference the other reads differently.
 */
export const MAX_EVM_CHAIN_ID = Number.MAX_SAFE_INTEGER;

/** Parse the numeric chain id from an `eip155:<id>` CAIP-2 network, or throw. */
export function evmChainId(network: string): number {
  const match = /^eip155:([0-9]+)$/.exec(network);
  if (!match) {
    throw new Error(`sender_auth: expected an eip155 network, got ${network}`);
  }
  const chainId = Number(match[1]);
  if (chainId > MAX_EVM_CHAIN_ID) {
    throw new Error(
      `sender_auth: eip155 chain id ${match[1]} exceeds the EIP-2294 maximum (${MAX_EVM_CHAIN_ID})`,
    );
  }
  return chainId;
}

/** Known Tron cluster → TIP-712 numeric chain id. */
export const TRON_CHAIN_IDS: Record<string, number> = {
  mainnet: 728126428,
  shasta: 2494104990,
};

/**
 * Largest Tron chain id either binding accepts from a caller. TIP712.sol refuses to deploy on a
 * chain whose id does not fit 32 bits, so no Tron escrow can sign over a larger one. The Go
 * mirror refuses the same values.
 */
export const MAX_TRON_CHAIN_ID = 0xffffffff;

/**
 * Tron TIP-712 numeric chain id for a `tron:<cluster>` network, or throw. `tronChainIds` supplies,
 * by cluster, the id of a network `TRON_CHAIN_IDS` does not know, such as a local node's. The table
 * stays authoritative: an entry for a cluster it knows must repeat its id, an entry for any other
 * cluster must not repeat an id the table gives a cluster, and every entry read must be an integer
 * in 1..MAX_TRON_CHAIN_ID, or this throws `TronChainIdError`, which the package exports so a caller
 * can tell its own misconfiguration from an unsupported network. Only the entry for this network's
 * cluster is read. Mirrors the Go `tronNumericChainID`.
 */
export function tronNumericChainId(
  network: string,
  tronChainIds?: Readonly<Record<string, number>>,
): number {
  // Namespace first: the cluster name alone does not identify a chain, so `eip155:mainnet` must
  // not resolve to Tron mainnet's id.
  if (namespaceOf(network) !== 'tron') {
    throw new Error(`sender_auth: expected a tron network, got ${network}`);
  }
  // Exactly two segments, mirroring Go, so `tron:mainnet:extra` does not resolve to mainnet's id.
  // An empty cluster names no network, so no supplied entry can give it one.
  const segments = network.split(':');
  const cluster = segments.length === 2 && segments[1] !== '' ? segments[1] : undefined;
  // Own keys only: a plain index read reaches Object.prototype (e.g. `tron:constructor`).
  const known =
    cluster !== undefined && Object.hasOwn(TRON_CHAIN_IDS, cluster)
      ? TRON_CHAIN_IDS[cluster]
      : undefined;
  if (tronChainIds !== undefined) {
    // Go's type system rules these out; refusing them keeps a malformed option from being ignored.
    if (typeof tronChainIds !== 'object' || tronChainIds === null || Array.isArray(tronChainIds)) {
      throw new TronChainIdError('the supplied Tron chain ids are not an object keyed by cluster');
    }
    if (cluster !== undefined && Object.hasOwn(tronChainIds, cluster)) {
      const supplied = tronChainIds[cluster];
      if (
        typeof supplied !== 'number' ||
        !Number.isInteger(supplied) ||
        supplied < 1 ||
        supplied > MAX_TRON_CHAIN_ID
      ) {
        throw new TronChainIdError(
          `the Tron chain id supplied for cluster ${quoteValue(cluster)} is not an integer in 1..${MAX_TRON_CHAIN_ID}`,
        );
      }
      if (known !== undefined && supplied !== known) {
        throw new TronChainIdError(
          `the Tron chain id supplied for cluster ${quoteValue(cluster)} is ${supplied}, but the built-in table has ${known}`,
        );
      }
      // The chain id is all that tells one Tron network's TIP-712 domain from another's, so a
      // built-in id under a new name would make that name an alias of the network, and a permit
      // signed there would verify under it. The table's ids are distinct, so at most one matches.
      if (known === undefined) {
        const owner = Object.keys(TRON_CHAIN_IDS).find((name) => TRON_CHAIN_IDS[name] === supplied);
        if (owner !== undefined) {
          throw new TronChainIdError(
            `the Tron chain id supplied for cluster ${quoteValue(cluster)} is ${supplied}, which the built-in table gives cluster ${quoteValue(owner)}`,
          );
        }
      }
      return supplied;
    }
  }
  if (typeof known !== 'number') {
    throw new Error(`sender_auth: unsupported Tron network '${network}'`);
  }
  return known;
}

/**
 * Pinned Tron Permit2 addresses. Resolved server-side only — never from a
 * client-supplied value — so a forged verifying contract cannot recover the signature
 * to the wrong signer.
 */
export const TRON_PERMIT2_FALLBACKS: Record<string, string> = {
  'tron:mainnet': 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
  'tron:shasta': 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
};

/** Resolve the Tron Permit2 address for a network from the pinned map, or throw. */
export function resolveTronPermit2(network: string): string {
  // Own keys only, as in the chain-id lookup above, so an inherited name never becomes the
  // verifying contract.
  const resolved = Object.hasOwn(TRON_PERMIT2_FALLBACKS, network)
    ? TRON_PERMIT2_FALLBACKS[network]
    : undefined;
  if (typeof resolved !== 'string' || resolved === '') {
    throw new Error(`sender_auth: no Permit2 address known for Tron network '${network}'`);
  }
  return resolved;
}

/**
 * Build the 32-byte `cluster_id` from a cluster name (UTF-8, right-padded with zeros),
 * mirroring the on-chain escrow's cluster-id layout.
 */
export function clusterIdFromName(name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  if (encoded.length > 32) {
    throw new Error(
      `sender_auth: Solana cluster name too long (${encoded.length} > 32 bytes): ${name}`,
    );
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

/**
 * Stellar CAIP-2 reference -> network passphrase, the public network constants the escrow's
 * `network_id` is the sha256 of. A reference not listed here is refused rather than guessed: a
 * wrong network yields a well-formed digest no deployed escrow can accept.
 */
export const STELLAR_NETWORKS: Readonly<Record<string, string>> = {
  pubnet: PASSPHRASE_PUBLIC,
  testnet: PASSPHRASE_TESTNET,
  futurenet: 'Test SDF Future Network ; October 2022',
  standalone: 'Standalone Network ; February 2017',
};

/**
 * The network passphrase of a `stellar:<reference>` CAIP-2 network, or throw. The caller hashes it
 * with the escrow encoder's `newEscrowDomain`; nothing here is secret.
 */
export function stellarNetworkString(network: string): string {
  const parts = network.split(':');
  const known =
    parts.length === 2 && parts[0] === 'stellar' && Object.hasOwn(STELLAR_NETWORKS, parts[1]!);
  if (!known) {
    throw new Error(
      `sender_auth: ${quoteValue(network)} is not a supported stellar network (expected one of ${Object.keys(
        STELLAR_NETWORKS,
      )
        .map((n) => `stellar:${n}`)
        .join(', ')})`,
    );
  }
  return STELLAR_NETWORKS[parts[1]!]!;
}
