package senderauth

// SenderSignature is the result of signing one sender_auth message. Mirrors TS
// SenderSignature.
type SenderSignature struct {
	// Signature is the 0x-prefixed signature hex (65-byte secp256k1 for EVM/Tron, 64-byte
	// ed25519 for Solana).
	Signature string
	// DelegateSigner is the base58 signer public key for non-recoverable schemes (Solana),
	// attached to the signed message's payload.delegate_signer. Empty for EVM/Tron.
	DelegateSigner string
}

// SenderSigner is the signing plug-in point: it produces the signature (and, for Solana, the
// delegate public key) for one sender_auth message. This is the ONLY signing surface the SDK
// defines — it holds no key material and knows nothing about any wallet provider.
//
// Remote/opaque providers (Turnkey, Fireblocks, Utila, HSM/KMS/MPC) implement this interface
// OUTSIDE the SDK and are injected by the consumer. The SDK ships exactly one built-in
// implementation — LocalKeySigner — for raw local private keys. Mirrors TS SenderSigner.
//
// EVM and Tron signatures are r || s || v with v 27/28: Permit2 passes v to ecrecover unchanged,
// so a v of 0/1 (raw go-ethereum crypto.Sign output) reverts the deposit.
type SenderSigner interface {
	Sign(signedMessage SignedMessageInput) (SenderSignature, error)
}

// NetworkBoundSigner is implemented by a SenderSigner whose key is for one CAIP-2 network. An entry
// point that holds the request (pgclient.SignSenderAuth) refuses a request whose source is another
// network: a Stellar key signs 32 bytes as a transaction signature too, so it must not be handed a
// message the request calls an EVM permit. LocalKeySigner's signer implements it; a signer that does
// not is checked against the request's own source network only.
type NetworkBoundSigner interface {
	SenderSigner
	// Network is the CAIP-2 network the signer's key is for.
	Network() string
}

// localKeySigner is the SDK's only built-in signer: a raw local private key for one CAIP-2
// network, backed by the chain adapter's own signing primitive.
type localKeySigner struct {
	adapter    ChainAdapter
	network    string
	privateKey string
}

// LocalKeySigner returns a raw-private-key SenderSigner for the given CAIP-2 network. It uses
// the chain adapter's signing primitive and attaches the delegate public key on chains whose
// signatures are not recoverable (Solana). Remote signers do NOT belong here — implement
// SenderSigner in the provider's own package and inject it. Mirrors TS localKeySigner.
func LocalKeySigner(network, privateKey string) (SenderSigner, error) {
	adapter, err := GetChainAdapter(network)
	if err != nil {
		return nil, err
	}
	return &localKeySigner{adapter: adapter, network: network, privateKey: privateKey}, nil
}

// Network is the CAIP-2 network LocalKeySigner was constructed for.
func (s *localKeySigner) Network() string { return s.network }

func (s *localKeySigner) Sign(signedMessage SignedMessageInput) (SenderSignature, error) {
	signature, err := s.adapter.Sign(signedMessage, s.privateKey)
	if err != nil {
		return SenderSignature{}, err
	}
	out := SenderSignature{Signature: signature}
	if deriver, ok := s.adapter.(DelegateSignerDeriver); ok {
		delegate, err := deriver.DeriveDelegateSigner(s.privateKey)
		if err != nil {
			return SenderSignature{}, err
		}
		out.DelegateSigner = delegate
	}
	return out, nil
}
