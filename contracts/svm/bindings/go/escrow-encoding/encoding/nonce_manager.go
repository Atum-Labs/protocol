package svm_escrow_encoding

import (
	"math/rand/v2"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// TotalBuckets sizes the per-bucket slot counters. The generator draws from ReplayBuckets.
const TotalBuckets = NonceBucketMask + 1

// NonceManager handles atomic nonce generation for Solana deposits.
//
// The nonce format is defined by the on-chain escrow program:
//   - Lower 8 bits: slot index (0 to MaxValidSlot), extracted on-chain via nonce & 0xFF
//   - Upper 32 bits: bucket ID, used on-chain as PDA seed via nonce.to_le_bytes()[4..]
//
// NonceManager distributes nonces across ReplayBuckets buckets with atomic slot counters,
// enabling lock-free, high-throughput concurrent nonce generation.
//
// Capacity: the program remembers a nonce for its own 256-second slice and the next one, so a
// slot is reusable 256 to 512 seconds after its last use. A bucket's counter wraps after
// MaxValidSlot+1 (235) draws, so a bucket that is drawn more than 235 times inside that period
// hands out a nonce the program still remembers and the deposit is refused as a duplicate. The
// whole set holds ReplayBuckets * 235 = 60160 nonces per 256 to 512 seconds, about 117 per second
// at the 512 second end; a caller above that rate needs a wider bucket set.
type NonceManager struct {
	bucketSlots [TotalBuckets]atomic.Uint64
	rng         *rand.Rand
	rngMutex    sync.Mutex
}

// NewNonceManager creates a new nonce manager.
func NewNonceManager() *NonceManager {
	return &NonceManager{
		// #nosec G404 -- Using math/rand for bucket selection (load distribution), not cryptography.
		// Security comes from on-chain replay protection, not bucket randomness.
		// Performance critical: crypto/rand would be 100x slower for high-throughput nonce generation.
		rng: rand.New(rand.NewPCG(safeUint64(time.Now().UnixNano()), safeUint64(int64(os.Getpid())))),
	}
}

// GenerateValidNonce generates a nonce that maps to a valid replay protection slot (0-234).
// The on-chain program uses REPLAY_SLOTS = 235, so valid slots are 0 through 234.
// Slots 235-255 are reserved for bitmap metadata.
//
// Returns a 64-bit nonce where:
//   - Upper 32 bits: bucket ID (0 to ReplayBuckets-1)
//   - Lower 32 bits: 8-bit slot (0 to 234, avoiding reserved slots 235-255)
func (nm *NonceManager) GenerateValidNonce() (uint64, error) {
	// Step 1: Draw the bucket from the bounded set (needs mutex protection for RNG).
	// 2^32 is a multiple of ReplayBuckets, so the modulo is unbiased.
	nm.rngMutex.Lock()
	bucketID := nm.rng.Uint32() % ReplayBuckets
	nm.rngMutex.Unlock()

	// Step 2: Atomically claim next slot in this bucket (completely lock-free)
	// atomic.Add(1) returns NEW value after increment, so subtract 1 to get the slot we claimed
	rawSlot := nm.bucketSlots[bucketID].Add(1) - 1

	// Step 3: Ensure slot is in valid range (0-234), wrapping around if needed.
	// On-chain REPLAY_SLOTS = 235, so MaxValidSlot + 1 = 235 valid slots: 0,1,2,...,234
	validSlot := rawSlot % (MaxValidSlot + 1)

	// Step 4: Construct 64-bit nonce: bucket_id in upper 32 bits, 8-bit slot in lower 32 bits
	nonce := (uint64(bucketID) << NonceBucketShift) | validSlot

	return nonce, nil
}

// safeUint64 converts an int64 to uint64, ensuring non-negative values.
// This satisfies linter G115 by making the conversion intention explicit.
func safeUint64(val int64) uint64 {
	if val < 0 {
		return 0
	}
	return uint64(val)
}
