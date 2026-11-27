import { sha256 } from '@noble/hashes/sha256';
import { Address, CONTRACT_ADDRESS } from './address';
import { InvalidEscrowDomainError } from './errors';
import { isZeroBytes32, keccak256, stringToBytes } from './encoding-utils';

/** The version byte every digest commits to (`SIGNATURE_DOMAIN_VERSION`). Not read from chain: it is a
 * constant of the deployed layout, and a layout change ships as a new contract id. */
export const SIGNATURE_DOMAIN_VERSION = 2;

/** Network passphrases whose sha256 is the host's network_id. */
export const PASSPHRASE_TESTNET = 'Test SDF Network ; September 2015';
export const PASSPHRASE_PUBLIC = 'Public Global Stellar Network ; September 2015';

/**
 * Domain-separation fields every deposit/reserve/release/refund/renounce digest starts with:
 * `b"escrow" || version[1] || network_id[32] || contract_id[32]`.
 *
 * `networkId` is sha256(network passphrase), the host's `ledger().network_id()`; `contractId` is the
 * escrow's own contract id, the 32 bytes behind its C... strkey. Rust source of truth:
 * `contracts/escrow/src/signatures.rs:Domain`. Unlike Solana there is no configurable cluster id and no
 * on-chain config to read: the network and the deployment come from the ledger.
 */
export interface EscrowDomain {
  /** sha256 of the network passphrase. */
  readonly networkId: Uint8Array;
  /** The escrow contract's id hash. */
  readonly contractId: Uint8Array;
}

/**
 * sha256(passphrase). The passphrase is hashed exactly as given: a trailing space is a different network,
 * so nothing here trims it.
 */
export function networkIdFromPassphrase(passphrase: string): Uint8Array {
  return sha256(new TextEncoder().encode(passphrase));
}

/**
 * Build the domain-prefix bytes every digest starts with:
 * `b"escrow" || version[1] || network_id[32] || contract_id[32]`.
 */
export function escrowDomainPrefixBytes(domain: EscrowDomain): Uint8Array[] {
  if (domain.networkId.length !== 32) {
    throw new InvalidEscrowDomainError(
      `EscrowDomain.networkId must be 32 bytes, got ${domain.networkId.length}`,
    );
  }
  if (domain.contractId.length !== 32) {
    throw new InvalidEscrowDomainError(
      `EscrowDomain.contractId must be 32 bytes, got ${domain.contractId.length}`,
    );
  }
  // The interface can be filled in by object literal, which skips newEscrowDomain's checks
  if (isZeroBytes32(domain.networkId)) {
    throw new InvalidEscrowDomainError('EscrowDomain.networkId cannot be zero');
  }
  if (isZeroBytes32(domain.contractId)) {
    throw new InvalidEscrowDomainError('EscrowDomain.contractId cannot be zero');
  }
  return [
    new TextEncoder().encode('escrow'),
    new Uint8Array([SIGNATURE_DOMAIN_VERSION]),
    domain.networkId,
    domain.contractId,
  ];
}

/**
 * `keccak256(prefix || tag || parts...)`, the framing every signed digest shares. Counterpart to Go's
 * `hashWithDomain`. The tag is the operation name ("deposit", "reserve", "release", "refund",
 * "renounce"), so a signature for one operation can never validate as another.
 */
export function hashWithDomain(domain: EscrowDomain, tag: string, ...parts: Uint8Array[]): Uint8Array {
  return keccak256(...escrowDomainPrefixBytes(domain), stringToBytes(tag), ...parts);
}

/**
 * Build an {@link EscrowDomain} from a network passphrase ({@link PASSPHRASE_TESTNET},
 * {@link PASSPHRASE_PUBLIC}, or a standalone network's) and the deployed escrow's contract address,
 * validating both. The checked path, and the counterpart to Go's `NewEscrowDomain`.
 */
export function newEscrowDomain(networkPassphrase: string, escrow: Address): EscrowDomain {
  if (networkPassphrase.length === 0) {
    throw new InvalidEscrowDomainError('EscrowDomain network passphrase cannot be empty');
  }
  if (escrow.type !== CONTRACT_ADDRESS) {
    throw new InvalidEscrowDomainError('EscrowDomain escrow must be a contract (C...) address');
  }
  if (escrow.isZero()) {
    throw new InvalidEscrowDomainError('EscrowDomain contract id cannot be zero');
  }
  return { networkId: networkIdFromPassphrase(networkPassphrase), contractId: escrow.toBytes() };
}
