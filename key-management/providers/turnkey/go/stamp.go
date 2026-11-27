package turnkey

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
)

type stampPayload struct {
	PublicKey string `json:"publicKey"`
	Scheme    string `json:"scheme"`
	Signature string `json:"signature"`
}

type derSig struct {
	R, S *big.Int
}

// stampBody produces the X-Stamp header value for the given canonical
// request body: base64url(JSON({publicKey, scheme, signature})), where
// signature is hex(DER(ecdsa.Sign(sha256(body), P-256))).
func stampBody(apiPubHex string, priv *ecdsa.PrivateKey, body []byte) (string, error) {
	digest := sha256.Sum256(body)
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", fmt.Errorf("turnkey: ecdsa sign: %w", err)
	}
	der, err := asn1.Marshal(derSig{R: r, S: s})
	if err != nil {
		return "", fmt.Errorf("turnkey: der marshal: %w", err)
	}
	payload, err := json.Marshal(stampPayload{
		PublicKey: apiPubHex,
		Scheme:    "SIGNATURE_SCHEME_TK_API_P256",
		Signature: hex.EncodeToString(der),
	})
	if err != nil {
		return "", fmt.Errorf("turnkey: stamp marshal: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

// verifyAPIKeyPair derives the compressed public key from apiPrivHex and
// asserts it equals apiPubHex. Catches operator copy-paste errors at
// startup instead of at first signing call.
func verifyAPIKeyPair(apiPubHex, apiPrivHex string) error {
	priv, err := parseP256Private(apiPrivHex)
	if err != nil {
		return err
	}
	derived := hex.EncodeToString(elliptic.MarshalCompressed(elliptic.P256(), priv.PublicKey.X, priv.PublicKey.Y))
	if derived != apiPubHex {
		return errors.New("turnkey: APIPublicKey does not match the public key derived from APIPrivateKey")
	}
	return nil
}

// parseP256Private decodes a hex-encoded P-256 private scalar. Called once at New().
func parseP256Private(hexStr string) (*ecdsa.PrivateKey, error) {
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		return nil, fmt.Errorf("turnkey: decode private key: %w", err)
	}
	curve := elliptic.P256()
	d := new(big.Int).SetBytes(raw)
	if d.Sign() <= 0 || d.Cmp(curve.Params().N) >= 0 {
		return nil, errors.New("turnkey: private scalar out of range")
	}
	priv := &ecdsa.PrivateKey{D: d}
	priv.PublicKey.Curve = curve
	priv.PublicKey.X, priv.PublicKey.Y = curve.ScalarBaseMult(raw)
	return priv, nil
}
