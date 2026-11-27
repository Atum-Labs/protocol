package svm_escrow_encoding

import (
	"fmt"
	"strings"
)

// EscrowDomain holds the domain-separation fields that V3 escrow prepends to every
// deposit / reserve / release / refund hash before the operation tag.
//
// V3 prefix layout: b"escrow" || version[1] || cluster_id[32] || program_id[32]
//
// ClusterID and SignatureDomainVersion are sourced from the on-chain ProtocolConfig
// PDA (seeds = ["protocol_config"], owner = escrow program).
//   - ClusterID:               offset (8 + 4*32 + 1) — `ProtocolConfig.cluster_id`
//   - SignatureDomainVersion:  byte at offset (8 + 4*32 + 1 + 32) — `ProtocolConfig.signature_domain_version`
//
// ProgramID is the escrow program's own ID. Rust source of truth:
// programs/escrow/src/utils/signatures.rs:compute_*_hash.
type EscrowDomain struct {
	// ClusterID is the 32-byte cluster identifier from `ProtocolConfig.cluster_id`.
	ClusterID [32]byte

	// SignatureDomainVersion is the 1-byte signature schema version from
	// `ProtocolConfig.signature_domain_version`.
	SignatureDomainVersion uint8

	// ProgramID is the escrow program's public key.
	ProgramID Pubkey
}

// NewEscrowDomain builds an EscrowDomain from a cluster name string (e.g. "devnet",
// "mainnet", "localnet"), the signature schema version, and the deployed escrow
// program ID. The cluster name is encoded as UTF-8 bytes and right-padded with
// zeros to fill the 32-byte ProtocolConfig.cluster_id field — the on-chain layout
// produced by `programs/escrow/src/state.rs:ProtocolConfig::initialize`.
func NewEscrowDomain(clusterName string, signatureDomainVersion uint8, programID Pubkey) (EscrowDomain, error) {
	trimmed := strings.TrimSpace(clusterName)
	if trimmed == "" {
		return EscrowDomain{}, fmt.Errorf("%w: cluster name cannot be empty", ErrInvalidEscrowDomain)
	}
	if len(trimmed) > 32 {
		return EscrowDomain{}, fmt.Errorf("%w: cluster name %q exceeds 32 bytes", ErrInvalidEscrowDomain, trimmed)
	}
	if signatureDomainVersion == 0 {
		// Zero is the uint8 default; treat it as "unset" rather than a real
		// schema version. The on-chain ProtocolConfig is initialized with
		// CURRENT_SIGNATURE_DOMAIN_VERSION (3 on solana-escrow main, post-#15),
		// and version 0 cannot match any deployed program.
		return EscrowDomain{}, fmt.Errorf("%w: signature_domain_version cannot be 0", ErrInvalidEscrowDomain)
	}
	if programID.IsZero() {
		return EscrowDomain{}, fmt.Errorf("%w: program_id cannot be zero", ErrInvalidEscrowDomain)
	}

	var clusterID [32]byte
	copy(clusterID[:], []byte(trimmed))

	return EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: signatureDomainVersion,
		ProgramID:              programID,
	}, nil
}

// EscrowDomainPrefixBytes returns the byte slices that make up the V3 domain prefix:
// b"escrow" || version[1] || cluster_id[32] || program_id[32]. Pass the result
// directly into Keccak256 ahead of the per-operation tag and payload.
func EscrowDomainPrefixBytes(domain EscrowDomain) ([][]byte, error) {
	if domain.ProgramID.IsZero() {
		return nil, fmt.Errorf("%w: program_id cannot be zero", ErrInvalidEscrowDomain)
	}
	// A caller that built EscrowDomain as a struct literal skipped NewEscrowDomain's checks, so
	// version 0 can reach here. TypeScript rejects it on every hash call; match that, or the two
	// languages disagree about whether an unset version is hashable.
	if domain.SignatureDomainVersion == 0 {
		return nil, fmt.Errorf("%w: signature_domain_version cannot be 0", ErrInvalidEscrowDomain)
	}

	return [][]byte{
		[]byte("escrow"),
		{domain.SignatureDomainVersion},
		domain.ClusterID[:],
		domain.ProgramID[:],
	}, nil
}
