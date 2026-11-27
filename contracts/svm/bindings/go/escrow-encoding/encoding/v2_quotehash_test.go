package svm_escrow_encoding

import (
	"encoding/hex"
	"errors"
	"testing"
)

func v2Fill(b byte) [32]byte {
	var a [32]byte
	for i := range a {
		a[i] = b
	}
	return a
}

func pubkeyFromHex(t *testing.T, h string) Pubkey {
	t.Helper()
	b, err := hex.DecodeString(h)
	if err != nil || len(b) != 32 {
		t.Fatalf("bad program_id hex %q (len %d): %v", h, len(b), err)
	}
	var pk Pubkey
	copy(pk[:], b)
	return pk
}

// TestSolanaV2QuoteHashLayout pins each V2 encoder output to a literal derived out of band from
// the documented layout. Inputs: cluster "test", the escrow program's declared ID
// 44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs, signature_domain_version 3, deposit_hash 0x11,
// recipient 0x22, quote_hash 0x33. The release and refund literals are the ones the program's
// compute_release_hash and compute_refund_hash reproduce in
// contracts/svm/source/programs/escrow/tests/encoder_anchors.rs, and the TypeScript encoder pins
// them too, so each side fails on its own if it drifts.
func TestSolanaV2QuoteHashLayout(t *testing.T) {
	const (
		// Retired reserve layout (no source_amount); the current one is pinned in v3_sourceamount_test.go.
		wantReserve = "c9eaa290e13b1f46e72025806e6770494b324697d91bd844531dbfa1e84957ec"
		wantRelease = "f36c58efe96114e152ea68242ae176d6d0915155db834596b437ff90403b422d"
		wantRefund  = "749ed0f68c7e49b52dca8479aa0dfb9a61d355754fb6ed2ff432a2367175f594"
	)

	// Domain must match the inputs the constants above were derived from: version 3 and the
	// real program_id (crate::ID), not the dummy testEscrowDomain() program_id.
	var clusterID [32]byte
	copy(clusterID[:], []byte("test"))
	domain := EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 3,
		ProgramID:              pubkeyFromHex(t, "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"),
	}

	depositHash := v2Fill(0x11)
	recipient := createFilledPubkey(0x22)
	quoteHash := v2Fill(0x33)

	cases := []struct {
		name string
		want string
		got  func() ([32]byte, error)
	}{
		{"reserve", wantReserve, func() ([32]byte, error) {
			return ComputeReserveHashV2(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient}, quoteHash, domain)
		}},
		{"release", wantRelease, func() ([32]byte, error) {
			return ComputeReleaseHashV2(EscrowReleaseParams{DepositHash: depositHash}, quoteHash, domain)
		}},
		{"refund", wantRefund, func() ([32]byte, error) {
			return ComputeRefundHashV2(EscrowRefundParams{DepositHash: depositHash}, quoteHash, domain)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.got()
			if err != nil {
				t.Fatalf("%s V2 hash: %v", tc.name, err)
			}
			if hex.EncodeToString(got[:]) != tc.want {
				t.Fatalf("%s V2 anchor mismatch (encoder drifted from the program's layout):\n got  %x\n want %s", tc.name, got, tc.want)
			}
		})
	}
}

// TestSolanaReleaseRefundCurrentVersionAnchors pins release and refund at domain version 5, the
// version the program stamps today, on the same inputs as TestSolanaV2QuoteHashLayout. The program
// asserts the same literals in contracts/svm/source/programs/escrow/tests/encoder_anchors.rs.
func TestSolanaReleaseRefundCurrentVersionAnchors(t *testing.T) {
	const (
		wantRelease = "64d43a5fa2dd3cfa93bb47fb00affffb3dfaa1597174d3de2b646f34ae5c57fe"
		wantRefund  = "584a935d3088e3f30b1a47a4ac453f9a15f190b0a069781f69804af5a0995123"
	)

	var clusterID [32]byte
	copy(clusterID[:], []byte("test"))
	domain := EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 5,
		ProgramID:              pubkeyFromHex(t, "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"),
	}
	depositHash := v2Fill(0x11)
	quoteHash := v2Fill(0x33)

	release, err := ComputeReleaseHashV2(EscrowReleaseParams{DepositHash: depositHash}, quoteHash, domain)
	if err != nil {
		t.Fatalf("release: %v", err)
	}
	if got := hex.EncodeToString(release[:]); got != wantRelease {
		t.Fatalf("release v5 anchor mismatch:\n got  %s\n want %s", got, wantRelease)
	}

	refund, err := ComputeRefundHashV2(EscrowRefundParams{DepositHash: depositHash}, quoteHash, domain)
	if err != nil {
		t.Fatalf("refund: %v", err)
	}
	if got := hex.EncodeToString(refund[:]); got != wantRefund {
		t.Fatalf("refund v5 anchor mismatch:\n got  %s\n want %s", got, wantRefund)
	}
}

// TestSolanaV2DiffersFromV1 confirms binding quote_hash actually changes the digest.
func TestSolanaV2DiffersFromV1(t *testing.T) {
	domain := testEscrowDomain()
	depositHash := v2Fill(0x11)
	recipient := createFilledPubkey(0x22)
	quoteHash := v2Fill(0x33)

	rv1, _ := ComputeReserveHash(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient}, domain)
	rv2, _ := ComputeReserveHashV2(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient}, quoteHash, domain)
	if rv1 == rv2 {
		t.Error("reserve V2 must differ from V1 (quote_hash bound)")
	}
	lv1, _ := ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash}, domain)
	lv2, _ := ComputeReleaseHashV2(EscrowReleaseParams{DepositHash: depositHash}, quoteHash, domain)
	if lv1 == lv2 {
		t.Error("release V2 must differ from V1")
	}
	fv1, _ := ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash}, domain)
	fv2, _ := ComputeRefundHashV2(EscrowRefundParams{DepositHash: depositHash}, quoteHash, domain)
	if fv1 == fv2 {
		t.Error("refund V2 must differ from V1")
	}
}

// TestSolanaReserveV2RejectsEmptyQuoteHash mirrors the on-chain reserve non-empty guard.
func TestSolanaReserveV2RejectsEmptyQuoteHash(t *testing.T) {
	var empty [32]byte
	_, err := ComputeReserveHashV2(
		EscrowReserveParams{DepositHash: v2Fill(0x11), Recipient: createFilledPubkey(0x22)}, empty, testEscrowDomain())
	if !errors.Is(err, ErrZeroQuoteHash) {
		t.Fatalf("want ErrZeroQuoteHash, got %v", err)
	}
}
