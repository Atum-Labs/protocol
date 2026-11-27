package verifill

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"testing"

	"filippo.io/edwards25519"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	secp256k1ecdsa "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// The frozen vectors carry placeholder signatures on purpose, so signature tests generate their
// own keys and sign for real. That also means these tests fail if the digest rule changes, which
// a fixture with a hardcoded signature could not tell apart from a changed fixture.

// signSecp256k1 signs a digest and returns the r || s || v hex the schema specifies, with s
// forced low so the signature is the canonical one of the malleable pair.
func signSecp256k1(t *testing.T, priv *secp256k1.PrivateKey, digest []byte) string {
	t.Helper()
	compact := secp256k1ecdsa.SignCompact(priv, digest, false)
	// SignCompact returns recovery-byte-first; the wire form puts it last.
	out := make([]byte, 65)
	copy(out, compact[1:65])
	out[64] = compact[0] - 27

	s := new(big.Int).SetBytes(out[32:64])
	if s.Cmp(halfCurveOrder) > 0 {
		s.Sub(secp256k1CurveOrder, s)
		copy(out[32:64], leftPad(s.Bytes(), 32))
		out[64] ^= 1
	}
	return hex.EncodeToString(out)
}

func leftPad(b []byte, n int) []byte {
	if len(b) >= n {
		return b
	}
	return append(make([]byte, n-len(b)), b...)
}

func evmAddressOf(priv *secp256k1.PrivateKey) string {
	pub := priv.PubKey().SerializeUncompressed()
	return "0x" + hex.EncodeToString(keccak256(pub[1:])[12:])
}

func base58Encode(b []byte) string {
	n := new(big.Int).SetBytes(b)
	radix := big.NewInt(58)
	zero := big.NewInt(0)
	mod := new(big.Int)
	out := []byte{}
	for n.Cmp(zero) > 0 {
		n.DivMod(n, radix, mod)
		out = append([]byte{base58Alphabet[mod.Int64()]}, out...)
	}
	for _, c := range b {
		if c != 0 {
			break
		}
		out = append([]byte{'1'}, out...)
	}
	return string(out)
}

func tronAddressOf(priv *secp256k1.PrivateKey) string {
	acct := keccak256(priv.PubKey().SerializeUncompressed()[1:])[12:]
	body := append([]byte{0x41}, acct...)
	first := sha256.Sum256(body)
	second := sha256.Sum256(first[:])
	return base58Encode(append(body, second[0:4]...))
}

// TestVerifyVerdictSignatureRoundTrip covers all three schemes end to end with real keys, then
// the rejections that each fail open when skipped.
func TestVerifyVerdictSignatureRoundTrip(t *testing.T) {
	base := func(chain string, scheme VerdictSignatureScheme) *FulfillmentVerdict {
		return &FulfillmentVerdict{
			Domain:          "did:web:atum.network",
			PaymentId:       "0x" + strings.Repeat("1", 64),
			ChainId:         chain,
			Outcome:         FulfillmentVerdictOutcomeNotDelivered,
			BlockNumber:     "21500000",
			BlockHash:       "0x" + strings.Repeat("a", 64),
			SignatureScheme: scheme,
		}
	}

	t.Run("eip712", func(t *testing.T) {
		priv, err := secp256k1.GeneratePrivateKey()
		if err != nil {
			t.Fatal(err)
		}
		v := base("eip155:42161", VerdictSignatureSchemeEip712Secp256k1)
		digest, err := verdictSigningInput(v)
		if err != nil {
			t.Fatal(err)
		}
		v.Signature = signSecp256k1(t, priv, digest)

		addr := evmAddressOf(priv)
		if err := VerifyVerdictSignature(v, addr); err != nil {
			t.Fatalf("a genuine signature was rejected: %v", err)
		}
		// The checksummed spelling of the same account must also verify.
		if err := VerifyVerdictSignature(v, toEIP55(addr)); err != nil {
			t.Errorf("the EIP-55 spelling of the same address was rejected: %v", err)
		}
		// A mixed-case address with a broken checksum is the one case that must be refused,
		// because that checksum is the only integrity protection on a fetched value.
		broken := toEIP55(addr)
		broken = flipOneLetterCase(broken)
		if broken != toEIP55(addr) {
			if err := VerifyVerdictSignature(v, broken); err == nil {
				t.Error("an address whose EIP-55 checksum is wrong was accepted")
			}
		}
		// Another key must not verify.
		other, _ := secp256k1.GeneratePrivateKey()
		if err := VerifyVerdictSignature(v, evmAddressOf(other)); err == nil {
			t.Error("a signature verified against the wrong address")
		}
		// One flipped preimage byte must not verify.
		tampered := *v
		tampered.BlockNumber = "21500001"
		if err := VerifyVerdictSignature(&tampered, addr); err == nil {
			t.Error("a verdict with an edited signed member still verified")
		}
		// The high-s twin of a valid signature must be refused.
		if err := VerifyVerdictSignature(withHighS(t, v), addr); err == nil {
			t.Error("the high-s twin of a valid signature was accepted, so one verdict has two signatures")
		}
		// Both v encodings recover the same signer, so both must be accepted.
		for _, form := range []string{shiftV(v.Signature, +27), shiftV(v.Signature, -27)} {
			alt := *v
			alt.Signature = form
			if err := VerifyVerdictSignature(&alt, addr); err != nil {
				t.Errorf("recovery byte form %s... was rejected: %v", form[128:], err)
			}
		}
		// The same key personal-signing the preimage must not verify as typed data.
		pre, err := VerdictSignedPayload(v)
		if err != nil {
			t.Fatal(err)
		}
		crossed := *v
		crossed.Signature = signSecp256k1(t, priv, ethereumPersonalDigest(pre))
		if err := VerifyVerdictSignature(&crossed, addr); err == nil {
			t.Error("a personal_sign signature over the preimage verified as an EIP-712 verdict")
		}
	})

	t.Run("tip191 does not accept an Ethereum-prefixed signature", func(t *testing.T) {
		priv, _ := secp256k1.GeneratePrivateKey()
		v := base("tron:mainnet", VerdictSignatureSchemeTip191Secp256k1)
		pre, _ := VerdictSignedPayload(v)

		tronDigest, _ := verdictDigest(VerdictSignatureSchemeTip191Secp256k1, pre)
		v.Signature = signSecp256k1(t, priv, tronDigest)
		if err := VerifyVerdictSignature(v, tronAddressOf(priv)); err != nil {
			t.Fatalf("a genuine Tron signature was rejected: %v", err)
		}

		// The prefixes differ, so a signature made under the Ethereum convention must not verify
		// here. Without the per-scheme prefix this is the check that silently passes.
		crossed := *v
		crossed.Signature = signSecp256k1(t, priv, ethereumPersonalDigest(pre))
		if err := VerifyVerdictSignature(&crossed, tronAddressOf(priv)); err == nil {
			t.Error("a signature made under the Ethereum prefix verified as a Tron signature")
		}

		// Base58check is 25 bytes, not 21. A served address whose checksum is wrong is refused.
		bad := tronAddressOf(priv)
		bad = bad[:len(bad)-1] + string(base58Alphabet[(strings.IndexByte(base58Alphabet, bad[len(bad)-1])+1)%58])
		if err := VerifyVerdictSignature(v, bad); err == nil {
			t.Error("a Tron address with a bad checksum was accepted")
		}
	})

	t.Run("ed25519", func(t *testing.T) {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		v := base("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", VerdictSignatureSchemeEd25519Raw)
		pre, _ := VerdictSignedPayload(v)
		v.Signature = hex.EncodeToString(ed25519.Sign(priv, []byte(pre)))

		addr := base58Encode(pub)
		if err := VerifyVerdictSignature(v, addr); err != nil {
			t.Fatalf("a genuine ed25519 signature was rejected: %v", err)
		}

		// A short key must be refused BEFORE it reaches Verify, since some implementations panic
		// rather than return false.
		if err := VerifyVerdictSignature(v, base58Encode(pub[:31])); err == nil {
			t.Error("a 31-byte public key was accepted")
		}
		// A small-order key must be refused, because a signature under one verifies for anything.
		// The full set is exercised by TestEd25519SmallOrderKeysAreRefused below.
		if err := VerifyVerdictSignature(v, base58Encode(make([]byte, 32))); err == nil {
			t.Error("the all-zero public key was accepted")
		}
		// S must be canonical, and the assertion is on OUR error rather than merely on failure.
		// Go's crypto/ed25519 rejects a non-canonical S itself, so a test that only checked for
		// an error would pass with our check deleted and prove nothing about it. The check has to
		// stay regardless: it is normative for implementations that do not enforce it, and
		// without it this binding would report a malleated signature as a plain verification
		// failure rather than naming the reason.
		err = VerifyVerdictSignature(withNonCanonicalS(t, v), addr)
		if err == nil {
			t.Error("a non-canonical S was accepted, so a second valid signature exists over this verdict")
		} else if !strings.Contains(err.Error(), "canonical") {
			t.Errorf("a non-canonical S was rejected by something other than the canonical-S check: %v", err)
		}
	})

	t.Run("scheme must match the chain", func(t *testing.T) {
		v := base("eip155:1", VerdictSignatureSchemeEd25519Raw)
		v.Signature = strings.Repeat("ab", 64)
		if err := VerifyVerdictSignature(v, "0x"+strings.Repeat("0", 40)); err == nil {
			t.Error("an ed25519 scheme was accepted on an eip155 chain")
		}
	})

	t.Run("deposit verdicts verify on the same rules", func(t *testing.T) {
		priv, _ := secp256k1.GeneratePrivateKey()
		d := &DepositVerdict{
			Domain: "did:web:atum.network", PaymentId: "0x" + strings.Repeat("2", 64),
			ChainId: "eip155:1", EscrowAddress: "0x" + strings.Repeat("b", 40),
			Outcome: DepositVerdictOutcomeNotHeld, BlockNumber: "1", BlockHash: "0x" + strings.Repeat("c", 64),
			SignatureScheme: VerdictSignatureSchemeEip712Secp256k1,
		}
		digest, err := depositVerdictSigningInput(d)
		if err != nil {
			t.Fatal(err)
		}
		d.Signature = signSecp256k1(t, priv, digest)
		if err := VerifyDepositVerdictSignature(d, evmAddressOf(priv)); err != nil {
			t.Fatalf("a genuine deposit signature was rejected: %v", err)
		}

		// The cross-kind guarantee, cryptographically this time: the same members signed as a
		// fulfillment verdict must not satisfy a deposit verifier.
		f := &FulfillmentVerdict{
			Domain: d.Domain, PaymentId: d.PaymentId, ChainId: d.ChainId,
			Outcome: FulfillmentVerdictOutcomeNotDelivered, BlockNumber: d.BlockNumber,
			BlockHash: d.BlockHash, SignatureScheme: d.SignatureScheme,
		}
		fdigest, err := verdictSigningInput(f)
		if err != nil {
			t.Fatal(err)
		}
		crossed := *d
		crossed.Signature = signSecp256k1(t, priv, fdigest)
		if err := VerifyDepositVerdictSignature(&crossed, evmAddressOf(priv)); err == nil {
			t.Error("a fulfillment verdict signature satisfied a deposit verdict verifier")
		}
	})
}

// ethereumPersonalDigest is the EIP-191 personal_sign digest of a preimage, which no verdict
// scheme admits. Tests sign it to prove a scheme does not accept it.
func ethereumPersonalDigest(preimage string) []byte {
	return keccak256([]byte("\x19Ethereum Signed Message:\n"+strconv.Itoa(len(preimage))), []byte(preimage))
}

func toEIP55(addr string) string {
	body := strings.ToLower(addr[2:])
	sum := hex.EncodeToString(keccak256([]byte(body)))
	out := []byte(body)
	for i, c := range out {
		if c >= 'a' && c <= 'f' && sum[i] >= '8' {
			out[i] = c - 32
		}
	}
	return "0x" + string(out)
}

// flipOneLetterCase breaks a checksum by inverting the case of the first letter it finds.
func flipOneLetterCase(addr string) string {
	out := []byte(addr)
	for i := 2; i < len(out); i++ {
		switch {
		case out[i] >= 'a' && out[i] <= 'f':
			out[i] -= 32
			return string(out)
		case out[i] >= 'A' && out[i] <= 'F':
			out[i] += 32
			return string(out)
		}
	}
	return addr
}

func withHighS(t *testing.T, v *FulfillmentVerdict) *FulfillmentVerdict {
	t.Helper()
	raw, err := hex.DecodeString(v.Signature)
	if err != nil {
		t.Fatal(err)
	}
	s := new(big.Int).SetBytes(raw[32:64])
	s.Sub(secp256k1CurveOrder, s)
	copy(raw[32:64], leftPad(s.Bytes(), 32))
	raw[64] ^= 1
	out := *v
	out.Signature = hex.EncodeToString(raw)
	return &out
}

func withNonCanonicalS(t *testing.T, v *FulfillmentVerdict) *FulfillmentVerdict {
	t.Helper()
	raw, err := hex.DecodeString(v.Signature)
	if err != nil {
		t.Fatal(err)
	}
	le := make([]byte, 32)
	for i, b := range raw[32:64] {
		le[31-i] = b
	}
	s := new(big.Int).SetBytes(le)
	s.Add(s, ed25519GroupOrder)
	be := leftPad(s.Bytes(), 32)
	for i := 0; i < 32; i++ {
		raw[32+i] = be[31-i]
	}
	out := *v
	out.Signature = hex.EncodeToString(raw)
	return &out
}

func shiftV(sigHex string, delta int) string {
	raw, _ := hex.DecodeString(sigHex)
	v := int(raw[64])
	if delta > 0 && v < 27 {
		v += 27
	} else if delta < 0 && v >= 27 {
		v -= 27
	}
	raw[64] = byte(v)
	return hex.EncodeToString(raw)
}

// TestDecodeVerdictRejectsAnIncompleteObject is comment 13's hole closed. The schema makes
// rejecting an incomplete verdict a requirement, and a plain decode cannot honour it because Go
// zero-fills an absent field and the empty string is a legal value for two members.
func TestDecodeVerdictRejectsAnIncompleteObject(t *testing.T) {
	complete := map[string]any{
		"domain": "did:web:atum.network", "payment_id": "0x" + strings.Repeat("1", 64),
		"chain_id": "eip155:1", "outcome": "not_delivered", "block_number": "1",
		"block_hash": "0x" + strings.Repeat("a", 64), "finality_policy": "confirmations:12",
		"transaction_hash": "", "fulfiller": "",
		"signature_scheme": "eip712-secp256k1", "signature": strings.Repeat("ab", 65),
	}
	raw, _ := json.Marshal(complete)
	if _, err := DecodeVerdict(raw); err != nil {
		t.Fatalf("a complete verdict was rejected: %v", err)
	}

	// Every member must be individually load-bearing, so drop each in turn.
	for key := range complete {
		partial := map[string]any{}
		for k, v := range complete {
			if k != key {
				partial[k] = v
			}
		}
		b, _ := json.Marshal(partial)
		if _, err := DecodeVerdict(b); err == nil {
			t.Errorf("a verdict missing %q was accepted", key)
		}
	}

	// The case a plain decode cannot see: an omitted transaction_hash and an empty one produce
	// the same struct and the same preimage, so only a pre-decode check separates them.
	withEmpty := map[string]any{}
	for k, v := range complete {
		withEmpty[k] = v
	}
	withoutKey := map[string]any{}
	for k, v := range complete {
		if k != "transaction_hash" {
			withoutKey[k] = v
		}
	}
	a, _ := json.Marshal(withEmpty)
	b, _ := json.Marshal(withoutKey)
	okA, errA := DecodeVerdict(a)
	_, errB := DecodeVerdict(b)
	if errA != nil || errB == nil {
		t.Fatalf("empty and omitted must differ: empty err = %v, omitted err = %v", errA, errB)
	}
	var plainA, plainB FulfillmentVerdict
	_ = json.Unmarshal(a, &plainA)
	_ = json.Unmarshal(b, &plainB)
	if plainA != plainB {
		t.Fatal("the two decode differently, so this test no longer demonstrates why the check must precede decoding")
	}
	if okA.TransactionHash != "" {
		t.Error("the empty member did not survive decoding")
	}

	// And an outcome that contradicts its members is refused at the same gate.
	bad := map[string]any{}
	for k, v := range complete {
		bad[k] = v
	}
	bad["outcome"] = "delivered"
	c, _ := json.Marshal(bad)
	if _, err := DecodeVerdict(c); err == nil {
		t.Error("a delivered verdict with no transaction or fulfiller was accepted")
	}
}

// TestTerminalSentinelsAreDistinct pins comment 11's fix and the one confusion that would move
// funds: a delivered-but-late payment must never present as a proven negative.
func TestTerminalSentinelsAreDistinct(t *testing.T) {
	notDelivered := verdictSentinelFor(VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED)
	late := verdictSentinelFor(VerifyFulfillmentResponseErrorDEADLINEEXCEEDED)

	if !errors.Is(notDelivered, ErrFulfillmentNotDelivered) {
		t.Error("the proven-negative code does not map to its sentinel")
	}
	if !errors.Is(late, ErrDeadlineExceeded) {
		t.Error("the late-delivery code does not map to its sentinel")
	}
	if errors.Is(late, ErrFulfillmentNotDelivered) {
		t.Error("a late delivery presents as a proven negative, so a caller would refund a payment the recipient was paid for")
	}
	if errors.Is(notDelivered, ErrVerdictPending) || errors.Is(late, ErrVerdictPending) {
		t.Error("a terminal answer presents as pending")
	}

	// The undetermined codes carry no sentinel: they are retried, not returned.
	for _, code := range []VerifyFulfillmentResponseError{
		VerifyFulfillmentResponseErrorVERIFICATIONERROR,
		VerifyFulfillmentResponseErrorVERIFICATIONFAILED,
	} {
		if verdictSentinelFor(code) != nil {
			t.Errorf("%s has a terminal sentinel but it is retryable", code)
		}
	}
	// And a code this binding was compiled before gets none rather than the nearest match.
	if verdictSentinelFor(VerifyFulfillmentResponseError("SOMETHING_NEW")) != nil {
		t.Error("an unrecognised code was given a sentinel")
	}
}

// knownSmallOrderEncodings is libsodium's small-order blacklist, used here as TEST DATA rather than
// as the implementation. The implementation computes the property instead, so this list cannot
// create a gap by being incomplete — but it can still be wrong, so the test below validates it.
//
// That validation is the point. An earlier version of this file carried a hand-transcribed list in
// the production path, and two of its eight entries were not small-order at all: one was not a
// valid field element and one was a full-order point. Both sat there doing nothing, silently, which
// is the failure mode a blacklist invites and a computed check does not have.
var knownSmallOrderEncodings = []string{
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
	"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
}

// TestEd25519SmallOrderKeysAreRefused covers both halves of what the schema demands of a served
// key: a small-order point is refused, and so is a non-canonical encoding.
func TestEd25519SmallOrderKeysAreRefused(t *testing.T) {
	for _, hexKey := range knownSmallOrderEncodings {
		raw, err := hex.DecodeString(hexKey)
		if err != nil {
			t.Fatalf("%s: bad test constant: %v", hexKey, err)
		}

		// First validate the DATA, so a fabricated entry cannot sit here looking like coverage. An
		// entry is legitimate if it either fails to decode as a canonical point, or decodes and is
		// genuinely killed by the cofactor. A valid full-order point would satisfy neither.
		point, decodeErr := edwards25519.NewIdentityPoint().SetBytes(raw)
		if decodeErr == nil {
			cofactorMultiple := edwards25519.NewIdentityPoint().MultByCofactor(point)
			if cofactorMultiple.Equal(edwards25519.NewIdentityPoint()) != 1 {
				t.Errorf("%s decodes to a valid point that is NOT small order, so it does not belong in this list", hexKey)
			}
		}

		// Then the behaviour: rejected either way, and for a reason that names which rule caught it.
		if _, err := decodeServedEd25519Key(base58Encode(raw)); err == nil {
			t.Errorf("%s was accepted as a served key", hexKey)
		} else if !strings.Contains(err.Error(), "small-order") && !strings.Contains(err.Error(), "canonically encoded") {
			t.Errorf("%s was rejected for an unrelated reason: %v", hexKey, err)
		}
	}
}

// TestEd25519NonCanonicalKeyIsRefused pins the other half of the rule on its own, because every
// entry above could in principle be caught by the small-order branch and leave this untested.
func TestEd25519NonCanonicalKeyIsRefused(t *testing.T) {
	// y = p, the smallest non-canonical encoding: 2^255 - 19 little-endian.
	nonCanonical := make([]byte, 32)
	nonCanonical[0] = 0xed
	for i := 1; i < 31; i++ {
		nonCanonical[i] = 0xff
	}
	nonCanonical[31] = 0x7f

	_, err := decodeServedEd25519Key(base58Encode(nonCanonical))
	if err == nil {
		t.Fatal("a key encoding y = p was accepted, but it is not a canonical point encoding")
	}

	// And a real key still works, so the checks above are not rejecting everything.
	pub, _, genErr := ed25519.GenerateKey(rand.Reader)
	if genErr != nil {
		t.Fatal(genErr)
	}
	if _, err := decodeServedEd25519Key(base58Encode(pub)); err != nil {
		t.Errorf("a freshly generated key was rejected: %v", err)
	}
}

// TestDeadlineExceededReachesTheCaller is comment-driven: the sentinel for a late delivery was
// added but could not surface, because the response that carries it pairs a delivered verdict with
// `verified: false` and the agreement check read that as a contradiction. It returned first, so
// errors.Is never saw the sentinel.
//
// Asserted through checkVerdictAgainstResponse rather than over HTTP, because that is where the
// early return was.
func TestDeadlineExceededReachesTheCaller(t *testing.T) {
	deadlineExceeded := VerifyFulfillmentResponseErrorDEADLINEEXCEEDED
	notDelivered := VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED
	verificationError := VerifyFulfillmentResponseErrorVERIFICATIONERROR

	delivered := &FulfillmentVerdict{
		Domain: "did:web:atum.network", PaymentId: "0x" + strings.Repeat("1", 64),
		ChainId: "eip155:1", Outcome: FulfillmentVerdictOutcomeDelivered,
		BlockNumber: "1", BlockHash: "0x" + strings.Repeat("a", 64),
		TransactionHash: "0x" + strings.Repeat("b", 64), Fulfiller: "0x" + strings.Repeat("c", 40),
		SignatureScheme: VerdictSignatureSchemeEip712Secp256k1, Signature: strings.Repeat("ab", 65),
	}
	c := &VerifillHTTPClient{}

	// The case the bug was about: delivered, not verified, because the delivery was late.
	late := &VerifyFulfillmentResponse{
		Verified: false, PaymentId: delivered.PaymentId, Error: &deadlineExceeded, Verdict: delivered,
	}
	if err := c.checkVerdictAgainstResponse(late, delivered.PaymentId, delivered.ChainId); err != nil {
		t.Fatalf("a late delivery was rejected as self-contradictory, so its sentinel can never be reached: %v", err)
	}
	if s := verdictSentinelFor(deadlineExceeded); !errors.Is(s, ErrDeadlineExceeded) {
		t.Error("the late-delivery code does not map to its sentinel")
	}

	// The carve-out must be exactly that one code. A delivered verdict with no signature and any
	// other explanation is still a contradiction.
	for name, code := range map[string]*VerifyFulfillmentResponseError{
		"proven negative": &notDelivered,
		"undetermined":    &verificationError,
		"no code at all":  nil,
	} {
		resp := &VerifyFulfillmentResponse{
			Verified: false, PaymentId: delivered.PaymentId, Error: code, Verdict: delivered,
		}
		if err := c.checkVerdictAgainstResponse(resp, delivered.PaymentId, delivered.ChainId); err == nil {
			t.Errorf("%s: a delivered verdict with no signature was accepted, so the carve-out is too wide", name)
		}
	}

	// And the other direction still holds: verified with a non-delivered outcome is a contradiction.
	notDeliveredVerdict := *delivered
	notDeliveredVerdict.Outcome = FulfillmentVerdictOutcomeNotDelivered
	notDeliveredVerdict.TransactionHash = ""
	notDeliveredVerdict.Fulfiller = ""
	resp := &VerifyFulfillmentResponse{
		Verified: true, PaymentId: delivered.PaymentId, Verdict: &notDeliveredVerdict,
	}
	if err := c.checkVerdictAgainstResponse(resp, delivered.PaymentId, delivered.ChainId); err == nil {
		t.Error("a verified response carrying a not_delivered verdict was accepted")
	}
}
