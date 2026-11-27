package svm_escrow_encoding

import (
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestBuildReserveWitness_HappyPath(t *testing.T) {
	depositHash := createFilledBytes32(0x11)
	recipient, err := PubkeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	if err != nil {
		t.Fatalf("failed to parse recipient: %v", err)
	}

	reserveHash, prehashJSON, err := BuildReserveWitness(depositHash, recipient, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The witness reserve hash must equal the direct encoder output.
	directHash, err := ComputeReserveHash(EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}, testEscrowDomain())
	if err != nil {
		t.Fatalf("ComputeReserveHash failed: %v", err)
	}
	if reserveHash != directHash {
		t.Errorf("BuildReserveWitness and ComputeReserveHash disagree:\nwitness: %x\ndirect:  %x", reserveHash, directHash)
	}

	var prehash SolanaReservePrehash
	if err := json.Unmarshal([]byte(prehashJSON), &prehash); err != nil {
		t.Fatalf("prehash JSON is not valid: %v", err)
	}
	if prehash.DepositHash != "0x"+hex.EncodeToString(depositHash[:]) {
		t.Errorf("deposit_hash mismatch:\ngot:  %s\nwant: 0x%s", prehash.DepositHash, hex.EncodeToString(depositHash[:]))
	}
	if prehash.Recipient != recipient.String() {
		t.Errorf("recipient mismatch:\ngot:  %s\nwant: %s", prehash.Recipient, recipient.String())
	}
}

func TestBuildReserveWitness_PrehashIsRecomputable(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}
	recipient, err := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	if err != nil {
		t.Fatalf("failed to parse recipient: %v", err)
	}

	reserveHash, prehashJSON, err := BuildReserveWitness(depositHash, recipient, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var prehash SolanaReservePrehash
	if err := json.Unmarshal([]byte(prehashJSON), &prehash); err != nil {
		t.Fatalf("prehash JSON is not valid: %v", err)
	}

	reDepositHash, err := parseHexBytes32(prehash.DepositHash)
	if err != nil {
		t.Fatalf("failed to parse deposit_hash from JSON: %v", err)
	}
	reRecipient, err := PubkeyFromBase58(prehash.Recipient)
	if err != nil {
		t.Fatalf("failed to parse recipient from JSON: %v", err)
	}

	reReserveHash, err := ComputeReserveHash(EscrowReserveParams{
		DepositHash: reDepositHash,
		Recipient:   reRecipient,
	}, testEscrowDomain())
	if err != nil {
		t.Fatalf("re-compute failed: %v", err)
	}

	if reReserveHash != reserveHash {
		t.Errorf("verifier cannot re-derive reserve hash from prehash JSON:\ngot:  %x\nwant: %x", reReserveHash, reserveHash)
	}
}

func TestBuildReserveWitness_ZeroDepositHash(t *testing.T) {
	recipient, err := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	if err != nil {
		t.Fatalf("failed to parse recipient: %v", err)
	}

	_, _, err = BuildReserveWitness([32]byte{}, recipient, testEscrowDomain())
	if err == nil {
		t.Error("expected error for zero deposit hash")
	}
}

func TestBuildReserveWitness_ZeroRecipient(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}

	_, _, err := BuildReserveWitness(depositHash, Pubkey{}, testEscrowDomain())
	if err == nil {
		t.Error("expected error for zero recipient")
	}
}
