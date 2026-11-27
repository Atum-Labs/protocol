// Package pgclient is the Go counterpart of the @atum-labs/payment-gateway-client
// TypeScript package: one import that gives an originator everything needed to sign a
// PaymentRequest.
//
// # Three signatures, not one
//
// A PaymentRequest carries three unrelated signatures, and an originator generally needs
// more than one of them. Naming them explicitly, because the difference decides which
// helper to call:
//
//   - sender_auth.signed_messages[] authorizes the ON-CHAIN TRANSFER. Per-chain wallet
//     signatures over Permit2 / Solana deposit / Tron TIP-712 messages. Signed with the
//     depositor's wallet key. See SignSenderAuth.
//   - the inner proof block attests that the DOCUMENT came from its signer: a W3C Data
//     Integrity proof over the URDNA2015-canonicalized request.
//   - presentation (PaymentRequestEnvelope) carries the ORIGINATOR'S IDENTITY: a
//     holder-signed VerifiablePresentation wrapping the signed request plus the
//     originator's issuer-signed credentials.
//
// Signing one does not stand in for another. A request with a valid sender_auth and no
// identity envelope authorizes a transfer by an unidentified originator; the reverse
// identifies an originator who has authorized nothing.
//
// # Cryptography
//
// No cryptography is implemented here. Every primitive comes from the library that the
// corresponding VERIFIER already uses, because a signer and a verifier on different
// implementations is how signature mismatches reach production:
//
//   - secp256k1, keccak256, EIP-712 (EVM and Tron): github.com/ethereum/go-ethereum
//   - ed25519 (Solana): the standard library's crypto/ed25519
//   - base58 (Solana, Tron): github.com/mr-tron/base58
//   - URDNA2015 canonicalization: github.com/piprate/json-gold
//
// # Keys
//
// This package holds no key material. SignSenderAuth takes a senderauth.SenderSigner, an
// interface with a single Sign method; remote custodians (Turnkey, Fireblocks, HSM/KMS,
// MPC) implement it outside this package and are injected by the caller. The only built-in
// implementation is senderauth.LocalKeySigner, for a raw local private key.
package pgclient

import (
	generated "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
	senderauth "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
)

// PaymentRequest is a PaymentRequest v1 document.
//
// Aliased because go-jsonschema names the root type after the file it generated from
// (SchemaJson), which tells a caller nothing. The alias is not a wrapper: it is the same
// type, so a value produced or consumed anywhere else in the tree is usable here without
// conversion.
type PaymentRequest = generated.SchemaJson

// SenderAuth is the sender_auth block: the message scheme plus the signed messages that
// authorize the on-chain transfer.
type SenderAuth = generated.SenderAuth

// SignedMessage is one entry of sender_auth.signed_messages[].
type SignedMessage = generated.SignedMessage

// SenderAuthMessageScheme names the per-chain signing scheme (EVM_PERMIT2,
// EVM_PERMIT2_ESCROW, SOLANA).
type SenderAuthMessageScheme = generated.SenderAuthMessageScheme

// PaymentRequestEnvelope is the holder-signed VerifiablePresentation carried in
// PaymentRequest.presentation.
type PaymentRequestEnvelope = generated.PaymentRequestEnvelope

// The two signer interfaces a caller has to IMPLEMENT, re-exported so they can be named.
//
// Without these an integrator could still satisfy them structurally -- Go interfaces do not
// require an import -- but they could not write the type down: `var s pgclient.DeclarationSigner`
// would not compile, and the canonical packages now live under internal/ precisely so nobody
// builds against our vendored copy. Naming a type you must implement is the difference between
// an API and a puzzle.

// DeclarationSigner signs a 32-byte digest with the holder's secp256k1 key, and is what
// SignDeclaration and BuildEnvelope take. It never sees a private key: implement it over a KMS,
// an HSM or a custodial provider's own digest-signing call. LocalKeySigner covers a local key.
type DeclarationSigner = lddataintegrity.Secp256k1Signer

// SenderSigner signs the on-chain transfer authorizations in sender_auth.signed_messages[], and
// is what SignSenderAuth takes. Distinct from DeclarationSigner because the two sign different
// things: this one moves funds, that one attests the document.
type SenderSigner = senderauth.SenderSigner
