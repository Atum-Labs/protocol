package signing

import (
	"encoding/json"
	"testing"
	"time"

	paymentrequestenvelope "github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

const (
	holderKey     = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	holderChainID = "eip155:1"
	holderAccount = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
)

// created is pinned because proof.created is inside the signed payload: left to
// the clock, no two signatures in these tests would match.
var created = time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)

func testSigner(t *testing.T) lddataintegrity.Secp256k1Signer {
	t.Helper()
	priv, err := crypto.HexToECDSA(holderKey)
	require.NoError(t, err)
	signer, err := lddataintegrity.NewECDSASigner(priv)
	require.NoError(t, err)
	return signer
}

// A minimal credential bag. The envelope requires at least one credential and
// the verifier rejects an empty bag, so there is no "no credentials" happy path
// to test.
func holderVCs() []json.RawMessage {
	return []json.RawMessage{json.RawMessage(`{
		"@context": ["https://www.w3.org/2018/credentials/v1"],
		"type": ["VerifiableCredential"],
		"issuer": "did:web:devnet.atum.network",
		"credentialSubject": {"id": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"}
	}`)}
}

func testOptions(t *testing.T) Options {
	t.Helper()
	return Options{
		PaymentRequestDoc: map[string]any{
			"version":    "1.0",
			"request_id": "req-1",
		},
		HolderVCs:     holderVCs(),
		Signer:        testSigner(t),
		ChainID:       holderChainID,
		HolderAddress: holderAccount,
		Challenge:     "req-1",
		Domain:        "did:web:devnet.atum.network",
		Now:           created,
	}
}

func TestBuildEnvelope_ProducesAHolderSignedPresentation(t *testing.T) {
	out, err := BuildEnvelope(testOptions(t))
	require.NoError(t, err)

	var env map[string]any
	require.NoError(t, json.Unmarshal(out, &env))

	proof, ok := env["proof"].(map[string]any)
	require.True(t, ok, "the envelope must carry a proof")
	require.Equal(t, "authentication", proof["proofPurpose"],
		"the envelope authenticates its holder; the inner document asserts instead")
	require.Equal(t, "req-1", proof["challenge"], "the challenge is the cross-request replay binding")
	require.Equal(t, "did:web:devnet.atum.network", proof["domain"],
		"the domain is the cross-environment replay binding")
	require.Equal(t, "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
		proof["verificationMethod"])
}

// What distinguishes a PRE from an FQE is which declaration context the
// envelope carries, and that is set through an override. If the override were
// dropped, the signer's default would silently produce a envelope

// A $comment sits beside @context in the context document rather than inside
// the term definitions, so it should not reach canonicalization. Asserted
// rather than assumed, because two copies of this context are known to differ
// in exactly that field, and the answer decides whether replacing one with the
// other changes any signature.
func TestEnvelopeSignatureIgnoresContextComments(t *testing.T) {
	base, err := BuildEnvelope(testOptions(t))
	require.NoError(t, err)

	// Same context, with the $comment altered the way the two known copies
	// differ.
	ctx, err := paymentrequestenvelope.ParsedContext()
	require.NoError(t, err)
	ctxDoc, ok := ctx.(map[string]any)
	require.True(t, ok, "unexpected context shape %T", ctx)
	ctxDoc["$comment"] = "drifted copy " + ctxDoc["$comment"].(string)

	original := envelopeContextFor
	envelopeContextFor = func() (any, error) { return ctxDoc, nil }
	t.Cleanup(func() { envelopeContextFor = original })

	withComment, err := BuildEnvelope(testOptions(t))
	require.NoError(t, err)

	require.JSONEq(t, string(base), string(withComment),
		"a $comment beside @context must not affect the envelope signature; if this fails, the "+
			"two divergent copies of this context are NOT interchangeable and swapping them "+
			"invalidates existing envelopes")
}

func TestSignInnerPaymentRequest_UsesTheSameHolderIdentity(t *testing.T) {
	inner, err := SignInnerPaymentRequest(testOptions(t))
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, json.Unmarshal(inner, &doc))
	proof, ok := doc["proof"].(map[string]any)
	require.True(t, ok)

	require.Equal(t, "assertionMethod", proof["proofPurpose"],
		"the inner document is asserted by its signer, not authenticated")

	env, err := BuildEnvelope(testOptions(t))
	require.NoError(t, err)
	var envelope map[string]any
	require.NoError(t, json.Unmarshal(env, &envelope))
	envProof := envelope["proof"].(map[string]any)

	require.Equal(t, envProof["verificationMethod"], proof["verificationMethod"],
		"the inner signer and the envelope holder must be the same did:pkh — the consistency "+
			"the envelope verifier anchors on")
}

// SignInnerPaymentRequest needs no credentials, challenge or domain; only the
// envelope does. Signing the inner document must not require envelope-only
// inputs a caller producing just the inner artifact would not have.
func TestSignInnerPaymentRequest_DoesNotRequireEnvelopeOnlyInputs(t *testing.T) {
	opts := testOptions(t)
	opts.HolderVCs = nil
	opts.Challenge = ""
	opts.Domain = ""

	_, err := SignInnerPaymentRequest(opts)
	require.NoError(t, err)

	_, err = BuildEnvelope(opts)
	require.Error(t, err, "the envelope, by contrast, requires all three")
}

func TestBuildEnvelope_Rejects(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*Options)
		want   string
	}{
		{"no credentials", func(o *Options) { o.HolderVCs = nil }, "HolderVCs"},
		{"no challenge", func(o *Options) { o.Challenge = "" }, "Challenge"},
		{"no domain", func(o *Options) { o.Domain = "" }, "Domain"},
		{"no signer", func(o *Options) { o.Signer = nil }, "Signer"},
		{"no chain", func(o *Options) { o.ChainID = "" }, "ChainID"},
		{"no holder address", func(o *Options) { o.HolderAddress = "" }, "HolderAddress"},
		{"no created instant", func(o *Options) { o.Now = time.Time{} }, "Now"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := testOptions(t)
			tc.mutate(&opts)
			_, err := BuildEnvelope(opts)
			require.Error(t, err)
			require.Contains(t, err.Error(), tc.want, "the error must name the missing input")
		})
	}
}

// BuildEnvelope must NOT require the inner document, because it never reads it.
//
// This case previously asserted the opposite. Requiring PaymentRequestDoc forced a caller who
// wanted only an envelope to invent a dummy map purely to satisfy validation, and it made the Go
// and TypeScript buildEnvelope disagree about their required inputs -- the kind of difference a
// customer meets while porting between our two SDKs. SignInnerPaymentRequest still requires it,
// which is asserted below.
func TestBuildEnvelope_DoesNotRequireTheInnerDocument(t *testing.T) {
	opts := testOptions(t)
	opts.PaymentRequestDoc = nil

	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err, "BuildEnvelope reads no part of the inner document")
	require.NotEmpty(t, envelope)

	// The requirement belongs to the call that actually signs the inner document.
	_, innerErr := SignInnerPaymentRequest(opts)
	require.Error(t, innerErr)
	require.Contains(t, innerErr.Error(), "PaymentRequestDoc")
}

func TestOptions_DIDDerivation(t *testing.T) {
	opts := Options{ChainID: "eip155:1", HolderAddress: "0xabc"}
	require.Equal(t, "did:pkh:eip155:1:0xabc", opts.HolderDID())
	require.Equal(t, "did:pkh:eip155:1:0xabc#blockchainAccountId", opts.VerificationMethod())

	solana := Options{ChainID: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", HolderAddress: "SoME1"}
	require.Equal(t, "did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:SoME1", solana.HolderDID())
}
