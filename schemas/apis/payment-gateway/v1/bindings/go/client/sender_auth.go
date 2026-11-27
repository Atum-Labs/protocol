package pgclient

import (
	"errors"
	"fmt"
	"strings"

	"github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
)

// ErrNoSignedMessages is returned when there is nothing to sign: sender_auth is absent, or
// its signed_messages array is empty. The schema requires at least one entry, so this is a
// malformed request rather than a no-op, and it is reported instead of returning success
// over an unsigned request.
var ErrNoSignedMessages = errors.New("pgclient: sender_auth.signed_messages must contain at least one message to sign")

// SignSenderAuth signs every entry of req.SenderAuth.SignedMessages, authorizing the
// on-chain transfer. It is the Go counterpart of the TypeScript client's
// signPaymentRequest.
//
// Each entry's Signature is filled in, and on chains whose signatures are not recoverable
// from the message (Solana and Stellar) the signer's public key is attached as
// payload.delegate_signer, because the verifier cannot recover the signer and has nothing
// else to check the signature against. On Stellar that key is the delegate signer's, which an
// offline verifier admits only when it is the depositor's own key.
//
// A Stellar request, or a signer bound to a Stellar network, is checked first: every message must
// be the deposit digest of its own message_prehash under the request's source network and escrow
// (senderauth.AssertStellarSignable), or nothing is signed. A Stellar key signs 32 bytes with plain
// ed25519, which is also how a Stellar transaction is signed, so without the check a requester could
// set message to a transaction hash and get the payer's key's signature on it. A signer bound to a
// network (senderauth.NetworkBoundSigner, as LocalKeySigner's is) is refused a request whose source
// is another network.
//
// The signer carries its own chain adapter — senderauth.LocalKeySigner is constructed for
// one CAIP-2 network — so no chain resolution happens here. A request whose messages span
// chains needs one call per signer.
//
// Signatures are computed for every message before any is written, so a failure part-way
// leaves req untouched rather than half-signed. This differs deliberately from the
// TypeScript helper, which mutates as it goes: a half-signed request is indistinguishable
// from a complete one to a caller that ignores the error, and the gateway would reject it
// with an error about the wrong message. Output on success is identical.
func SignSenderAuth(req *PaymentRequest, signer senderauth.SenderSigner) error {
	return SignSenderAuthWithScheme(req, signer, "")
}

// SignSenderAuthWithScheme is SignSenderAuth for a request whose Solana escrow signs with
// svmMessageScheme, the svm_message /v1/defaults lists for req.EscrowContractAddress in its
// escrows. "" signs the 32-byte hash itself, as SignSenderAuth does; "escrow-text-v1" signs the
// escrow text over it. The scheme is handed to the signer only and is never part of the request.
func SignSenderAuthWithScheme(req *PaymentRequest, signer senderauth.SenderSigner, svmMessageScheme string) error {
	if req == nil {
		return errors.New("pgclient: req must not be nil")
	}
	if signer == nil {
		return errors.New("pgclient: signer must not be nil")
	}
	if req.SenderAuth == nil || len(req.SenderAuth.SignedMessages) == 0 {
		return ErrNoSignedMessages
	}

	messages := req.SenderAuth.SignedMessages
	if err := assertRequestSignable(req, signer); err != nil {
		return err
	}
	signatures := make([]senderauth.SenderSignature, len(messages))
	for i, m := range messages {
		// The adapters consume the binding-agnostic SignedMessageInput rather than the
		// generated type, so that consumers holding a different copy of the bindings can
		// call them. That mapping is unexported in senderauth, so it is repeated here —
		// as its own documentation anticipates.
		sig, err := signer.Sign(senderauth.SignedMessageInput{
			Message:          m.Message,
			Signature:        m.Signature,
			MessagePrehash:   &m.MessagePrehash,
			Payload:          m.Payload,
			SvmMessageScheme: svmMessageScheme,
		})
		if err != nil {
			return fmt.Errorf("pgclient: signing sender_auth.signed_messages[%d]: %w", i, err)
		}
		signatures[i] = sig
	}

	for i := range messages {
		// Indexed, not `for _, m := range`: ranging copies each struct, so writes would
		// land on the copy and the request would come back unsigned.
		m := &messages[i]
		m.Signature = signatures[i].Signature
		if signatures[i].DelegateSigner != "" {
			if m.Payload == nil {
				m.Payload = map[string]interface{}{}
			}
			m.Payload["delegate_signer"] = signatures[i].DelegateSigner
		}
	}
	return nil
}

// assertRequestSignable is the Stellar guard of SignSenderAuth: see its comment.
func assertRequestSignable(req *PaymentRequest, signer senderauth.SenderSigner) error {
	requestNetwork := strings.SplitN(req.Source.AssetIdentifier, "/", 2)[0]
	isStellar := func(network string) bool { return strings.HasPrefix(strings.ToLower(network), "stellar:") }
	signerNetwork := ""
	if bound, ok := signer.(senderauth.NetworkBoundSigner); ok {
		signerNetwork = bound.Network()
	}
	if !isStellar(requestNetwork) && !isStellar(signerNetwork) {
		return nil
	}
	if signerNetwork != "" && !strings.EqualFold(signerNetwork, requestNetwork) {
		return fmt.Errorf("pgclient: the signer is for %s but the request's source is %q: refusing to sign", signerNetwork, requestNetwork)
	}
	for i, m := range req.SenderAuth.SignedMessages {
		err := senderauth.AssertStellarSignable(senderauth.SignedMessageInput{
			Message:        m.Message,
			Signature:      m.Signature,
			MessagePrehash: &m.MessagePrehash,
			Payload:        m.Payload,
		}, requestNetwork, req.EscrowContractAddress)
		if err != nil {
			return fmt.Errorf("pgclient: sender_auth.signed_messages[%d]: %w", i, err)
		}
	}
	return nil
}
