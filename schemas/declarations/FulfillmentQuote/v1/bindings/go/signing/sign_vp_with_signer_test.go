package ldverification

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// TestSignVPWithSigner_ByteIdenticalToRawKey pins the external-signer
// refactor as behavior-preserving for the VP (envelope) signer: signing
// through the Secp256k1Signer abstraction (raw key wrapped by
// NewECDSASigner) yields byte-identical wire output to the pre-existing
// raw-*ecdsa.PrivateKey path.
func TestSignVPWithSigner_ByteIdenticalToRawKey(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holderDID := "did:pkh:eip155:1:" + address
	created := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)

	vc := map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			lddataintegrity.KnownToAtumV1ContextURL,
		},
		"id":           "urn:uuid:7a3e9c01-2b5d-4f8a-9e7c-1d4a8c2b3f5e",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       "did:web:atumlabs.xyz",
		"issuanceDate": "2026-01-01T00:00:00Z",
		"credentialSubject": map[string]any{
			"id":   holderDID,
			"role": "settler",
		},
	}
	raw, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal vc: %v", err)
	}
	vcs := []json.RawMessage{raw}

	opts := SignVPOptions{
		Holder:             holderDID,
		VerificationMethod: holderDID + "#blockchainAccountId",
		Challenge:          "auction-signer-parity-1",
		Domain:             "did:web:settler.atum.network",
		Created:            created,
	}

	rawKeyOut, err := SignVP(vcs, priv, opts)
	if err != nil {
		t.Fatalf("SignVP (raw key): %v", err)
	}

	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		t.Fatalf("NewECDSASigner: %v", err)
	}
	signerOut, err := SignVPWithSigner(vcs, signer, opts)
	if err != nil {
		t.Fatalf("SignVPWithSigner: %v", err)
	}

	if !bytes.Equal(rawKeyOut, signerOut) {
		t.Fatalf("WithSigner output differs from raw-key path\n raw=%s\nsig=%s", rawKeyOut, signerOut)
	}
}
