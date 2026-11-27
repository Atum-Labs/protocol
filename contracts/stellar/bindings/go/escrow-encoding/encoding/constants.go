package stellar_escrow_encoding

// Constants of the Soroban escrow, from contracts/escrow/src/signatures.rs and lib.rs.

const (
	// SignatureDomainVersion is the version byte every digest commits to (SIGNATURE_DOMAIN_VERSION).
	// Unlike the Solana port it is not read from chain: it is a constant of the deployed layout, and a
	// layout change ships as a new contract id.
	SignatureDomainVersion = 2

	// MaxDestinationLen is the maximum byte length of the committed destination (MAX_DESTINATION_BYTES).
	// Uniform across EVM, TVM and SVM so one client signing-policy rule covers every chain.
	MaxDestinationLen = 256

	// MaxDepositValiditySecs bounds deadline - issued_at (MAX_DEPOSIT_VALIDITY_SECS): 24 hours. Only the
	// span is checkable offline; the contract also compares both ends to the ledger close time, which the
	// caller must read from the latest closed ledger, not the local clock.
	MaxDepositValiditySecs = 86400

	// PassphraseTestnet and PassphrasePublic are the network passphrases whose sha256 is the host's
	// network_id, the domain-separation input that keeps a signature on its own network.
	PassphraseTestnet = "Test SDF Network ; September 2015"
	PassphrasePublic  = "Public Global Stellar Network ; September 2015"
)
