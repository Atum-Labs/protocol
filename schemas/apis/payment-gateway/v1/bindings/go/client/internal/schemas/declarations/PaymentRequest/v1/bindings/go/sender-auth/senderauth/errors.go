package senderauth

import "errors"

// ErrMalformedPrehash is returned by RecoverAndVerify when a signed message's message_prehash
// is absent, unparseable, or not a hashable deposit permit, so there is no permit to bind.
// Detect it with errors.Is. Mirrors the TS `MalformedPrehashError`.
var ErrMalformedPrehash = errors.New("sender_auth: malformed message_prehash")

// ErrRecoveryFailed is returned by RecoverSigner when no signer could be derived from the
// signed message at all: malformed or short hex, a non-canonical (EIP-2 high-s) secp256k1
// signature, or a structurally invalid Solana message, signature or pubkey. It is distinct from
// ErrSignerMismatch so a consumer can tell a signature-format or wallet-compatibility issue from
// an authentication failure.
var ErrRecoveryFailed = errors.New("sender_auth: could not recover a signer from the signed message")

// ErrSignerMismatch is returned by RecoverSigner when a signer was recovered or verified but is
// not source.account. On Solana (ed25519 is not key-recoverable) a wrong key and a bad
// signature are indistinguishable, so both surface as ErrSignerMismatch.
var ErrSignerMismatch = errors.New("sender_auth: recovered signer does not match source.account")

// ErrDelegateUnverified is returned by RecoverSigner and RecoverAndVerify on Stellar when the
// signature verifies under payload.delegate_signer but that key is not source.account. The signer
// is named by the requester, and whether it is registered for the depositor is on-chain state no
// offline check reads, so the payer has not been shown to have consented. It is distinct from
// ErrSignerMismatch (a bad signature or the wrong key) and from ErrRecoveryFailed (malformed
// input): a consumer that can read the chain may admit the payment after that check. Detect it with
// errors.Is. Mirrors the TS `DelegateUnverifiedError`.
var ErrDelegateUnverified = errors.New("sender_auth: the delegate signer is not source.account and is not verified as registered for it")

// ErrPermitAmountMismatch is returned by RecoverAndVerify when the permit amount is not the amount
// the verifier binds it to: max_source_amount, or Expectations.QuoteSourceAmount when that is set.
// Detect it with errors.Is. Mirrors the TS `PermitAmountMismatchError`.
var ErrPermitAmountMismatch = errors.New("sender_auth: permit amount does not match")
