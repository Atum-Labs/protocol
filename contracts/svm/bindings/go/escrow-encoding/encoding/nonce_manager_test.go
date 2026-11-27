package svm_escrow_encoding

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNonceManager_GenerateValidNonce(t *testing.T) {
	tests := []struct {
		name        string
		setup       func(*NonceManager)
		iterations  int
		concurrent  bool
		goroutines  int
		validate    func(*testing.T, []uint64)
		expectError bool
		description string
	}{
		{
			name:        "basic_single_nonce_generation",
			iterations:  1,
			concurrent:  false,
			expectError: false,
			description: "Should generate a single valid nonce successfully",
			validate: func(t *testing.T, nonces []uint64) {
				require.Len(t, nonces, 1)
				nonce := nonces[0]

				bucketID := uint32(nonce >> 32)
				slot := nonce & 0xFFFFFFFF

				assert.Less(t, bucketID, uint32(ReplayBuckets), "bucket ID should be within the bounded set")
				assert.LessOrEqual(t, slot, uint64(MaxValidSlot), "slot should be 0-234")
			},
		},
		{
			name:        "multiple_sequential_nonces",
			iterations:  100,
			concurrent:  false,
			expectError: false,
			description: "Should generate multiple valid nonces sequentially",
			validate: func(t *testing.T, nonces []uint64) {
				require.Len(t, nonces, 100)

				bucketSlots := make(map[uint32][]uint64)
				for _, nonce := range nonces {
					bucketID := uint32(nonce >> 32)
					slot := nonce & 0xFFFFFFFF

					assert.LessOrEqual(t, bucketID, uint32(NonceBucketMask))
					assert.LessOrEqual(t, slot, uint64(MaxValidSlot))

					bucketSlots[bucketID] = append(bucketSlots[bucketID], slot)
				}

				for bucketID, slots := range bucketSlots {
					if len(slots) > 1 {
						t.Logf("Bucket %d has %d slots: %v", bucketID, len(slots), slots)
						for i := 1; i < len(slots); i++ {
							expected := (slots[i-1] + 1) % (MaxValidSlot + 1)
							assert.Equal(t, expected, slots[i],
								"slots should be sequential in bucket %d: slot[%d]=%d, expected=%d",
								bucketID, i, slots[i], expected)
						}
					}
				}
			},
		},
		{
			name:        "concurrent_nonce_generation",
			iterations:  10,
			concurrent:  true,
			goroutines:  10,
			expectError: false,
			description: "Should handle concurrent nonce generation safely",
			validate: func(t *testing.T, nonces []uint64) {
				require.Len(t, nonces, 100)

				nonceSet := make(map[uint64]bool)
				for i, nonce := range nonces {
					assert.False(t, nonceSet[nonce], "nonce %d (value: %x) should be unique", i, nonce)
					nonceSet[nonce] = true

					bucketID := uint32(nonce >> 32)
					slot := nonce & 0xFFFFFFFF
					assert.LessOrEqual(t, bucketID, uint32(NonceBucketMask))
					assert.LessOrEqual(t, slot, uint64(MaxValidSlot))
				}
			},
		},
		{
			name:        "high_concurrency_stress_test",
			iterations:  100,
			concurrent:  true,
			goroutines:  50,
			description: "Stress test with high concurrency",
			validate: func(t *testing.T, nonces []uint64) {
				require.Len(t, nonces, 5000)

				bucketCounts := make(map[uint32]int)
				for _, nonce := range nonces {
					bucketID := uint32(nonce >> 32)
					slot := nonce & 0xFFFFFFFF

					assert.LessOrEqual(t, bucketID, uint32(NonceBucketMask))
					assert.LessOrEqual(t, slot, uint64(MaxValidSlot))

					bucketCounts[bucketID]++
				}

				t.Logf("Generated nonces across %d different buckets", len(bucketCounts))
				maxCount := 0
				for _, count := range bucketCounts {
					if count > maxCount {
						maxCount = count
					}
				}
				t.Logf("Maximum nonces per bucket: %d", maxCount)

				// The only assertion that pins the generator to the bounded set: it fails both if the
				// draw is widened (thousands of buckets) and if it is narrowed (fewer than the set).
				// 5000 draws miss one of ReplayBuckets buckets with probability ~8e-7.
				assert.Len(t, bucketCounts, ReplayBuckets, "draws must cover exactly the bounded bucket set")
			},
		},
		{
			name:        "slot_wrapping_behavior",
			iterations:  300,
			concurrent:  false,
			description: "Should handle slot wrapping correctly when exceeding 234",
			setup: func(nm *NonceManager) {
				testBucketID := uint32(ReplayBuckets - 1)
				nm.bucketSlots[testBucketID].Store(250)
			},
			validate: func(t *testing.T, nonces []uint64) {
				bucketSlots := make(map[uint32][]uint64)
				for _, nonce := range nonces {
					bucketID := uint32(nonce >> 32)
					slot := nonce & 0xFFFFFFFF
					bucketSlots[bucketID] = append(bucketSlots[bucketID], slot)
				}

				for bucketID, slots := range bucketSlots {
					for i, slot := range slots {
						assert.LessOrEqual(t, slot, uint64(MaxValidSlot),
							"slot %d in bucket %d should be <= %d", i, bucketID, MaxValidSlot)
					}

					if len(slots) > 10 {
						t.Logf("Bucket %d generated %d slots, checking for wrapping", bucketID, len(slots))
					}
				}
			},
		},
		{
			name:        "nonce_construction_validation",
			iterations:  50,
			concurrent:  false,
			description: "Should construct nonces correctly with bucket ID in upper 32 bits",
			validate: func(t *testing.T, nonces []uint64) {
				for i, nonce := range nonces {
					bucketID := uint32(nonce >> 32)
					slot := nonce & 0xFFFFFFFF

					reconstructed := (uint64(bucketID) << 32) | slot
					assert.Equal(t, nonce, reconstructed,
						"nonce %d should be correctly constructed from bucket ID %d and slot %d",
						i, bucketID, slot)

					assert.Less(t, bucketID, uint32(ReplayBuckets),
						"bucket ID should be within the bounded set")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			nm := NewNonceManager()

			if tt.setup != nil {
				tt.setup(nm)
			}

			var nonces []uint64
			var mu sync.Mutex

			if tt.concurrent {
				var wg sync.WaitGroup
				for g := 0; g < tt.goroutines; g++ {
					wg.Add(1)
					go func() {
						defer wg.Done()
						for i := 0; i < tt.iterations; i++ {
							nonce, err := nm.GenerateValidNonce()
							if tt.expectError {
								assert.Error(t, err)
							} else {
								assert.NoError(t, err)
								mu.Lock()
								nonces = append(nonces, nonce)
								mu.Unlock()
							}
						}
					}()
				}
				wg.Wait()
			} else {
				for i := 0; i < tt.iterations; i++ {
					nonce, err := nm.GenerateValidNonce()
					if tt.expectError {
						assert.Error(t, err)
					} else {
						assert.NoError(t, err)
						nonces = append(nonces, nonce)
					}
				}
			}

			if tt.validate != nil {
				tt.validate(t, nonces)
			}
		})
	}
}

func BenchmarkNonceManager_GenerateValidNonce(b *testing.B) {
	nm := NewNonceManager()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, err := nm.GenerateValidNonce()
			if err != nil {
				b.Fatal(err)
			}
		}
	})
}

func TestNonceManager_ConcurrentPerformance(t *testing.T) {
	nm := NewNonceManager()

	const numGoroutines = 100
	const noncesPerGoroutine = 1000

	start := time.Now()

	var wg sync.WaitGroup
	var successCount int64

	for g := 0; g < numGoroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < noncesPerGoroutine; i++ {
				_, err := nm.GenerateValidNonce()
				require.NoError(t, err)
				atomic.AddInt64(&successCount, 1)
			}
		}()
	}

	wg.Wait()
	duration := time.Since(start)

	totalNonces := numGoroutines * noncesPerGoroutine
	noncesPerSecond := float64(totalNonces) / duration.Seconds()

	t.Logf("Generated %d nonces in %v", totalNonces, duration)
	t.Logf("Performance: %.0f nonces/second", noncesPerSecond)
	t.Logf("Success rate: %d/%d (%.2f%%)",
		successCount, totalNonces,
		float64(successCount)/float64(totalNonces)*100)

	assert.Equal(t, int64(totalNonces), successCount, "all nonces should be generated successfully")
	assert.Greater(t, noncesPerSecond, 100000.0, "should generate at least 100K nonces/second")
}

func TestNonceManager_UniqueNonces(t *testing.T) {
	nm := NewNonceManager()

	const numNonces = 10000
	nonces := make([]uint64, numNonces)

	for i := 0; i < numNonces; i++ {
		nonce, err := nm.GenerateValidNonce()
		require.NoError(t, err)
		nonces[i] = nonce
	}

	nonceSet := make(map[uint64]bool, numNonces)
	duplicates := 0

	for i, nonce := range nonces {
		if nonceSet[nonce] {
			t.Errorf("Duplicate nonce found at index %d: %x", i, nonce)
			duplicates++
		}
		nonceSet[nonce] = true
	}

	assert.Equal(t, 0, duplicates, "no duplicate nonces should be generated")
	assert.Len(t, nonceSet, numNonces, "all nonces should be unique")
}
