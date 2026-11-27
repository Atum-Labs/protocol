package svm_escrow_encoding

import (
	"encoding/hex"
	"testing"
)

// Encoder-independent anchor for the SVM deposit hash.
//
// WHY THIS FILE EXISTS. v2_quotehash_test.go pins the reserve, release and refund
// hashes — but all three take deposit_hash as a fixed INPUT. Nothing pinned the
// computation of deposit_hash itself, so a field-order, endianness or padding bug
// in ComputeDepositHash would propagate into every settlement hash while all three
// V2 anchors still passed. deposit_hash is also the PDA seed and the payment's
// unique identifier, so a wrong value is not recoverable off-chain.
//
// THE ANCHOR IS DERIVED OUT OF BAND. The constant below was computed with an
// independent keccak-256 implementation (not this package, not any Go crypto
// helper in this repo) directly from the layout documented in solana-escrow
// programs/escrow/src/utils/signatures.rs::compute_deposit_hash:
//
//	keccak256(
//	  b"escrow" ‖ version[1] ‖ cluster_id[32] ‖ program_id[32] ‖ b"deposit" ‖
//	  payment_id[32] ‖ depositor[32] ‖ mint[32] ‖ amount[8, LE] ‖
//	  reserver[32] ‖ releaser[32] ‖ nonce[8, LE] ‖ issued_at[8, LE] ‖ deadline[8, LE]
//	)
//
// The derivation method was validated first by reproducing the already-committed
// release V2 anchor (f36c58ef…) byte-for-byte before being trusted on a new value.
// Preimage length is 270 bytes.
//
// DO NOT regenerate this constant by running the encoder and copying its output —
// that converts an independent oracle into a self-fulfilling one and is exactly the
// failure this file exists to prevent. On an intentional layout change, re-derive it
// out of band from the Rust source.
const wantDepositAnchor = "43c6d49de890ae1e26da862f32d0a786eb0a92b42193dbbe205c5af056b00381"

// Counterfactuals: the same preimage with one deliberate mistake, also derived out
// of band. They prove the anchor is sensitive to the two errors most likely to be
// made in this layout — transposing the adjacent 32-byte reserver/releaser pubkeys,
// and encoding a u64 big-endian instead of little-endian.
const (
	depositAnchorReserverReleaserTransposed = "a6080d4f22e341471fd4722bb0200802686b626fd8c025a5d78830b604939b61"
	depositAnchorAmountBigEndian            = "adfe18b857d0ab8810c275411c30979ec8bb586eef3cc8ceae565e35e2e54709"
)

// depositAnchorDomain matches the Rust inputs the anchor was derived from: domain
// version 3 and the real program_id (crate::ID), not the dummy testEscrowDomain()
// program_id. Kept identical to the domain in v2_quotehash_test.go so both anchor
// sets describe the same on-chain configuration.
func depositAnchorDomain(t *testing.T) EscrowDomain {
	t.Helper()
	var clusterID [32]byte
	copy(clusterID[:], []byte("test"))
	return EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 3,
		ProgramID:              pubkeyFromHex(t, "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"),
	}
}

func depositAnchorParams() EscrowDepositParams {
	return EscrowDepositParams{
		// #51 renamed this field PaymentID -> DepositRequestHash, for parity with the EVM and TVM
		// encoders which call the same value depositRequestHash. Same [32]byte type, so this
		// branch and #51 merge textually clean and the combined tree does not compile.
		DepositRequestHash: v2Fill(0x11),
		Depositor:          createFilledPubkey(0x22),
		Mint:               createFilledPubkey(0x33),
		Amount:             1_000_000,
		Reserver:           createFilledPubkey(0x44),
		Releaser:           createFilledPubkey(0x55),
		Nonce:              12345,
		IssuedAt:           1_700_000_000,
		Deadline:           1_700_000_128,
	}
}

// TestSolanaDepositHashMatchesOutOfBandAnchor is the root-of-chain guard: it pins
// ComputeDepositHash against a literal no code in this repo produced.
func TestSolanaDepositHashMatchesOutOfBandAnchor(t *testing.T) {
	got, err := ComputeDepositHash(depositAnchorParams(), depositAnchorDomain(t))
	if err != nil {
		t.Fatalf("ComputeDepositHash: %v", err)
	}
	if hex.EncodeToString(got[:]) != wantDepositAnchor {
		t.Fatalf("deposit anchor mismatch — ComputeDepositHash has drifted from the layout in\n"+
			"solana-escrow compute_deposit_hash. Check field ORDER, u64 endianness (must be\n"+
			"little-endian) and that no field was added or dropped. Do NOT repoint the anchor to\n"+
			"match: re-derive it out of band from the Rust source.\n got  %x\n want %s",
			got, wantDepositAnchor)
	}
}

// TestSolanaDepositAnchorCounterfactualsDiffer proves the anchor actually discriminates:
// if either counterfactual equalled the anchor, the test above could pass against a
// contract that made that specific mistake.
func TestSolanaDepositAnchorCounterfactualsDiffer(t *testing.T) {
	for name, cf := range map[string]string{
		"reserver/releaser transposed": depositAnchorReserverReleaserTransposed,
		"amount big-endian":            depositAnchorAmountBigEndian,
	} {
		if cf == wantDepositAnchor {
			t.Fatalf("counterfactual %q equals the anchor — the anchor cannot detect that mistake", name)
		}
	}
}

// TestSolanaDepositAnchorIsSensitiveToFieldOrder swaps the two adjacent 32-byte
// pubkeys through the encoder and requires the result to equal the independently
// derived transposed hash. This ties the encoder's ordering to an out-of-band value
// in BOTH directions: the correct order must hash to the anchor, and the wrong order
// must hash to the counterfactual.
func TestSolanaDepositAnchorIsSensitiveToFieldOrder(t *testing.T) {
	p := depositAnchorParams()
	p.Reserver, p.Releaser = p.Releaser, p.Reserver
	got, err := ComputeDepositHash(p, depositAnchorDomain(t))
	if err != nil {
		t.Fatalf("ComputeDepositHash (transposed): %v", err)
	}
	if hex.EncodeToString(got[:]) != depositAnchorReserverReleaserTransposed {
		t.Fatalf("transposing reserver/releaser did not produce the independently derived hash —\n"+
			"the encoder is not laying these fields out where the Rust program expects them.\n got  %x\n want %s",
			got, depositAnchorReserverReleaserTransposed)
	}
}
