package svm_escrow_encoding

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/sha3"
)

// Cross-side parity vectors for the SVM reserve hash, authored by the Go
// encoder and ANCHORED to the byte layout documented in the on-chain
// programs/escrow/src/utils/signatures.rs::compute_reserve_hash (the program
// that actually runs on chain).
//
// NOTE ON THE ANCHOR: the anchor values below are pinned constants re-derived
// from that documented Rust layout (b"escrow" ‖ version ‖ cluster_id ‖
// program_id ‖ b"reserve" ‖ recipient ‖ deposit_hash, keccak256) using the
// real declare_id!. They are NOT produced by executing the actual Rust program
// in CI — this repo runs no cargo. TestReserveAnchorsMatchDocumentedLayout
// re-derives them here from the layout WITHOUT calling the encoder, so a
// field-ordering/padding bug in the Go encoder (or a hand-transcription error)
// cannot hide. The fully independent oracle — a Rust #[test] in the
// Solana escrow contract project asserting these from compute_reserve_hash — is
// a noted residual (see contracts/encoding-parity.md), not done here.
//
// The committed file vectors.json is FROZEN. Both this
// Go test and the sibling TS test (reserve-parity.test.ts) read it and assert
// byte-equality; not regenerated in CI. (This is separate from
// test_vectors.json, which covers the broader deposit/release/refund legs and
// stays as-is.)
//
// Regenerate ONLY on an intentional encoding change:
//
//	REGEN_PARITY=1 go test ./... -run TestRegenerateReserveParityVectors

const reserveParityVectorsPath = "../../../../conformance/vectors.json"

// Anchors re-derived from the documented compute_reserve_hash layout using the
// real declare_id! (programs/escrow). program_id =
// 44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs, recipient =
// EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, deposit_hash = 0x11*32.
// Re-proven against the layout in TestReserveAnchorsMatchDocumentedLayout.
const (
	rustAnchorDevnetV2 = "0x5241b6fea2b7ba0b3c0dd7a489967aab8a225c71a153c5a9552df51b1f198550"
	rustAnchorDevnetV1 = "0xc8b9df667022b28dc63b845b893e85d3c2231aa6843c19de01bbdef0857ea5a7"
)

const escrowProgramID = "44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs"

type reserveParityVector struct {
	Name         string `json:"name"`
	Version      uint8  `json:"version"`
	ClusterID    string `json:"clusterId"`    // hex[32]
	ProgramID    string `json:"programId"`    // hex[32]
	Recipient    string `json:"recipient"`    // hex[32]
	DepositHash  string `json:"depositHash"`  // hex[32]
	ExpectedHash string `json:"expectedHash"` // 0x-hex[32]
}

type reserveParityFile struct {
	Comment string                `json:"_comment"`
	Reserve []reserveParityVector `json:"reserve"`
}

const reserveParityComment = "FROZEN cross-side parity vectors (SVM). Go-authored, anchored to the Rust " +
	"on-chain compute_reserve_hash. Both reserve_parity_test.go (Go) and reserve-parity.test.ts (TS) " +
	"assert against this file; do not edit by hand. Regenerate via: " +
	"REGEN_PARITY=1 go test ./... -run TestRegenerateReserveParityVectors"

// reserveParityInput is the authored form (base58 + cluster name); resolved to
// the hex bytes stored in the frozen file.
type reserveParityInput struct {
	name         string
	cluster      string
	version      uint8
	recipientB58 string
	depositHash  [32]byte
}

func filled32(b byte) [32]byte {
	var out [32]byte
	for i := range out {
		out[i] = b
	}
	return out
}

func reserveParityInputs() []reserveParityInput {
	const recipientUSDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	const recipientWSOL = "So11111111111111111111111111111111111111112"
	return []reserveParityInput{
		// Anchored to Rust (production domain version 2, and the version-1 contrast).
		{name: "anchor/devnet-v2", cluster: "devnet", version: 2, recipientB58: recipientUSDC, depositHash: filled32(0x11)},
		{name: "devnet-v1", cluster: "devnet", version: 1, recipientB58: recipientUSDC, depositHash: filled32(0x11)},
		// Edge cases (Go-authored, frozen, dual-asserted).
		{name: "max-deposit-hash-v2", cluster: "devnet", version: 2, recipientB58: recipientUSDC, depositHash: filled32(0xff)},
		{name: "alt-recipient-v2", cluster: "devnet", version: 2, recipientB58: recipientWSOL, depositHash: filled32(0x11)},
		{name: "mainnet-cluster-v2", cluster: "mainnet", version: 2, recipientB58: recipientUSDC, depositHash: filled32(0x11)},
	}
}

func computeReserveParityVector(t *testing.T, in reserveParityInput) reserveParityVector {
	t.Helper()
	programID, err := PubkeyFromBase58(escrowProgramID)
	if err != nil {
		t.Fatalf("%s: program id: %v", in.name, err)
	}
	domain, err := NewEscrowDomain(in.cluster, in.version, programID)
	if err != nil {
		t.Fatalf("%s: domain: %v", in.name, err)
	}
	recipient, err := PubkeyFromBase58(in.recipientB58)
	if err != nil {
		t.Fatalf("%s: recipient: %v", in.name, err)
	}
	hash, err := ComputeReserveHash(EscrowReserveParams{DepositHash: in.depositHash, Recipient: recipient}, domain)
	if err != nil {
		t.Fatalf("%s: ComputeReserveHash: %v", in.name, err)
	}
	return reserveParityVector{
		Name:         in.name,
		Version:      in.version,
		ClusterID:    hex.EncodeToString(domain.ClusterID[:]),
		ProgramID:    hex.EncodeToString(programID[:]),
		Recipient:    hex.EncodeToString(recipient[:]),
		DepositHash:  hex.EncodeToString(in.depositHash[:]),
		ExpectedHash: "0x" + hex.EncodeToString(hash[:]),
	}
}

func loadReserveParityFile(t *testing.T) reserveParityFile {
	t.Helper()
	data, err := os.ReadFile(reserveParityVectorsPath)
	if err != nil {
		t.Fatalf("read parity vectors (run TestRegenerateReserveParityVectors with REGEN_PARITY=1): %v", err)
	}
	var f reserveParityFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse parity vectors: %v", err)
	}
	return f
}

func decodeHash32(t *testing.T, name, s string) [32]byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil || len(b) != 32 {
		t.Fatalf("%s: bad 32-byte hex %q: %v", name, s, err)
	}
	var out [32]byte
	copy(out[:], b)
	return out
}

// TestReserveParity asserts the production Go encoder reproduces every frozen
// vector byte-for-byte. The TS test asserts the same file independently.
func TestReserveParity(t *testing.T) {
	f := loadReserveParityFile(t)
	if len(f.Reserve) == 0 {
		t.Fatal("parity vectors file is empty")
	}
	for _, v := range f.Reserve {
		domain := EscrowDomain{
			ClusterID:              decodeHash32(t, v.Name+".clusterId", v.ClusterID),
			SignatureDomainVersion: v.Version,
			ProgramID:              Pubkey(decodeHash32(t, v.Name+".programId", v.ProgramID)),
		}
		hash, err := ComputeReserveHash(EscrowReserveParams{
			DepositHash: decodeHash32(t, v.Name+".depositHash", v.DepositHash),
			Recipient:   Pubkey(decodeHash32(t, v.Name+".recipient", v.Recipient)),
		}, domain)
		if err != nil {
			t.Errorf("reserve %q: ComputeReserveHash: %v", v.Name, err)
			continue
		}
		got := "0x" + hex.EncodeToString(hash[:])
		if !strings.EqualFold(got, v.ExpectedHash) {
			t.Errorf("reserve %q: got %s want %s", v.Name, got, v.ExpectedHash)
		}
	}
}

// svmReserveAnchors ties the named frozen vectors to the layout-derived anchor
// constants. Asserted in CI by TestReserveParityAnchors — not only in the
// REGEN-gated regenerator — so the gate proves the frozen file matches the
// documented chain layout (re-proven in TestReserveAnchorsMatchDocumentedLayout),
// not merely that Go and TS agree with the committed blob.
var svmReserveAnchors = map[string]string{
	"anchor/devnet-v2": rustAnchorDevnetV2,
	"devnet-v1":        rustAnchorDevnetV1,
}

// TestReserveAnchorsMatchDocumentedLayout independently re-derives the anchor
// hashes from the byte layout documented in compute_reserve_hash, WITHOUT
// calling ComputeReserveHash / EscrowDomainPrefixBytes. This proves the anchor
// constants match the documented on-chain layout (cluster_id = "devnet" right-
// padded to 32 bytes, real declare_id! program ID), so a field-ordering or
// padding bug in the encoder — or a hand-transcription error in the constants —
// is caught rather than silently baked into the frozen file.
func TestReserveAnchorsMatchDocumentedLayout(t *testing.T) {
	programID, err := PubkeyFromBase58(escrowProgramID)
	if err != nil {
		t.Fatalf("program id: %v", err)
	}
	recipient, err := PubkeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	if err != nil {
		t.Fatalf("recipient: %v", err)
	}
	depositHash := filled32(0x11)

	clusterID := make([]byte, 32) // "devnet" right-padded with zeros (ProtocolConfig.cluster_id)
	copy(clusterID, "devnet")

	derive := func(version byte) string {
		h := sha3.NewLegacyKeccak256()
		h.Write([]byte("escrow"))
		h.Write([]byte{version})
		h.Write(clusterID)
		h.Write(programID[:])
		h.Write([]byte("reserve"))
		h.Write(recipient[:])
		h.Write(depositHash[:])
		var out [32]byte
		h.Sum(out[:0])
		return "0x" + hex.EncodeToString(out[:])
	}

	if got := derive(2); !strings.EqualFold(got, rustAnchorDevnetV2) {
		t.Errorf("devnet-v2 documented-layout hash = %s, want anchor %s", got, rustAnchorDevnetV2)
	}
	if got := derive(1); !strings.EqualFold(got, rustAnchorDevnetV1) {
		t.Errorf("devnet-v1 documented-layout hash = %s, want anchor %s", got, rustAnchorDevnetV1)
	}
}

// TestReserveParityAnchors pins the frozen file's anchor vectors to the
// layout-derived anchor constants inside the CI gate.
func TestReserveParityAnchors(t *testing.T) {
	f := loadReserveParityFile(t)
	matched := 0
	for _, v := range f.Reserve {
		if want, ok := svmReserveAnchors[v.Name]; ok {
			matched++
			if !strings.EqualFold(v.ExpectedHash, want) {
				t.Errorf("reserve anchor %q = %s, want Rust on-chain value %s", v.Name, v.ExpectedHash, want)
			}
		}
	}
	if matched != len(svmReserveAnchors) {
		t.Fatalf("expected %d anchor vectors in frozen file, found %d (anchor dropped?)", len(svmReserveAnchors), matched)
	}
}

// TestRegenerateReserveParityVectors re-authors the frozen file from the Go
// encoder. Opt-in (REGEN_PARITY=1). It asserts the anchored vectors equal the
// independent Rust on-chain values before writing, so a shared Go/TS bug cannot
// silently re-baseline.
func TestRegenerateReserveParityVectors(t *testing.T) {
	if os.Getenv("REGEN_PARITY") != "1" {
		t.Skip("set REGEN_PARITY=1 to regenerate the frozen parity vectors")
	}
	rustAnchors := svmReserveAnchors
	f := reserveParityFile{Comment: reserveParityComment}
	for _, in := range reserveParityInputs() {
		v := computeReserveParityVector(t, in)
		if want, ok := rustAnchors[v.Name]; ok && !strings.EqualFold(v.ExpectedHash, want) {
			t.Fatalf("anchor %q regenerated to %s, expected independent Rust on-chain value %s", v.Name, v.ExpectedHash, want)
		}
		f.Reserve = append(f.Reserve, v)
	}
	out, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(reserveParityVectorsPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(reserveParityVectorsPath, append(out, '\n'), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Logf("wrote %s (%d reserve vectors, 2 Rust-anchored)", reserveParityVectorsPath, len(f.Reserve))
}
