package svm_escrow_encoding

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

// Cross-language parity against the AUTHORITATIVE golden produced by the
// on-chain escrow program's own compute_*_hash functions
// The Rust harness that originally produced it is gone along with the pre-v3 program, and the corpus
// is now FROZEN: these cases pin domain versions 1 and 2, which the current program can no longer
// produce (reserve/release/refund always bind quote_hash since v3; deposit always binds
// destination_hash since v4). It is the regression gate for the frozen legacy encoder functions.
//
// This retires the previous circular check where the Go/TS encoders were
// validated against vectors the TS encoder generated itself. The golden here is
// program-sourced: the Rust harness writes it, and the Rust test asserts the
// program still reproduces it. This Go test and the sibling TS test both assert
// their encoders reproduce the same hashes, so Rust + Go + TS are all validated
// against one source of truth. program_id is pinned to the real declare_id
// (crate::ID = 44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs).
//
// Regenerate the golden ONLY from the program:
//
//	cd contracts/svm/source && REGEN_GOLDEN=1 cargo test -p escrow parity_golden

const parityGoldenPath = "../../../../conformance/parity-golden.json"

// escrowProgramID (the real declare_id / crate::ID) is declared in
// reserve_parity_test.go and shared across this package's parity tests.

type goldenDomain struct {
	ClusterName            string `json:"cluster_name"`
	ClusterID              string `json:"cluster_id"` // hex[32]
	SignatureDomainVersion uint8  `json:"signature_domain_version"`
}

type goldenDeposit struct {
	DepositRequestHash string `json:"deposit_request_hash"` // hex[32]
	Depositor          string `json:"depositor"`            // base58
	Mint               string `json:"mint"`                 // base58
	Amount             string `json:"amount"`               // decimal string
	Reserver           string `json:"reserver"`             // base58
	Releaser           string `json:"releaser"`             // base58
	Nonce              string `json:"nonce"`                // decimal string
	IssuedAt           string `json:"issued_at"`            // decimal string
	Deadline           string `json:"deadline"`             // decimal string
}

type goldenExpected struct {
	DepositHash string `json:"deposit_hash"`
	ReserveHash string `json:"reserve_hash"`
	ReleaseHash string `json:"release_hash"`
	RefundHash  string `json:"refund_hash"`
}

type goldenCase struct {
	Name      string         `json:"name"`
	Domain    goldenDomain   `json:"domain"`
	Deposit   goldenDeposit  `json:"deposit"`
	Recipient string         `json:"recipient"` // base58
	Expected  goldenExpected `json:"expected"`
}

type goldenFile struct {
	Comment      string       `json:"_comment"`
	ProgramID    string       `json:"program_id"`     // base58 (crate::ID)
	ProgramIDHex string       `json:"program_id_hex"` // hex[32]
	Cases        []goldenCase `json:"cases"`
}

func loadParityGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile(parityGoldenPath)
	if err != nil {
		t.Fatalf("read parity golden %s (regenerate via REGEN_GOLDEN=1 cargo test -p escrow parity_golden): %v", parityGoldenPath, err)
	}
	var f goldenFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse parity golden: %v", err)
	}
	return f
}

func mustU64(t *testing.T, name, s string) uint64 {
	t.Helper()
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatalf("%s: parse uint64 %q: %v", name, s, err)
	}
	return v
}

func goldenDomainToEscrowDomain(t *testing.T, programID Pubkey, d goldenDomain) EscrowDomain {
	t.Helper()
	return EscrowDomain{
		ClusterID:              hexToBytes32(d.ClusterID),
		SignatureDomainVersion: d.SignatureDomainVersion,
		ProgramID:              programID,
	}
}

// TestParityGolden asserts the Go encoder reproduces every hash in the
// program-sourced golden, using program_id = crate::ID.
func TestParityGolden(t *testing.T) {
	f := loadParityGolden(t)

	// program_id must be the real declare_id and its hex encoding must agree.
	if f.ProgramID != escrowProgramID {
		t.Fatalf("golden program_id = %q, want crate::ID %q", f.ProgramID, escrowProgramID)
	}
	programID, err := PubkeyFromBase58(f.ProgramID)
	if err != nil {
		t.Fatalf("program id: %v", err)
	}
	if hex.EncodeToString(programID[:]) != f.ProgramIDHex {
		t.Fatalf("golden program_id_hex = %q, does not match base58 program_id %q", f.ProgramIDHex, f.ProgramID)
	}

	if len(f.Cases) == 0 {
		t.Fatal("parity golden has no cases")
	}

	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			domain := goldenDomainToEscrowDomain(t, programID, c.Domain)

			depositor, err := PubkeyFromBase58(c.Deposit.Depositor)
			if err != nil {
				t.Fatalf("depositor: %v", err)
			}
			mint, err := PubkeyFromBase58(c.Deposit.Mint)
			if err != nil {
				t.Fatalf("mint: %v", err)
			}
			reserver, err := PubkeyFromBase58(c.Deposit.Reserver)
			if err != nil {
				t.Fatalf("reserver: %v", err)
			}
			releaser, err := PubkeyFromBase58(c.Deposit.Releaser)
			if err != nil {
				t.Fatalf("releaser: %v", err)
			}
			recipient, err := PubkeyFromBase58(c.Recipient)
			if err != nil {
				t.Fatalf("recipient: %v", err)
			}

			depositHash, err := ComputeDepositHash(EscrowDepositParams{
				DepositRequestHash: hexToBytes32(c.Deposit.DepositRequestHash),
				Depositor:          depositor,
				Mint:               mint,
				Amount:             mustU64(t, "amount", c.Deposit.Amount),
				Reserver:           reserver,
				Releaser:           releaser,
				Nonce:              mustU64(t, "nonce", c.Deposit.Nonce),
				IssuedAt:           mustU64(t, "issued_at", c.Deposit.IssuedAt),
				Deadline:           mustU64(t, "deadline", c.Deposit.Deadline),
			}, domain)
			if err != nil {
				t.Fatalf("ComputeDepositHash: %v", err)
			}
			assertHashEq(t, "deposit", depositHash, c.Expected.DepositHash)

			reserveHash, err := ComputeReserveHash(EscrowReserveParams{
				DepositHash: depositHash,
				Recipient:   recipient,
			}, domain)
			if err != nil {
				t.Fatalf("ComputeReserveHash: %v", err)
			}
			assertHashEq(t, "reserve", reserveHash, c.Expected.ReserveHash)

			releaseHash, err := ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash}, domain)
			if err != nil {
				t.Fatalf("ComputeReleaseHash: %v", err)
			}
			assertHashEq(t, "release", releaseHash, c.Expected.ReleaseHash)

			refundHash, err := ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash}, domain)
			if err != nil {
				t.Fatalf("ComputeRefundHash: %v", err)
			}
			assertHashEq(t, "refund", refundHash, c.Expected.RefundHash)
		})
	}
}

func assertHashEq(t *testing.T, label string, got [32]byte, want string) {
	t.Helper()
	gotHex := hex.EncodeToString(got[:])
	if !strings.EqualFold(gotHex, strings.TrimPrefix(want, "0x")) {
		t.Errorf("%s hash mismatch:\ngot:  %s\nwant: %s", label, gotHex, want)
	}
}
