package svm_escrow_encoding

import (
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

// The v4 deposit witness (CORE-2120) inputs, spelled to match the on-chain program's own test fixtures
// byte-for-byte. Sharing the inputs is what lets Go pin the SAME anchor the Rust program pins, rather
// than a Go-flavoured value that would only prove Go agrees with itself.
const (
	// The escrow program's declared ID, 44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs, as raw hex so no
	// base58 decoder sits in the derivation path.
	v4ProgramIDHex = "2d66325a159b21433ca818ab4b70519d166c8c9684ddd218637147896c012238"
	// So11111111111111111111111111111111111111112 (wSOL) — depositor.
	v4DepositorHex = "069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001"
	// EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC mint) — mint.
	v4MintHex = "c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61"

	v4Amount   uint64 = 1_000_000
	v4Nonce    uint64 = 0x0000_0001_0000_0007 // bucket 1, slot 7
	v4IssuedAt uint64 = 1_700_000_000
	v4Deadline uint64 = v4IssuedAt + 128 // + REPLAY_HORIZON_SECS

	// The ratified canonical destination form: `<CAIP-19 asset>@<account>`, lowercase throughout for an
	// eip155 namespace. 103 bytes, comfortably inside MaxDestinationLen.
	v4Destination = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979"

	// keccak256(v4Destination). Byte-identical to the value EVM and TVM pin for the same canonical
	// string — that cross-VM equality is the whole point of committing to a plaintext destination.
	v4DestinationHashHex = "7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef"

	// keccak256("escrow" ‖ 4 ‖ cluster ‖ program ‖ "deposit" ‖ deposit_request_hash ‖ destination_hash ‖
	//           depositor ‖ mint ‖ amount_le ‖ reserver ‖ releaser ‖ nonce_le ‖ issued_at_le ‖ deadline_le)
	//
	// Derived OUT OF BAND with an independent keccak-256 (foundry `cast keccak`) from the documented
	// layout — not by running this package, and not by running the Rust program. It is the identical
	// literal the on-chain program pins as ANCHOR_DEPOSIT_V4_DEVNET, so this single value now binds the
	// Rust program, this Go encoder and the TypeScript encoder to one preimage. If any of the three
	// drifts, exactly one of them starts failing.
	v4AnchorDepositDevnet = "434c316fefd017642e55c0c037c8848d753ccb5449fac1292b15752c3f34b5f8"

	// The same inputs with the destination fed in RAW instead of hashed. Also derived out of band. This
	// is the value an unsound implementation produces; the real one must differ from it.
	v4AnchorDepositRawDestinationFed = "d36b4a6aaacb3ba72c68039cccef9977ff2f231aa5608b9f1a7ab9ff2eeca4ed"
)

// v4DevnetDomain is the domain the anchors above were derived against: cluster "devnet" zero-padded to
// 32 bytes, signature_domain_version 4, and the real program ID.
func v4DevnetDomain(t *testing.T) EscrowDomain {
	t.Helper()
	var clusterID [32]byte
	copy(clusterID[:], []byte("devnet"))
	return EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: 4,
		ProgramID:              pubkeyFromHex(t, v4ProgramIDHex),
	}
}

func v4DepositParams(t *testing.T) EscrowDepositParams {
	t.Helper()
	return EscrowDepositParams{
		DepositRequestHash: v2Fill(0x44),
		Depositor:          pubkeyFromHex(t, v4DepositorHex),
		Mint:               pubkeyFromHex(t, v4MintHex),
		Amount:             v4Amount,
		Reserver:           pubkeyFromHex(t, strings.Repeat("55", 32)),
		Releaser:           pubkeyFromHex(t, strings.Repeat("66", 32)),
		Nonce:              v4Nonce,
		IssuedAt:           v4IssuedAt,
		Deadline:           v4Deadline,
	}
}

// TestComputeDestinationHash_MatchesCrossVMValue pins the destination hash on its own.
//
// Worth a test separate from the deposit anchor: this is the one value that must be byte-identical
// across EVM, TVM and SVM for the same destination string. Pinning it here means a change to how the
// string becomes bytes fails with an unambiguous message, instead of surfacing as an opaque deposit-hash
// mismatch.
func TestComputeDestinationHash_MatchesCrossVMValue(t *testing.T) {
	dh := ComputeDestinationHash(v4Destination)
	got := hex.EncodeToString(dh[:])
	if got != v4DestinationHashHex {
		t.Fatalf("destination hash drifted from the cross-VM value:\n got  %s\n want %s", got, v4DestinationHashHex)
	}
}

// TestComputeDepositHashV2_MatchesProgramAnchor is the cross-language gate: this Go encoder must
// reproduce the exact deposit hash the on-chain Rust program pins for identical inputs.
func TestComputeDepositHashV2_MatchesProgramAnchor(t *testing.T) {
	got, err := ComputeDepositHashV2(v4DepositParams(t), v4Destination, v4DevnetDomain(t))
	if err != nil {
		t.Fatalf("ComputeDepositHashV2: %v", err)
	}
	if h := hex.EncodeToString(got[:]); h != v4AnchorDepositDevnet {
		t.Fatalf("v4 deposit hash does not match the program's ANCHOR_DEPOSIT_V4_DEVNET:\n got  %s\n want %s", h, v4AnchorDepositDevnet)
	}
}

// TestComputeDepositHashV2_RejectsRawDestinationFeed proves the destination is hashed to fixed width
// before entering the preimage, rather than concatenated raw.
//
// Keccak256 concatenates without length prefixes, so injectivity depends on every hashed field being
// fixed-width. A raw variable-length feed happens to survive today with exactly one such field, but it
// diverges from the program and breaks silently the moment a second one is added. Asserting only the
// positive anchor would not catch a raw feed reintroduced alongside a regenerated anchor; asserting the
// real hash DIFFERS from the raw-fed value is what closes that hole.
func TestComputeDepositHashV2_RejectsRawDestinationFeed(t *testing.T) {
	got, err := ComputeDepositHashV2(v4DepositParams(t), v4Destination, v4DevnetDomain(t))
	if err != nil {
		t.Fatalf("ComputeDepositHashV2: %v", err)
	}
	if h := hex.EncodeToString(got[:]); h == v4AnchorDepositRawDestinationFed {
		t.Fatalf("destination is being fed RAW into the preimage instead of hashed: got the unsound value %s", h)
	}
}

// TestComputeDepositHashV2_DestinationIsLoadBearing guards against the destination being accepted,
// validated, and then silently dropped from the preimage — which the positive anchor alone would catch
// only if the anchor were correct, and which a regenerated anchor would hide.
func TestComputeDepositHashV2_DestinationIsLoadBearing(t *testing.T) {
	params := v4DepositParams(t)
	domain := v4DevnetDomain(t)

	base, err := ComputeDepositHashV2(params, v4Destination, domain)
	if err != nil {
		t.Fatalf("ComputeDepositHashV2 base: %v", err)
	}

	// A one-character change: the account's last nibble.
	altered := v4Destination[:len(v4Destination)-1] + "8"
	other, err := ComputeDepositHashV2(params, altered, domain)
	if err != nil {
		t.Fatalf("ComputeDepositHashV2 altered: %v", err)
	}
	if base == other {
		t.Fatal("changing the destination did not change the deposit hash; the commitment is not load-bearing")
	}

	// And it must differ from the frozen V1 layout, which commits to no destination at all.
	v1, err := ComputeDepositHash(params, domain)
	if err != nil {
		t.Fatalf("ComputeDepositHash: %v", err)
	}
	if base == v1 {
		t.Fatal("V2 and V1 deposit hashes are equal; the destination is not entering the V2 preimage")
	}
}

// TestComputeDepositHashV2_DestinationCasingIsPreserved pins the base58 carve-out.
//
// The ratified rule lowercases hex segments but preserves base58 byte-for-byte, because base58 is
// case-significant: a Solana mint or account that gets blanket-lowercased is a DIFFERENT address. This
// asserts the encoder does not normalise, which is the behaviour that makes the rule enforceable
// off-chain rather than silently corrupting Solana destinations.
func TestComputeDepositHashV2_DestinationCasingIsPreserved(t *testing.T) {
	const solanaDestination = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v@9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"

	params := v4DepositParams(t)
	domain := v4DevnetDomain(t)

	asIs, err := ComputeDepositHashV2(params, solanaDestination, domain)
	if err != nil {
		t.Fatalf("ComputeDepositHashV2 as-is: %v", err)
	}
	lowered, err := ComputeDepositHashV2(params, strings.ToLower(solanaDestination), domain)
	if err != nil {
		t.Fatalf("ComputeDepositHashV2 lowered: %v", err)
	}
	if asIs == lowered {
		t.Fatal("lowercasing a base58 destination did not change the hash; the encoder is normalising case and would corrupt Solana destinations")
	}
}

// TestComputeDepositHashV2_DestinationBounds covers the two validation edges.
func TestComputeDepositHashV2_DestinationBounds(t *testing.T) {
	params := v4DepositParams(t)
	domain := v4DevnetDomain(t)

	if _, err := ComputeDepositHashV2(params, "", domain); !errors.Is(err, ErrEmptyDestination) {
		t.Fatalf("empty destination: got %v, want ErrEmptyDestination", err)
	}

	atLimit := strings.Repeat("a", MaxDestinationLen)
	if _, err := ComputeDepositHashV2(params, atLimit, domain); err != nil {
		t.Fatalf("destination at exactly MaxDestinationLen (%d) must be accepted: %v", MaxDestinationLen, err)
	}

	overLimit := strings.Repeat("a", MaxDestinationLen+1)
	if _, err := ComputeDepositHashV2(params, overLimit, domain); !errors.Is(err, ErrDestinationTooLong) {
		t.Fatalf("destination at MaxDestinationLen+1: got %v, want ErrDestinationTooLong", err)
	}
}

// TestComputeDepositHashV2_KeepsV4DestinationRules pins the v4 witness: invalid UTF-8 is hashed as
// is, as before escrow-text-v1. Only ValidateAndHashDestination, the v5 argument, refuses it.
func TestComputeDepositHashV2_KeepsV4DestinationRules(t *testing.T) {
	const notUTF8 = "eip155:1/erc20:0x01@\xff"
	got, err := ComputeDepositHashV2(v4DepositParams(t), notUTF8, v4DevnetDomain(t))
	if err != nil {
		t.Fatalf("v4 deposit hash refused an invalid UTF-8 destination: %v", err)
	}
	if got == ([32]byte{}) {
		t.Fatal("v4 deposit hash is zero")
	}
}

// TestValidateAndHashDestination covers the deposit instruction's destination_hash argument.
func TestValidateAndHashDestination(t *testing.T) {
	got, err := ValidateAndHashDestination(testDestination)
	if err != nil {
		t.Fatalf("ValidateAndHashDestination: %v", err)
	}
	if got != ComputeDestinationHash(testDestination) {
		t.Fatal("ValidateAndHashDestination diverged from ComputeDestinationHash")
	}

	if _, err := ValidateAndHashDestination(""); !errors.Is(err, ErrEmptyDestination) {
		t.Fatalf("empty destination: got %v, want ErrEmptyDestination", err)
	}
	if _, err := ValidateAndHashDestination("eip155:1/erc20:0x01@\xff"); !errors.Is(err, ErrDestinationNotUTF8) {
		t.Fatalf("invalid UTF-8 destination: got %v, want ErrDestinationNotUTF8", err)
	}
	if _, err := ValidateAndHashDestination(strings.Repeat("a", MaxDestinationLen)); err != nil {
		t.Fatalf("destination at exactly MaxDestinationLen must be accepted: %v", err)
	}
	if _, err := ValidateAndHashDestination(strings.Repeat("a", MaxDestinationLen+1)); !errors.Is(err, ErrDestinationTooLong) {
		t.Fatalf("destination at MaxDestinationLen+1: got %v, want ErrDestinationTooLong", err)
	}
}

// TestComputeDepositHash_V1LayoutStaysFrozen asserts the legacy deposit witness cannot produce the v4
// value, and vice versa.
//
// The point is that adding the destination did not quietly redefine what domain versions 1..=3 signed.
// Historical deposits are still verified against the V1 layout, so an "upgrade" of ComputeDepositHash in
// place would invalidate them — this test makes that failure loud.
func TestComputeDepositHash_V1LayoutStaysFrozen(t *testing.T) {
	got, err := ComputeDepositHash(v4DepositParams(t), v4DevnetDomain(t))
	if err != nil {
		t.Fatalf("ComputeDepositHash: %v", err)
	}
	if h := hex.EncodeToString(got[:]); h == v4AnchorDepositDevnet {
		t.Fatal("the frozen V1 deposit layout is producing the v4 anchor; the destination leaked into V1")
	}
}
