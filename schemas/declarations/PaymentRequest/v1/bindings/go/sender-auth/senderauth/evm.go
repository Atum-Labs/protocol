package senderauth

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	evmcontracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// permit2ContractAddress is the well-known (Uniswap) Permit2 verifying contract,
// identical across all EVM chains. Mirrors TS PERMIT2_CONTRACT_ADDRESS.
const permit2ContractAddress = "0x000000000022D473030F116dDEE9F6B43aC78BA3"

// evmAdapter is the EVM Permit2 sender_auth adapter. Mirrors the TS EVM adapter.
type evmAdapter struct{}

func (evmAdapter) BuildAuthMessage(params BuildParams) (AuthMessageResult, error) {
	// Shape first, matching the Tron and Solana adapters and all three TS adapters, so a
	// malformed identifier names itself instead of being reported as a bad chain id.
	tokenAddress, err := assetAddress(params.SourceAsset)
	if err != nil {
		return AuthMessageResult{}, err
	}
	// common.HexToAddress maps anything it cannot read to the zero address, so an unreadable
	// token is refused rather than signed as 0x0. The TS chain library refuses the same values.
	if !common.IsHexAddress(tokenAddress) {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: source asset token %q is not an address", tokenAddress)
	}
	sourceChainID := strings.SplitN(params.SourceAsset, "/", 2)[0]
	chainIDNum, err := evmChainID(sourceChainID)
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
	if params.Nonce == nil {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: BuildAuthMessage requires an explicit nonce — derive it deterministically from a stable request id (e.g. an order id) so retries reproduce the same permit; pass GeneratePermitNonce() only for genuinely one-shot builds")
	}
	if params.Deadline == nil {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: BuildAuthMessage requires an explicit permit deadline (absolute Unix seconds) — the low-level builder does not default it; derive it from the payment's fulfillment/settlement deadline in the calling layer")
	}
	if params.Deadline.Sign() < 0 || params.Deadline.Cmp(big.NewInt(maxDeadlineSec)) > 0 {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: permit deadline %s is outside 0..%d", params.Deadline, maxDeadlineSec)
	}

	// The two escrow commitments, composed through the shared helpers. Populate them
	// explicitly: an omitted field is not a compile error and would sign a zero
	// depositRequestHash and an empty destination.
	depositRequestHash, destination, err := params.commitments(sameAddress)
	if err != nil {
		return AuthMessageResult{}, err
	}

	enc := evmencoding.NewEscrowDepositEncoder()
	witness := evmcontracts.IEscrowDepositWitness{
		DepositRequestHash: depositRequestHash,
		Destination:        destination,
		Reserver:           common.HexToAddress(params.SourceDefaults.QuoteSelector),
		Releaser:           common.HexToAddress(params.SourceDefaults.FulfillmentVerifierAccount),
	}
	permit2 := permit2ContractAddress
	if params.SourceDefaults.Permit2Contract != "" {
		if !common.IsHexAddress(params.SourceDefaults.Permit2Contract) {
			return AuthMessageResult{}, fmt.Errorf("sender_auth: Permit2 contract %q is not an address", params.SourceDefaults.Permit2Contract)
		}
		permit2 = params.SourceDefaults.Permit2Contract
	}
	hash, typedData, err := enc.DigestWithDestination(
		common.HexToAddress(permit2),
		common.HexToAddress(tokenAddress),
		common.HexToAddress(params.SourceDefaults.EscrowContract),
		witness,
		amount,
		resolvePermitNonce(params.Nonce),
		resolvePermitDeadline(params.Deadline),
		big.NewInt(chainIDNum),
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

func (evmAdapter) Sign(signed SignedMessageInput, privateKey string) (string, error) {
	return secp256k1SignDigest(signed.Message, privateKey)
}

func (evmAdapter) RecoverAndVerify(signed SignedMessageInput, source SourceRef, commitment CommitmentExpectation, expected Expectations) (VerifiedSenderAuth, error) {
	// The Permit2 the escrow uses comes from the verifier, never from the client-supplied prehash.
	permit2 := permit2ContractAddress
	if expected.Permit2Contract != "" {
		if !hexAddressPattern.MatchString(expected.Permit2Contract) {
			return VerifiedSenderAuth{}, fmt.Errorf("sender_auth: expected Permit2 contract %q is not an address", expected.Permit2Contract)
		}
		permit2 = expected.Permit2Contract
	}
	p, err := readPermitForVerify("eip155", signed, source, permit2, commitment)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	if !permitSignerIs("eip155", signed, source.Account) {
		return VerifiedSenderAuth{}, commitmentRefusal("eip155", OutcomeSignerMismatch, detailSignerMismatch)
	}

	f := p.fields
	amount := f.amount.String()
	deadlineSec := p.deadlineSec
	if err := assertToken(f.token, source.Asset, identityAddr); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if err := assertPermitAmount("eip155", amount, expected); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if err := assertFresh(deadlineSec, expectedNow(expected)); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if expected.EscrowContract != "" {
		if err := assertSpender(f.spender, expected.EscrowContract, identityAddr); err != nil {
			return VerifiedSenderAuth{}, err
		}
	}
	if err := assertRolePairComplete(expected.Reserver, expected.Releaser); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if expected.Reserver != "" && expected.Releaser != "" {
		if err := assertWitnessRoles(f.reserver, f.releaser, expected.Reserver, expected.Releaser, identityAddr); err != nil {
			return VerifiedSenderAuth{}, err
		}
	}
	// Recovery proves the commitment is authentic; this proves it is the payment's own.
	result, err := requireCommitment("eip155", p.destination, p.hashText, p.hash, commitment)
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
// it is source.account, without parsing or binding a permit: the recover-only primitive a
// multi-message verifier runs over every signed_messages[] entry, including non-Permit2 setup
// approvals. Returns source.account on success. Mirrors the TS `recoverSigner`.
func (evmAdapter) RecoverSigner(signed SignedMessageInput, source SourceRef) (string, error) {
	recovered, err := recoverEVMAddress(signed.Message, signed.Signature)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRecoveryFailed, err)
	}
	if !sameAddress(recovered.Hex(), source.Account) {
		return "", fmt.Errorf("%w: recovered %s", ErrSignerMismatch, recovered.Hex())
	}
	return source.Account, nil
}

var evmSignaturePattern = regexp.MustCompile(`^0x[0-9a-fA-F]{130}$`)

// recoverEVMAddress recovers the signer of a 0x-hex 32-byte digest from a 0x-hex 65-byte secp256k1
// signature whose recovery id is 0, 1, 27 or 28. Any other spelling is refused, so a deposit has
// exactly one accepted signature string. Mirrors the TS `recoverEvmSigner`.
func recoverEVMAddress(message, signature string) (common.Address, error) {
	if !digestPattern.MatchString(message) {
		return common.Address{}, fmt.Errorf("the message is not a 0x-prefixed 32-byte hex digest")
	}
	if !evmSignaturePattern.MatchString(signature) {
		return common.Address{}, fmt.Errorf("the signature is not a 0x-prefixed 65-byte hex secp256k1 signature")
	}
	digest, _ := hex.DecodeString(message[2:])
	sigCopy, _ := hex.DecodeString(signature[2:])
	if v := sigCopy[64]; v != 0 && v != 1 && v != 27 && v != 28 {
		return common.Address{}, fmt.Errorf("the signature recovery id is not 0, 1, 27 or 28")
	}
	if sigCopy[64] >= 27 {
		sigCopy[64] -= 27
	}
	// Reject non-canonical (EIP-2 high-s) and out-of-range r/s before recovery, matching the TS
	// side (ethers rejects high-s). go-ethereum's SigToPub does not enforce low-s, and a malleated
	// (r, n-s) signature would otherwise be a second valid signature for the same deposit.
	r := new(big.Int).SetBytes(sigCopy[:32])
	s := new(big.Int).SetBytes(sigCopy[32:64])
	if !crypto.ValidateSignatureValues(sigCopy[64], r, s, true) {
		return common.Address{}, fmt.Errorf("sender_auth: non-canonical signature (EIP-2 high-s or invalid r/s)")
	}
	pub, err := crypto.SigToPub(digest, sigCopy)
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}
