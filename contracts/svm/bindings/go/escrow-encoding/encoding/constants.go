package svm_escrow_encoding

// On-chain contract constants from the escrow program's programs/escrow/src/constants.rs

const (
	// ReplaySlots is the on-chain REPLAY_SLOTS constant.
	// Valid slot indices are 0 through ReplaySlots-1.
	ReplaySlots = 235

	// MaxValidSlot is the highest valid slot index (ReplaySlots - 1).
	// Slots 235-255 are reserved for bitmap metadata.
	MaxValidSlot = ReplaySlots - 1

	// ReplayHorizonSecs is the on-chain REPLAY_HORIZON_SECS constant.
	// Deposits are valid for exactly 128 seconds from issued_at.
	// deadline must satisfy: issued_at <= deadline <= issued_at + ReplayHorizonSecs.
	ReplayHorizonSecs = 128

	// NonceSlotMask extracts the lowest 8 bits (slot index) from a nonce.
	NonceSlotMask = 0xFF

	// NonceBucketMask is the widest bucket ID the nonce layout carries. The generator draws from
	// ReplayBuckets, which is a policy value bounded by this.
	NonceBucketMask = 0x1FFFF

	// NonceBucketShift is the bit position where the bucket ID starts in the 64-bit nonce.
	NonceBucketShift = 32

	// ReplayBuckets bounds how many replay-bucket PDAs a client draws from, so those PDAs are
	// reused instead of one being created and left behind per payment. Client policy, not an
	// on-chain constant: the program accepts any selector NonceBucketMask can carry.
	// ReplayBuckets * ReplaySlots = 60160 nonces per authority per ReplayHorizonSecs window.
	// Mirrors REPLAY_BUCKETS in ../../typescript/src/nonce-generator.ts.
	ReplayBuckets = 256

	// DepositComputeUnitLimit is the compute-unit limit a deposit transaction must REQUEST.
	//
	// Not an on-chain constant like the rest of this file, and not a test artifact: Solana's
	// default per-transaction budget is 200k CUs and a deposit carrying the destination commitment does not fit in it.
	// The transaction is the CALLER's to build -- this package hashes and encodes, it never
	// constructs instructions -- so a client that does not prepend
	// ComputeBudgetProgram.setComputeUnitLimit(DepositComputeUnitLimit) gets
	// "exceeded CUs meter at BPF instruction" and the deposit simply fails.
	//
	// It lives here because it was previously reachable only from the Anchor suite's own test
	// helper, where no client could find it. contracts/svm/source/tests/helpers.ts still holds
	// the value the suite uses; compute_budget_parity_test.go asserts the two agree, plus the
	// TypeScript mirror, so the three cannot drift.
	DepositComputeUnitLimit = 400_000
)
