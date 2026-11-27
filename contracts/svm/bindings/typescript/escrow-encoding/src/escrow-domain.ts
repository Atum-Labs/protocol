import { InvalidEscrowDomainError } from './errors';
import { Pubkey } from './pubkey';

/**
 * Domain-separation fields for V3 escrow message hashes.
 *
 * V3 escrow prepends `b"escrow" || version[1] || cluster_id[32] || program_id[32]` to every
 * deposit/reserve/release/refund hash before the operation tag. The values come from the
 * on-chain `ProtocolConfig` PDA (seeds = ["protocol_config"], owner = escrow program):
 *
 *   - `signatureDomainVersion`: byte at offset (8 + 4*32 + 1 + 32) — `ProtocolConfig.signature_domain_version`
 *   - `clusterId`: 32 bytes at offset (8 + 4*32 + 1) — `ProtocolConfig.cluster_id`
 *
 * `programId` is the escrow program's own ID (44DjKbs1… on devnet).
 *
 * Callers must read these from chain (or hold them in trusted config) before computing any
 * V3 hash. The Rust source of truth is `programs/escrow/src/utils/signatures.rs:compute_*_hash`.
 */
export interface EscrowDomain {
  /** 32-byte cluster identifier from `ProtocolConfig.cluster_id`. */
  readonly clusterId: Uint8Array;
  /** 1-byte signature schema version from `ProtocolConfig.signature_domain_version`. */
  readonly signatureDomainVersion: number;
  /** Escrow program ID. */
  readonly programId: Pubkey;
}

/**
 * Build the domain-prefix bytes that V3 prepends to every hash:
 * `b"escrow" || version[1] || cluster_id[32] || program_id[32]`.
 */
export function escrowDomainPrefixBytes(domain: EscrowDomain): Uint8Array[] {
  if (domain.clusterId.length !== 32) {
    throw new InvalidEscrowDomainError(
      `EscrowDomain.clusterId must be 32 bytes, got ${domain.clusterId.length}`,
    );
  }
  if (domain.programId.isZero()) {
    throw new InvalidEscrowDomainError('EscrowDomain.programId cannot be zero');
  }
  // Version 0 is the JS numeric default; treat it as "unset" rather than a
  // real schema version. The on-chain ProtocolConfig is initialized with
  // CURRENT_SIGNATURE_DOMAIN_VERSION = 2, so 0 cannot match any deployed program.
  if (
    !Number.isInteger(domain.signatureDomainVersion) ||
    domain.signatureDomainVersion < 1 ||
    domain.signatureDomainVersion > 255
  ) {
    throw new InvalidEscrowDomainError(
      `EscrowDomain.signatureDomainVersion must be an integer in 1..=255, got ${domain.signatureDomainVersion}`,
    );
  }
  return [
    new TextEncoder().encode('escrow'),
    new Uint8Array([domain.signatureDomainVersion]),
    domain.clusterId,
    domain.programId.toBytes(),
  ];
}

/**
 * Build an {@link EscrowDomain} from a cluster name, the signature schema version, and the deployed
 * escrow program ID, validating all three. The cluster name is encoded as UTF-8 and right-padded
 * with zeros to fill the 32-byte `ProtocolConfig.cluster_id` field.
 *
 * The interface above can be filled in by object literal, which skips these checks — this is the
 * checked path, and the counterpart to Go's `NewEscrowDomain`. Without it the two bindings disagreed
 * about whether a cluster name is validated at all.
 */
export function newEscrowDomain(
  clusterName: string,
  signatureDomainVersion: number,
  programId: Pubkey,
): EscrowDomain {
  const trimmed = clusterName.trim();
  if (trimmed.length === 0) {
    throw new InvalidEscrowDomainError('EscrowDomain cluster name cannot be empty');
  }
  const encoded = new TextEncoder().encode(trimmed);
  if (encoded.length > 32) {
    throw new InvalidEscrowDomainError(
      `EscrowDomain cluster name "${trimmed}" exceeds 32 bytes`,
    );
  }
  if (
    !Number.isInteger(signatureDomainVersion) ||
    signatureDomainVersion < 1 ||
    signatureDomainVersion > 255
  ) {
    throw new InvalidEscrowDomainError(
      `EscrowDomain.signatureDomainVersion must be an integer in 1..=255, got ${signatureDomainVersion}`,
    );
  }
  if (programId.isZero()) {
    throw new InvalidEscrowDomainError('EscrowDomain.programId cannot be zero');
  }

  const clusterId = new Uint8Array(32);
  clusterId.set(encoded);
  return { clusterId, signatureDomainVersion, programId };
}
