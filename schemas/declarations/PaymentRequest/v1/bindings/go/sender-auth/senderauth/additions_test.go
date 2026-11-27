package senderauth

import (
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

// ─── RecoverSigner (recover-only primitive) ──────────────────────────────────

func TestRecoverSignerEVM(t *testing.T) {
	signed, source := buildEvmSigned(t, nil)
	acct, err := evmAdapter{}.RecoverSigner(signed, source)
	require.NoError(t, err)
	require.Equal(t, source.Account, acct)

	// A different account than the signer is rejected — no permit parse involved.
	bad := source
	bad.Account = "0x9999999999999999999999999999999999999999"
	_, err = evmAdapter{}.RecoverSigner(signed, bad)
	require.ErrorIs(t, err, ErrSignerMismatch)
}

// TestRecoverSignerEVMIgnoresPrehash: RecoverSigner recovers from the raw digest and must
// NOT depend on message_prehash, so a message with no bindable permit (e.g. an EVM setup
// approval in a multi-message payload) still recovers to its signer.
func TestRecoverSignerEVMIgnoresPrehash(t *testing.T) {
	signed, source := buildEvmSigned(t, nil)
	signed.MessagePrehash = nil
	acct, err := evmAdapter{}.RecoverSigner(signed, source)
	require.NoError(t, err)
	require.Equal(t, source.Account, acct)
}

func TestRecoverSignerTron(t *testing.T) {
	signed, source := buildTronSigned(t, nil)
	acct, err := tronAdapter{}.RecoverSigner(signed, source)
	require.NoError(t, err)
	require.Equal(t, source.Account, acct)
}

func TestRecoverSignerSolana(t *testing.T) {
	signed, source, _, _ := solanaRoundTripFixture(t)
	acct, err := solanaAdapter{}.RecoverSigner(signed, source)
	require.NoError(t, err)
	require.Equal(t, source.Account, acct)

	bad := source
	bad.Account = "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse"
	_, err = solanaAdapter{}.RecoverSigner(signed, bad)
	require.ErrorIs(t, err, ErrSignerMismatch)
}

// ─── High-s (EIP-2) rejection ─────────────────────────────────────────────────

// TestRecoverRejectsHighS: the canonical (low-s) signature recovers, but the equivalent
// malleated high-s signature (r, N-s, the other v), which recovers to the same signer, is rejected,
// matching the TS side (ethers).
func TestRecoverRejectsHighS(t *testing.T) {
	signed, source := buildEvmSigned(t, nil)
	_, err := evmAdapter{}.RecoverSigner(signed, source)
	require.NoError(t, err)

	signed.Signature = malleateHighS(t, signed.Signature)
	_, err = evmAdapter{}.RecoverSigner(signed, source)
	// High-s is a recovery failure (recovery_failed), not a signer mismatch.
	require.ErrorIs(t, err, ErrRecoveryFailed)
	require.NotErrorIs(t, err, ErrSignerMismatch)
	require.ErrorContains(t, err, "high-s", "refused for high-s, not for its recovery id")
}

// malleateHighS returns the malleability twin of a 65-byte secp256k1 signature: (r, N-s,
// the other v). It recovers to the same public key but is non-canonical (high-s).
func malleateHighS(t *testing.T, sigHex string) string {
	t.Helper()
	raw, err := hex.DecodeString(strings.TrimPrefix(sigHex, "0x"))
	require.NoError(t, err)
	require.Len(t, raw, 65)
	n := crypto.S256().Params().N
	s := new(big.Int).SetBytes(raw[32:64])
	sHigh := new(big.Int).Sub(n, s)
	out := make([]byte, 65)
	copy(out[:32], raw[:32])
	sHigh.FillBytes(out[32:64]) // left-pad to 32 bytes
	// Flip the recovery id so it still recovers to the same signer, keeping its 0/1 or 27/28
	// spelling: 27^1 is 26, which is refused for its spelling before high-s is checked.
	switch v := raw[64]; v {
	case 27:
		out[64] = 28
	case 28:
		out[64] = 27
	default:
		out[64] = v ^ 1
	}
	return "0x" + hex.EncodeToString(out)
}

// ─── Partial-witness guard ────────────────────────────────────────────────────

// TestRejectsPartialWitness: supplying exactly one of reserver/releaser is a
// misconfiguration that would silently skip the witness-role check, so it is rejected.
func TestRejectsPartialWitness(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)
	exp := evmFullExpectations(d)
	exp.Releaser = "" // only reserver supplied
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, exp)
	require.ErrorContains(t, err, "must be supplied together")
}

// ─── Clock seam ───────────────────────────────────────────────────────────────

// TestClockSeam: freshness compares the permit deadline against Expectations.NowSec when
// pinned, independent of the wall clock (the seam the conformance oracle uses).
func TestClockSeam(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil) // deadline = fixed 2030 test deadline
	exp := evmFullExpectations(d)

	past := 1700000000 // before the 2030 deadline → fresh
	exp.NowSec = &past
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, exp)
	require.NoError(t, err)

	future := 2000000000 // after the 2030 deadline → expired, without touching the wall clock
	exp.NowSec = &future
	_, err = evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, exp)
	require.ErrorContains(t, err, "deadline is not in the future")
}

// ─── ErrMalformedPrehash sentinel ────────────────────────────────────────────

// TestMalformedPrehashIsSentinel: an unbindable prehash surfaces as the ErrMalformedPrehash
// sentinel, so a consumer can detect it with errors.Is.
func TestMalformedPrehashIsSentinel(t *testing.T) {
	d, token := evmTestDefaults()
	bad := "not json"
	signed := SignedMessageInput{Message: "0x00", MessagePrehash: &bad, Signature: "0x00"}
	source := SourceRef{Network: "eip155:1", Asset: token, Account: "0x9999999999999999999999999999999999999999"}
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, evmFullExpectations(d))
	require.ErrorIs(t, err, ErrMalformedPrehash)
}

// ─── Nonce is required (no silent random fallback) ───────────────────────────

// TestBuildAuthMessageRequiresNonce: BuildAuthMessage rejects a nil nonce rather than
// silently minting a random one — a random nonce is not retry-safe and could double-charge.
// One-shot randomness is the caller's explicit opt-in via GeneratePermitNonce.
func TestBuildAuthMessageRequiresNonce(t *testing.T) {
	d, token := evmTestDefaults()
	// Deadline supplied so the nonce check (not the deadline check) is what fires.
	base := BuildParams{SourceAsset: "eip155:1/erc20:" + token, MaxSourceAmount: "1000000", SourceDefaults: d, RequestID: "req_test", DestinationAsset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", DestinationAccount: "0xC0FFEE254729296a45a3885639AC7E10F9d54979", Deadline: big.NewInt(1924991999)}

	missing := base // Nonce left nil
	_, err := evmAdapter{}.BuildAuthMessage(missing)
	require.ErrorContains(t, err, "requires an explicit nonce")

	explicit := base
	explicit.Nonce = big.NewInt(123)
	_, err = evmAdapter{}.BuildAuthMessage(explicit)
	require.NoError(t, err)
}

// TestBuildAuthMessageRequiresDeadline: BuildAuthMessage rejects a nil deadline rather than
// silently minting a far-future permit that outlives settlement — the calling layer derives
// it from the payment's fulfillment deadline.
func TestBuildAuthMessageRequiresDeadline(t *testing.T) {
	d, token := evmTestDefaults()
	base := BuildParams{SourceAsset: "eip155:1/erc20:" + token, MaxSourceAmount: "1000000", SourceDefaults: d, RequestID: "req_test", DestinationAsset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", DestinationAccount: "0xC0FFEE254729296a45a3885639AC7E10F9d54979", Nonce: big.NewInt(123)}

	missing := base // Deadline left nil
	_, err := evmAdapter{}.BuildAuthMessage(missing)
	require.ErrorContains(t, err, "requires an explicit permit deadline")

	explicit := base
	explicit.Deadline = big.NewInt(1924991999)
	_, err = evmAdapter{}.BuildAuthMessage(explicit)
	require.NoError(t, err)
}

// TestBuildAuthMessageNamesMalformedSourceAsset: every adapter reports the offending identifier
// rather than carrying an empty address into its chain library. Mirrors the TS rows.
func TestBuildAuthMessageNamesMalformedSourceAsset(t *testing.T) {
	d, _ := evmTestDefaults()
	for _, asset := range []string{"eip155:1", "eip155:1/erc20", "eip155:1/erc20:", "/erc20:0x1"} {
		_, err := evmAdapter{}.BuildAuthMessage(BuildParams{
			SourceAsset: asset, MaxSourceAmount: "1000000", SourceDefaults: d,
			Nonce: big.NewInt(123), Deadline: big.NewInt(1924991999),
		})
		require.ErrorContains(t, err, "invalid source asset", asset)
	}

	_, err := tronAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset: "tron:mainnet", MaxSourceAmount: "1000000", SourceDefaults: d,
		Nonce: big.NewInt(123), Deadline: big.NewInt(1924991999),
	})
	require.ErrorContains(t, err, "invalid source asset")

	_, err = solanaAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset: "solana:mainnet", MaxSourceAmount: "1000000", RequestID: "req_sol_bad",
		SourceDefaults: d, Nonce: big.NewInt(123),
	})
	require.ErrorContains(t, err, "invalid source asset")
}

// TestTronBuildRefusesNonTronNetwork: with Permit2Contract supplied, the namespace check alone
// stops a Tron TIP-712 domain being signed for a network the identifier does not name. Mirrors
// the TS case.
func TestTronBuildRefusesNonTronNetwork(t *testing.T) {
	d, _ := evmTestDefaults()
	d.Permit2Contract = "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m"
	_, err := tronAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset: "eip155:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", MaxSourceAmount: "1000000",
		SourceDefaults: d, Nonce: big.NewInt(123), Deadline: big.NewInt(1924991999),
	})
	require.ErrorContains(t, err, "expected a tron network")
}

// TestEvmBuildRefusesNonAddressToken: common.HexToAddress maps anything unreadable to the zero
// address, so a token segment that is not an address must be refused rather than signed as 0x0.
// The TS chain library refuses the same values.
func TestEvmBuildRefusesNonAddressToken(t *testing.T) {
	d, _ := evmTestDefaults()
	for _, token := range []string{"notanaddress", "zzzz", "0x", "0x1", "0x555555555555555555555555555555555555555"} {
		_, err := evmAdapter{}.BuildAuthMessage(BuildParams{
			SourceAsset: "eip155:1/erc20:" + token, MaxSourceAmount: "1000000", SourceDefaults: d,
			Nonce: big.NewInt(123), Deadline: big.NewInt(1924991999),
		})
		require.ErrorContains(t, err, "is not an address", token)
	}
}
