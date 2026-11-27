# Stellar Escrow Encoding

Go library for the digests the Soroban escrow signs and stores. The byte layouts are specified in
`contracts/stellar/source/docs/witness-layouts.md` and implemented by
`contracts/stellar/source/contracts/escrow/src/signatures.rs`; the TypeScript twin is
`../../typescript/escrow-encoding`.

Every signature is raw ed25519 over exactly the 32 digest bytes, with no prefix or SEP-53 framing.
This package computes the digest; it does not sign.

| Function                  | Signed by                      | Digest                                        |
| ------------------------- | ------------------------------ | --------------------------------------------- |
| `ComputeDepositHash`      | the depositor's delegate signer | deposit digest, which is also the deposit id |
| `ComputeReserveHash`      | the reserver                   | reserve digest, binds `source_amount`         |
| `ComputeReleaseHash`      | the releaser                   | eleven-member release witness                 |
| `ComputeRefundHash`       | the releaser                   | same witness, tag `refund`                    |
| `ComputeRenounceHash`     | the delegate signer            | renounce digest (epoch, nonce, deadline)      |
| `ComputeActiveDepositHash`| nobody (stored)                | what `get_deposit_hash` returns, no prefix    |

There is no separate payment id: the deposit digest is the deposit id.

```go
domain, _ := NewEscrowDomain(PassphraseTestnet, MustParseAddress("C...")) // the deployed escrow
id, err := ComputeDepositHash(params, domain)
```

Notes:

- Amounts are `*big.Int` holding a non-negative i128, encoded as 16 little-endian bytes.
- `reserver`, `releaser` and the delegate signer are raw 32-byte keys (`Pubkey`), not addresses.
  Depositor, token and settler are `Address` values (`G...` or `C...`; muxed and claimable-balance
  addresses are rejected, as the contract does).
- The destination enters as `keccak256(destination)`; `ComputeDepositHash` takes the plaintext.
- `issued_at` and `deadline` must also be compared to the latest closed ledger's close time, not the
  local clock; only the span (at most 24 hours) is checked here.
- Shared vectors live in `contracts/stellar/conformance/`; see `contracts/encoding-parity.md`.
