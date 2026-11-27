package senderauth

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	tvmencoding "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/tvm/bindings/go/escrow-encoding/encoding"
	tvmcontracts "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/tvm/bindings/go/escrow-encoding/generated"
	paymentrequest "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated"

	"github.com/ethereum/go-ethereum/common"
)

// tronAdapter is the Tron TIP-712 sender_auth adapter. Mirrors the TS Tron adapter. The
// message scheme stays EVM_PERMIT2 (Tron uses the same Permit2 wire format).
type tronAdapter struct{}

func (tronAdapter) BuildAuthMessage(params BuildParams) (AuthMessageResult, error) {
	sourceChainID := strings.SplitN(params.SourceAsset, "/", 2)[0]
	tokenAddress, err := assetAddress(params.SourceAsset)
	if err != nil {
		return AuthMessageResult{}, err
	}
	permit2B58 := params.SourceDefaults.Permit2Contract
	if permit2B58 == "" {
		permit2B58, err = resolveTronPermit2(sourceChainID)
		if err != nil {
			return AuthMessageResult{}, err
		}
	}
	chainID, err := tronNumericChainID(sourceChainID, nil)
	if err != nil {
		return AuthMessageResult{}, err
	}
	amountField, amountText, err := params.depositAmount()
	if err != nil {
		return AuthMessageResult{}, err
	}
	amount, ok := new(big.Int).SetString(amountText, 10)
	if !ok {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: invalid %s %q", amountField, amountText)
	}
	if params.Deadline == nil {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: BuildAuthMessage requires an explicit permit deadline (absolute Unix seconds) — the low-level builder does not default it; derive it from the payment's fulfillment/settlement deadline in the calling layer")
	}
	if params.Deadline.Sign() < 0 || params.Deadline.Cmp(big.NewInt(maxDeadlineSec)) > 0 {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: permit deadline %s is outside 0..%d", params.Deadline, maxDeadlineSec)
	}
	if params.Nonce == nil {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: BuildAuthMessage requires an explicit nonce — derive it deterministically from a stable request id (e.g. an order id) so retries reproduce the same permit; pass GeneratePermitNonce() only for genuinely one-shot builds")
	}

	permit2Addr, err := tvmencoding.TVMAddress(permit2B58)
	if err != nil {
		return AuthMessageResult{}, err
	}
	tokenAddr, err := tvmencoding.TVMAddress(tokenAddress)
	if err != nil {
		return AuthMessageResult{}, err
	}
	spenderAddr, err := tvmencoding.TVMAddress(params.SourceDefaults.EscrowContract)
	if err != nil {
		return AuthMessageResult{}, err
	}
	reserverAddr, err := tvmencoding.TVMAddress(params.SourceDefaults.QuoteSelector)
	if err != nil {
		return AuthMessageResult{}, err
	}
	releaserAddr, err := tvmencoding.TVMAddress(params.SourceDefaults.FulfillmentVerifierAccount)
	if err != nil {
		return AuthMessageResult{}, err
	}

	// The two escrow commitments, composed through the shared helpers.
	depositRequestHash, destination, err := params.commitments(sameTronAddress)
	if err != nil {
		return AuthMessageResult{}, err
	}

	enc := tvmencoding.NewEscrowDepositEncoder()
	hash, typedData, err := enc.DigestWithDestination(
		permit2Addr,
		tokenAddr,
		spenderAddr,
		tvmcontracts.IEscrowDepositWitness{
			DepositRequestHash: depositRequestHash,
			Destination:        destination,
			Reserver:           reserverAddr,
			Releaser:           releaserAddr,
		},
		amount,
		resolvePermitNonce(params.Nonce),
		resolvePermitDeadline(params.Deadline),
		big.NewInt(chainID),
	)
	if err != nil {
		return AuthMessageResult{}, err
	}
	prehashJSON, err := json.Marshal(typedData)
	if err != nil {
		return AuthMessageResult{}, err
	}
	return AuthMessageResult{
		MessageScheme:  paymentrequest.SenderAuthMessageSchemeEVMPERMIT2,
		MessageHash:    "0x" + common.Bytes2Hex(hash),
		MessagePrehash: string(prehashJSON),
	}, nil
}

func (tronAdapter) Sign(signed SignedMessageInput, privateKey string) (string, error) {
	return secp256k1SignDigest(signed.Message, privateKey)
}

func (tronAdapter) RecoverAndVerify(signed SignedMessageInput, source SourceRef, commitment CommitmentExpectation, expected Expectations) (VerifiedSenderAuth, error) {
	// The Permit2 the escrow uses comes from the verifier (or the pinned per-network address),
	// never from the client-supplied prehash.
	permit2B58 := expected.Permit2Contract
	if permit2B58 == "" {
		var err error
		if permit2B58, err = resolveTronPermit2(source.Network); err != nil {
			return VerifiedSenderAuth{}, commitmentRefusal("tron", OutcomeVerifierMisconfigured, detailNoTronPermit2)
		}
	}
	permit2, err := tvmencoding.NormalizeAddress(permit2B58)
	if err != nil {
		return VerifiedSenderAuth{}, fmt.Errorf("sender_auth: expected Permit2 contract %q is not a Tron address", permit2B58)
	}
	p, err := readPermitForVerify("tron", signed, source, "0x"+permit2, commitment)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	if !permitSignerIs("tron", signed, source.Account) {
		return VerifiedSenderAuth{}, commitmentRefusal("tron", OutcomeSignerMismatch, detailSignerMismatch)
	}

	f := p.fields
	amount := f.amount.String()
	deadlineSec := p.deadlineSec
	if err := assertToken(f.token, source.Asset, tronNormalize); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if err := assertPermitAmount("tron", amount, expected); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if err := assertFresh(deadlineSec, expectedNow(expected)); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if expected.EscrowContract != "" {
		if err := assertSpender(f.spender, expected.EscrowContract, tronNormalize); err != nil {
			return VerifiedSenderAuth{}, err
		}
	}
	if err := assertRolePairComplete(expected.Reserver, expected.Releaser); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if expected.Reserver != "" && expected.Releaser != "" {
		if err := assertWitnessRoles(f.reserver, f.releaser, expected.Reserver, expected.Releaser, tronNormalize); err != nil {
			return VerifiedSenderAuth{}, err
		}
	}
	result, err := requireCommitment("tron", p.destination, p.hashText, p.hash, commitment)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	result.Scheme = string(paymentrequest.SenderAuthMessageSchemeEVMPERMIT2)

	return VerifiedSenderAuth{
		AuthTerms: AuthTerms{Amount: amount, DeadlineSec: deadlineSec},
		Permit: ParsedPermit{
			Scheme:             paymentrequest.SenderAuthMessageSchemeEVMPERMIT2,
			Token:              f.token,
			Amount:             amount,
			DeadlineSec:        deadlineSec,
			Reserver:           f.reserver,
			Releaser:           f.releaser,
			Spender:            f.spender,
			Destination:        p.destination,
			DepositRequestHash: p.hashText,
		},
		Commitment: result,
	}, nil
}

// RecoverSigner recovers the secp256k1 signer of the signed message's own digest and confirms
// it is source.account (in Tron's canonical hex form), without parsing or binding a permit: the
// recover-only primitive a multi-message verifier runs over every signed_messages[] entry.
// Returns source.account on success. Mirrors the TS `recoverSigner`.
func (tronAdapter) RecoverSigner(signed SignedMessageInput, source SourceRef) (string, error) {
	recovered, err := recoverEVMAddress(signed.Message, signed.Signature)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRecoveryFailed, err)
	}
	if !sameAddress(recovered.Hex(), tronNormalize(source.Account)) {
		return "", fmt.Errorf("%w: recovered %s", ErrSignerMismatch, recovered.Hex())
	}
	return source.Account, nil
}

// sameTronAddress is address equality for Tron, which spells an address in base58 or hex: both are
// compared in tronNormalize's form.
func sameTronAddress(a, b string) bool {
	return sameAddress(tronNormalize(a), tronNormalize(b))
}

// tronNormalize mirrors the TS `normalizeAddress` used by the Tron adapter: it
// converts a base58 or hex Tron address to bare 0x-prefixed 20-byte hex so both
// sides of an address comparison are in the same form. On an unparseable input it
// returns the address unchanged, which then fails the equality check downstream.
func tronNormalize(addr string) string {
	n, err := tvmencoding.NormalizeAddress(addr)
	if err != nil {
		return addr
	}
	return "0x" + n
}
