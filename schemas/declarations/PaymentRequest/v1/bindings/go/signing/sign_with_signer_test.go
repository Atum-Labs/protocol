package ldverification

import (
	"bytes"
	"strings"
	"testing"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// TestSignPaymentRequestWithSigner_ByteIdenticalToRawKey pins the external
// signer refactor as behavior preserving. Signing through the Secp256k1Signer
// abstraction (raw key wrapped by NewECDSASigner) yields byte identical wire
// output to the pre existing raw *ecdsa.PrivateKey path. If this diverges, the
// KMS signer seam changed the on wire proof for the dev/local path.
func TestSignPaymentRequestWithSigner_ByteIdenticalToRawKey(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	created := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	opts := SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            created,
	}

	newDoc := func() map[string]any {
		return map[string]any{
			"version":    "1.0",
			"request_id": "req-pr-signer-parity",
			"source": map[string]any{
				"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
				"account":          address,
			},
			"destination": []any{map[string]any{
				"asset_identifier": "eip155:1/erc20:0xbbb",
				"account":          "0x0000000000000000000000000000000000000002",
			}},
			"fulfillment_amount":   "1000000",
			"quote_deadline":       "2030-01-01T00:00:00Z",
			"fulfillment_deadline": "2030-01-02T00:00:00Z",
		}
	}

	rawKeyOut, err := SignPaymentRequest(newDoc(), priv, opts)
	if err != nil {
		t.Fatalf("SignPaymentRequest (raw key): %v", err)
	}

	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		t.Fatalf("NewECDSASigner: %v", err)
	}
	signerOut, err := SignPaymentRequestWithSigner(newDoc(), signer, opts)
	if err != nil {
		t.Fatalf("SignPaymentRequestWithSigner: %v", err)
	}

	if !bytes.Equal(rawKeyOut, signerOut) {
		t.Fatalf("WithSigner output differs from raw-key path\n raw=%s\nsig=%s", rawKeyOut, signerOut)
	}
}

// fakeSigner returns a fixed signature regardless of digest. Used to drive the
// signer output guard branches.
type fakeSigner struct{ sig []byte }

func (f fakeSigner) SignDigest([]byte) ([]byte, error) { return f.sig, nil }
func (f fakeSigner) PublicKeyUncompressed() []byte     { return make([]byte, 65) }

// TestSignPaymentRequestWithSigner_RejectsBadSignerOutput pins the fail closed
// contract on the Secp256k1Signer output. The sign core must reject a signature
// that isn't 65 bytes, or whose v is already >1 (a signer that wrongly
// pre applied the +27 alignment, where double adding would corrupt the recovery
// id).
func TestSignPaymentRequestWithSigner_RejectsBadSignerOutput(t *testing.T) {
	opts := SignOptions{
		VerificationMethod: "did:pkh:eip155:1:0x742d35cc6634c0532925a3b8d8c5e48c4e6b4a72#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
	}
	doc := map[string]any{
		"version":              "1.0",
		"request_id":           "req-bad-signer",
		"fulfillment_amount":   "1000000",
		"quote_deadline":       "2030-01-01T00:00:00Z",
		"fulfillment_deadline": "2030-01-02T00:00:00Z",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
			"account":          "0x742d35cc6634c0532925a3b8d8c5e48c4e6b4a72",
		},
		"destination": []any{map[string]any{
			"asset_identifier": "eip155:1/erc20:0xbbb",
			"account":          "0x0000000000000000000000000000000000000002",
		}},
	}

	// v already aligned to 27 (contract violation: signer must return v ∈ {0,1}).
	preAligned := make([]byte, 65)
	preAligned[64] = 27
	if _, err := SignPaymentRequestWithSigner(cloneMap(doc), fakeSigner{sig: preAligned}, opts); err == nil {
		t.Fatal("expected error when signer returns v>1 (pre-applied +27)")
	}

	// Wrong length.
	if _, err := SignPaymentRequestWithSigner(cloneMap(doc), fakeSigner{sig: make([]byte, 64)}, opts); err == nil {
		t.Fatal("expected error when signer returns a non-65-byte signature")
	}
}

// cloneMap shallow copies a doc so the two sign calls above don't share the map
// the signer path mutates (@context injection).
func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
