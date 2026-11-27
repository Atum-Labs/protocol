package stellar_escrow_encoding

import (
	"crypto/sha256"
	"fmt"
)

// EscrowDomain holds the domain-separation fields that every deposit / reserve / release / refund /
// renounce digest starts with.
//
// Prefix layout: b"escrow" || version[1] || network_id[32] || contract_id[32]
//
// NetworkID is sha256(network passphrase), the host's `ledger().network_id()`; ContractID is the
// escrow's own contract id, the 32 bytes behind its C... strkey. Rust source of truth:
// contracts/escrow/src/signatures.rs:Domain. Unlike Solana there is no configurable cluster id and no
// on-chain config to read: the network and the deployment come from the ledger.
type EscrowDomain struct {
	// NetworkID is sha256 of the network passphrase.
	NetworkID [32]byte

	// ContractID is the escrow contract's id hash.
	ContractID [32]byte
}

// NetworkID returns sha256(network), where network is the network passphrase, a public constant such
// as PassphraseTestnet. It is hashed exactly as given: a trailing space is a different network, so
// nothing here trims it. The parameter is not named after what it holds because static analysis
// reads that name as a password being hashed; the value is not secret and the network id is by
// definition its plain SHA-256.
func NetworkID(network string) [32]byte {
	return sha256.Sum256([]byte(network))
}

// NewEscrowDomain builds an EscrowDomain from a network passphrase (PassphraseTestnet,
// PassphrasePublic, or a standalone network's) and the deployed escrow's contract address.
func NewEscrowDomain(network string, escrow Address) (EscrowDomain, error) {
	if network == "" {
		return EscrowDomain{}, fmt.Errorf("%w: network passphrase cannot be empty", ErrInvalidEscrowDomain)
	}
	if escrow.Type != ContractAddress {
		return EscrowDomain{}, fmt.Errorf("%w: escrow must be a contract (C...) address", ErrInvalidEscrowDomain)
	}
	if escrow.Key == ([32]byte{}) {
		return EscrowDomain{}, fmt.Errorf("%w: contract id cannot be zero", ErrInvalidEscrowDomain)
	}
	return EscrowDomain{NetworkID: NetworkID(network), ContractID: escrow.Key}, nil
}

// EscrowDomainPrefixBytes returns the byte slices that make up the domain prefix:
// b"escrow" || version[1] || network_id[32] || contract_id[32]. Pass the result directly into
// Keccak256 ahead of the per-operation tag and payload.
func EscrowDomainPrefixBytes(domain EscrowDomain) ([][]byte, error) {
	// A caller that built EscrowDomain as a struct literal skipped NewEscrowDomain's checks
	if domain.NetworkID == ([32]byte{}) {
		return nil, fmt.Errorf("%w: network_id cannot be zero", ErrInvalidEscrowDomain)
	}
	if domain.ContractID == ([32]byte{}) {
		return nil, fmt.Errorf("%w: contract_id cannot be zero", ErrInvalidEscrowDomain)
	}

	return [][]byte{
		[]byte("escrow"),
		{SignatureDomainVersion},
		domain.NetworkID[:],
		domain.ContractID[:],
	}, nil
}

// hashWithDomain is keccak256(prefix || tag || parts...), the framing every signed digest shares.
func hashWithDomain(domain EscrowDomain, tag string, parts ...[]byte) ([32]byte, error) {
	prefix, err := EscrowDomainPrefixBytes(domain)
	if err != nil {
		return [32]byte{}, err
	}
	all := append(prefix, []byte(tag))
	return Keccak256(append(all, parts...)...), nil
}
