package senderauth

import (
	"context"
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

func TestLocalKeySignerEVM(t *testing.T) {
	d, token := evmTestDefaults()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	account := crypto.PubkeyToAddress(key.PublicKey).Hex()
	priv := hex.EncodeToString(crypto.FromECDSA(key))

	res, err := evmAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset:        "eip155:1/erc20:" + token,
		MaxSourceAmount:    "1000000",
		SourceDefaults:     d,
		RequestID:          "req_test",
		DestinationAsset:   "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		DestinationAccount: "0xC0FFEE254729296a45a3885639AC7E10F9d54979",
		Nonce:              big.NewInt(123),
		Deadline:           big.NewInt(1924991999),
	})
	require.NoError(t, err)
	prehash := res.MessagePrehash
	signed := SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}

	signer, err := LocalKeySigner("eip155:1", priv)
	require.NoError(t, err)
	sig, err := signer.Sign(signed)
	require.NoError(t, err)
	require.Empty(t, sig.DelegateSigner, "EVM signatures are recoverable — no delegate signer")

	signed.Signature = sig.Signature
	recovered, err := evmAdapter{}.RecoverSigner(signed, SourceRef{Network: "eip155:1", Asset: token, Account: account})
	require.NoError(t, err)
	require.Equal(t, account, recovered)

	requirePermit2AcceptsEOA(t, "eip155:1", account, res.MessageHash, sig.Signature)
}

func TestLocalKeySignerTron(t *testing.T) {
	d, token := tronTestDefaults()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	account := "41" + hex.EncodeToString(crypto.PubkeyToAddress(key.PublicKey).Bytes())
	priv := hex.EncodeToString(crypto.FromECDSA(key))

	res, err := tronAdapter{}.BuildAuthMessage(BuildParams{
		SourceAsset:        "tron:mainnet/trc20:" + token,
		MaxSourceAmount:    "10000000",
		SourceDefaults:     d,
		RequestID:          "req_test",
		DestinationAsset:   "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		DestinationAccount: "TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB",
		Nonce:              big.NewInt(456),
		Deadline:           big.NewInt(1924991999),
	})
	require.NoError(t, err)
	prehash := res.MessagePrehash
	signed := SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}

	signer, err := LocalKeySigner("tron:mainnet", priv)
	require.NoError(t, err)
	sig, err := signer.Sign(signed)
	require.NoError(t, err)
	require.Empty(t, sig.DelegateSigner, "Tron signatures are recoverable, no delegate signer")

	signed.Signature = sig.Signature
	recovered, err := tronAdapter{}.RecoverSigner(signed, SourceRef{Network: "tron:mainnet", Asset: token, Account: account})
	require.NoError(t, err)
	require.Equal(t, account, recovered)

	requirePermit2AcceptsEOA(t, "tron:mainnet", account, res.MessageHash, sig.Signature)
}

// requirePermit2AcceptsEOA asserts Permit2 would accept a key account's signature. Permit2 passes v
// to ecrecover unchanged, so only v 27/28 lands; the offline verdict is enough for an EOA.
func requirePermit2AcceptsEOA(t *testing.T, network, account, digest, signature string) {
	t.Helper()
	got := VerifyDepositorSignature(context.Background(), DepositorSignature{
		Network: network, Account: account, Digest: digest, Signature: signature,
	}, nil)
	require.Equal(t, DepositorSignatureResult{
		Valid: true, Path: PathEOA, Reason: ReasonVerified, Detail: "the signature recovers to the account",
	}, got)
}

func TestLocalKeySignerSolana(t *testing.T) {
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	priv := hex.EncodeToString(seed)

	adapter := solanaAdapter{}
	delegate, err := adapter.DeriveDelegateSigner(priv)
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
		SourceAsset:     "solana:mainnet/token:" + mint,
		Depositor:       delegate,
		MaxSourceAmount: "1000000",
		RequestID:       "req-signer-sol",
		SourceDefaults:  defaults,
		// Base58 destination: the composer preserves these byte-for-byte (only eip155 is
		// lowercased), so a Solana payee must be spelled exactly as it will be committed.
		DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
		SolanaClock:        func(string) (uint64, error) { return 1700000000, nil },
	})
	require.NoError(t, err)
	prehash := res.MessagePrehash
	signed := SignedMessageInput{
		Message:        res.MessageHash,
		MessagePrehash: &prehash,
		Payload:        map[string]interface{}{"delegate_signer": delegate},
	}

	signer, err := LocalKeySigner("solana:mainnet", priv)
	require.NoError(t, err)
	sig, err := signer.Sign(signed)
	require.NoError(t, err)
	require.Equal(t, delegate, sig.DelegateSigner, "Solana attaches the delegate public key")

	signed.Signature = sig.Signature
	recovered, err := adapter.RecoverSigner(signed, SourceRef{Network: "solana:mainnet", Asset: mint, Account: delegate})
	require.NoError(t, err)
	require.Equal(t, delegate, recovered)
}
