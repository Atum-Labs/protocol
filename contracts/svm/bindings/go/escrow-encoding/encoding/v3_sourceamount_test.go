package svm_escrow_encoding

import (
	"encoding/hex"
	"testing"

	"golang.org/x/crypto/sha3"
)

// CORE-2022 Solana parity (CORE-1887): the V3 reserve preimage binds the charged source amount.
//
// This is the cross-side anchor for V3 — the same fixture the Rust program pins in
// `reserve_hash_matches_the_documented_v5_layout`, fed through this encoder. It is the one place
// the program and this encoder are required to agree on an IDENTICAL input, which is what rules
// out a silent wire-format split between the party that signs and the program that verifies.
//
// The V2 anchor above it is deliberately left intact: V2 is still a valid historical layout, and
// the two together document that the only change is an appended little-endian u64.
func TestComputeReserveHashV3_CrossSideAnchor(t *testing.T) {
	// Authoritative, from the Rust program's compute_reserve_hash at domain version 5.
	// If this disagrees, one side drifted from the documented preimage layout — re-derive out of
	// band and fix that side, rather than pasting the computed value in.
	const wantReserveV3 = "d9f194eb2cdbbb060453ee08633a736adbbdb5efd7bf680de0997b18b145daf4"

	const sourceAmount uint64 = 90_000

	var clusterID [32]byte
	copy(clusterID[:], []byte("test"))
	domain := EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 5,
		ProgramID:              pubkeyFromHex(t, "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"),
	}

	depositHash := v2Fill(0x11)
	recipient := createFilledPubkey(0x22)
	quoteHash := v2Fill(0x33)

	got, err := ComputeReserveHashV3(
		EscrowReserveParams{DepositHash: depositHash, Recipient: recipient},
		quoteHash,
		sourceAmount,
		domain,
	)
	if err != nil {
		t.Fatalf("ComputeReserveHashV3: %v", err)
	}
	if hex.EncodeToString(got[:]) != wantReserveV3 {
		t.Fatalf("V3 reserve hash disagrees with the on-chain program for an identical input:\n"+
			" got  %s\n want %s", hex.EncodeToString(got[:]), wantReserveV3)
	}

	// Independently re-assemble the preimage field by field, so this still fails if a field is
	// reordered, dropped or re-encoded rather than merely agreeing with whatever the encoder
	// happens to emit.
	h := sha3.NewLegacyKeccak256()
	h.Write([]byte("escrow"))
	h.Write([]byte{5})
	h.Write(clusterID[:])
	h.Write(domain.ProgramID[:])
	h.Write([]byte("reserve"))
	h.Write(recipient[:])
	h.Write(depositHash[:])
	h.Write(quoteHash[:])
	h.Write(EncodeU64LE(sourceAmount))
	var spelled [32]byte
	copy(spelled[:], h.Sum(nil))

	if spelled != got {
		t.Fatalf("ComputeReserveHashV3 does not match the documented layout "+
			"escrow|version|cluster_id|program_id|\"reserve\"|recipient|deposit_hash|quote_hash|"+
			"source_amount(LE):\n got %s\n want %s",
			hex.EncodeToString(got[:]), hex.EncodeToString(spelled[:]))
	}
}

// The charge must actually be bound. Without this, `source_amount` could be accepted by the
// function and dropped before hashing, and every other test here would still pass — leaving a
// reserver signature for one charge able to authorize any other.
func TestComputeReserveHashV3_SourceAmountIsBound(t *testing.T) {
	var clusterID [32]byte
	copy(clusterID[:], []byte("test"))
	domain := EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 5,
		ProgramID:              pubkeyFromHex(t, "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"),
	}
	params := EscrowReserveParams{DepositHash: v2Fill(0x11), Recipient: createFilledPubkey(0x22)}
	quoteHash := v2Fill(0x33)

	a, err := ComputeReserveHashV3(params, quoteHash, 90_000, domain)
	if err != nil {
		t.Fatalf("ComputeReserveHashV3(90000): %v", err)
	}
	b, err := ComputeReserveHashV3(params, quoteHash, 100_000, domain)
	if err != nil {
		t.Fatalf("ComputeReserveHashV3(100000): %v", err)
	}
	if a == b {
		t.Fatal("source_amount is not bound into the reserve preimage")
	}
}

// A zero charge is refused here because the program refuses it: reserving zero narrows the deposit
// to nothing, so release would consume it and pay the settler nothing while the payer's funds came
// back as surplus — a settled payment that moved no value.
func TestComputeReserveHashV3_RejectsZeroSourceAmount(t *testing.T) {
	var clusterID [32]byte
	copy(clusterID[:], []byte("test"))
	domain := EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 5,
		ProgramID:              pubkeyFromHex(t, "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"),
	}

	_, err := ComputeReserveHashV3(
		EscrowReserveParams{DepositHash: v2Fill(0x11), Recipient: createFilledPubkey(0x22)},
		v2Fill(0x33),
		0,
		domain,
	)
	if err != ErrZeroSourceAmount {
		t.Fatalf("expected ErrZeroSourceAmount, got %v", err)
	}
}
