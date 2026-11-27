package senderauth

import (
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/stretchr/testify/require"
)

// solanaRoundTripFixture builds + signs a fresh Solana sender_auth message from a
// deterministic seed and returns the verifier inputs plus the delegate signer.
//
// The Solana build path is not byte-deterministic across languages (random nonce, clock-derived
// issued_at), so this fixture exercises the Go build, sign and verify round-trip only; the
// conformance vectors pin verify parity.
func solanaRoundTripFixture(t *testing.T) (SignedMessageInput, SourceRef, Expectations, string) {
	t.Helper()
	// Deterministic 32-byte ed25519 seed (1..32) so the test is reproducible.
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := hex.EncodeToString(seed)

	adapter := solanaAdapter{}
	delegateSigner, err := adapter.DeriveDelegateSigner(priv)
	require.NoError(t, err)

	ver := 5
	defaults := ChainDefaults{
		EscrowContract:              "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
		QuoteSelector:               "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
		FulfillmentVerifierAccount:  "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
		FulfillmentVerifierEndpoint: "https://verifier.example",
		FulfillmentProxy:            "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
		SvmSignatureClusterID:       "devnet",
		SvmSignatureDomainVersion:   &ver,
	}
	mint := "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN"

	res, err := adapter.BuildAuthMessage(BuildParams{
		SourceAsset:        "solana:mainnet/token:" + mint,
		Depositor:          delegateSigner,
		MaxSourceAmount:    "1000000",
		RequestID:          "req-round-trip-1",
		SourceDefaults:     defaults,
		DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
		SolanaClock:        func(string) (uint64, error) { return 1700000000, nil },
	})
	require.NoError(t, err)
	require.Equal(t, SenderAuthMessageScheme("SOLANA"), res.MessageScheme)

	prehash := res.MessagePrehash
	signed := SignedMessageInput{
		Message:        res.MessageHash,
		MessagePrehash: &prehash,
		Payload:        map[string]interface{}{"delegate_signer": delegateSigner},
	}
	sig, err := adapter.Sign(signed, priv)
	require.NoError(t, err)
	signed.Signature = sig

	source := SourceRef{Network: "solana:mainnet", Asset: mint, Account: delegateSigner}
	expected := Expectations{
		MaxSourceAmount:           "1000000",
		EscrowContract:            defaults.EscrowContract,
		Reserver:                  defaults.QuoteSelector,
		Releaser:                  defaults.FulfillmentVerifierAccount,
		SvmSignatureClusterID:     defaults.SvmSignatureClusterID,
		SvmSignatureDomainVersion: defaults.SvmSignatureDomainVersion,
	}
	return signed, source, expected, delegateSigner
}

func TestSolanaAdapterRoundTrip(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)

	r, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.NoError(t, err)
	require.Equal(t, "1000000", r.Amount)
	require.Equal(t, 1700000120, r.DeadlineSec, "issued_at 1700000000 + 120s")
	require.Equal(t, SenderAuthMessageScheme("SOLANA"), r.Permit.Scheme)
	require.Equal(t, source.Account, r.Permit.Depositor)
}

// Without a delegate_signer the signature is verified against source.account, as the commitment
// check and RecoverSigner do; a delegate_signer that is present must be that same key.
func TestSolanaAdapterDelegateSignerIsOptional(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)
	signed.Payload = nil
	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.NoError(t, err)

	signed.Payload = map[string]interface{}{"delegate_signer": "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"}
	_, err = solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
	require.ErrorContains(t, err, "delegate signer is not the payment's source account")

	// A null delegate_signer is absent to every entry point.
	signed.Payload = map[string]interface{}{"delegate_signer": nil}
	account, err := solanaAdapter{}.RecoverSigner(signed, source)
	require.NoError(t, err)
	require.Equal(t, source.Account, account)
	_, err = solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.NoError(t, err)
}

func TestSolanaAdapterRejectsTamperedMessage(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)
	// Flip the signed message so it no longer matches the rebuilt deposit hash.
	signed.Message = "0x" + hex.EncodeToString(make([]byte, 32))

	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	requireCommitmentOutcome(t, err, OutcomePrehashMismatch)
	require.ErrorContains(t, err, "is not the Solana deposit hash of message_prehash")
}

func TestSolanaAdapterRejectsWrongAccount(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)
	// A delegate signer that is not source.account must be rejected.
	source.Account = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse"

	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
	require.ErrorContains(t, err, "depositor is not the payment's source account")
}

func TestSolanaAdapterRejectsWrongMint(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)
	// A mint that does not match source.asset must be rejected.
	source.Asset = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse"

	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.ErrorContains(t, err, "permit token does not match")
}

func TestSolanaAdapterRejectsWrongAmount(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)
	expected.MaxSourceAmount = "999"

	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.ErrorContains(t, err, "permit amount does not match max_source_amount")
}

func TestSolanaAdapterRejectsWitnessMismatch(t *testing.T) {
	signed, source, expected, _ := solanaRoundTripFixture(t)
	expected.Reserver = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse"

	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.ErrorContains(t, err, "witness roles do not match")
}

// TestSolanaAdapterOptInOff: the witness-role binding is opt-in, so omitting reserver/
// releaser skips it. The escrow program id + svm domain fields remain REQUIRED for the
// crypto, so they are still supplied.
func TestSolanaAdapterOptInOff(t *testing.T) {
	signed, source, full, _ := solanaRoundTripFixture(t)
	expected := Expectations{
		MaxSourceAmount:           "1000000",
		EscrowContract:            full.EscrowContract,
		SvmSignatureClusterID:     full.SvmSignatureClusterID,
		SvmSignatureDomainVersion: full.SvmSignatureDomainVersion,
	}

	r, err := solanaAdapter{}.RecoverAndVerify(signed, source, solanaTestCommitment, expected)
	require.NoError(t, err)
	require.Equal(t, "1000000", r.Amount)
}

// TestSolanaBuildAuthMessageRejectsInvalidNonce pins the build-time validation of a
// caller-supplied Solana nonce: both shapes below would otherwise fail only on-chain, after
// the payer signed. Mirrors the TS "build-time nonce validation" suite.
func TestSolanaBuildAuthMessageRejectsInvalidNonce(t *testing.T) {
	ver := 5
	defaults := ChainDefaults{
		EscrowContract:              "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
		QuoteSelector:               "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
		FulfillmentVerifierAccount:  "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8",
		FulfillmentVerifierEndpoint: "https://verifier.example",
		FulfillmentProxy:            "GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq",
		SvmSignatureClusterID:       "devnet",
		SvmSignatureDomainVersion:   &ver,
	}
	const depositor = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse"
	base := func(nonce *big.Int) BuildParams {
		return BuildParams{
			SourceAsset:        "solana:mainnet/token:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN",
			Depositor:          depositor,
			MaxSourceAmount:    "1000000",
			RequestID:          "req-nonce-validation",
			SourceDefaults:     defaults,
			DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
			DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
			SolanaClock:        func(string) (uint64, error) { return 1700000000, nil },
			Nonce:              nonce,
		}
	}
	adapter := solanaAdapter{}

	// >= 2^64 does not fit the 8-byte little-endian field (Uint64() would silently truncate).
	_, err := adapter.BuildAuthMessage(base(new(big.Int).Lsh(big.NewInt(1), 64)))
	require.ErrorContains(t, err, "unsigned 64-bit")

	// Low byte in the reserved replay-slot range (240 & 0xFF = 240 >= 235).
	_, err = adapter.BuildAuthMessage(base(big.NewInt(240)))
	require.ErrorContains(t, err, "reserved")

	// A valid deterministic nonce builds fine.
	valid, err := DeterministicSolanaNonce("req-nonce-validation", depositor)
	require.NoError(t, err)
	_, err = adapter.BuildAuthMessage(base(new(big.Int).SetUint64(valid)))
	require.NoError(t, err)
}

// The destination is committed from signature domain version 4, so the builder refuses to sign a
// deposit for a lower version.
func TestSolanaBuildRefusesDomainVersionBelow4(t *testing.T) {
	ver := 3
	_, err := solanaAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset:     "solana:mainnet/token:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN",
		Depositor:       "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
		MaxSourceAmount: "1000000",
		RequestID:       "req-domain-3",
		SourceDefaults: ChainDefaults{
			EscrowContract: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", QuoteSelector: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
			FulfillmentVerifierAccount: "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8", SvmSignatureClusterID: "devnet", SvmSignatureDomainVersion: &ver,
		},
		DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
		SolanaClock:        func(string) (uint64, error) { return 1700000000, nil },
	})
	require.ErrorContains(t, err, "commits no destination")
}

// The adapter refuses an empty request_id itself, before it reads the cluster clock, rather than
// leaving it to DeriveDepositRequestHash further down. Mirrors the TS "empty request_id" test.
func TestSolanaBuildRefusesEmptyRequestIDBeforeReadingTheClock(t *testing.T) {
	ver := 5
	clockReads := 0
	_, err := solanaAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset:     "solana:mainnet/token:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN",
		Depositor:       "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
		MaxSourceAmount: "1000000",
		RequestID:       "",
		SourceDefaults: ChainDefaults{
			EscrowContract: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", QuoteSelector: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR",
			FulfillmentVerifierAccount: "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8", SvmSignatureClusterID: "devnet", SvmSignatureDomainVersion: &ver,
		},
		DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
		SolanaClock:        func(string) (uint64, error) { clockReads++; return 1700000000, nil },
	})
	require.Zero(t, clockReads, "an empty request_id is refused before the cluster clock is read")
	require.EqualError(t, err, "sender_auth: request_id is required")
}
