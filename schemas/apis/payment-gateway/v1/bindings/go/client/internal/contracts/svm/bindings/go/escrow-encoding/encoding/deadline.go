package svm_escrow_encoding

// ComputeDeadline returns issuedAt + ReplayHorizonSecs.
// The on-chain program enforces: issued_at <= deadline <= issued_at + REPLAY_HORIZON_SECS.
func ComputeDeadline(issuedAt uint64) uint64 {
	return issuedAt + ReplayHorizonSecs
}
