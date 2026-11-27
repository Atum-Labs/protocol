# Turnkey Signer (Go)

Signing helper for the consuming service. Calls Turnkey to produce signed
Base ERC-20 rUSD transfers. The Turnkey-side policy is the security
authority; as defense-in-depth this package also rejects any recipient
other than the configured `AllowedRecipient` (the custody address)
before signing.

## Usage

The signer is constructed from the injected Turnkey credentials (see
[Credentials](#credentials)) and exposes `SignRusdTransfer(...)` to sign an
ERC-20 rUSD transfer. Callers broadcast the returned signed transaction.

## KeyBackend (escrow witness signing)

`NewKeyBackend` builds a signing backend for the verifier that satisfies
the `SigningKeyBackend` and `TypedDataSigner` interfaces:

- `eip155:*` and `tron:*` keys sign only through `SignTypedData`, sent as a
  `PAYLOAD_ENCODING_EIP712` activity so the sub-org policy can bind the
  witness type, the escrow domain and the releaser. `Sign` refuses them with
  `ErrDigestSigningRefused`.
- `solana:*` keys sign a 32-byte digest as a raw ed25519 payload.
- Every signature is checked against the configured public key before it is
  returned, and secp256k1 signatures come back low-s with v in {27, 28}.
- `ResolveWallet` checks the credential and that it is not a root user, then
  returns one signing account per address format (Ethereum, Tron, Solana) from
  a wallet: the one named, or the organization's oldest wallet when none is.
  Each format takes the wallet's oldest account of it, so adding a wallet or an
  account later never changes which key signs. It wraps `ErrCredentialRejected`
  on a definitive answer (a 4xx other than 408 or 429, a foreign organization,
  a root credential, a named wallet the organization does not hold), so a
  caller can refuse to start on a bad configuration without refusing to start
  during a Turnkey outage.

The policy set for this backend is `type: verifier` in
`../typescript/scripts/config/`; see `../typescript/scripts/PROVISIONING.md`.

## Operational provisioning

Using the signer in an environment requires one-time Turnkey and secret
provisioning that lives outside this repo.

### Sub-organizations

Two Turnkey sub-organizations under the root org:

| Sub-org | Environment |
| --- | --- |
| mainnet | production Base |
| testnet | Base Sepolia |

### API user policy

A single Automation API user is created under each sub-org. The policy
attached to that user MUST allow only:

- ERC-20 `transfer(address,uint256)` calls on the rUSD-Base token
  contract.
- Destination = the allowlisted custody address for the
  environment.
- Per-transaction cap = `max_rebalance_amount` from the liquidity
  manager config.
- Daily volume cap = `daily_volume_cap` from the consuming service
  config.

The policy MUST deny:

- Arbitrary contract calls (any selector other than ERC-20 transfer).
- Arbitrary destinations (only the configured custody address).
- `EXPORT_PRIVATE_KEY`, `EXPORT_WALLET`, `EXPORT_WALLET_ACCOUNT`.
- Policy updates by the Automation user itself.
- User administration by the Automation user (create / delete / role
  change).

### Credentials

The Turnkey API public/private keypair is stored in a secret manager and
injected into the consuming service at runtime via the following
environment variables:

| Secret | Env var |
| --- | --- |
| API public key | `TURNKEY_API_PUBLIC_KEY` |
| API private key | `TURNKEY_API_PRIVATE_KEY` |
| Organization ID | `TURNKEY_ORG_ID` |
| Wallet address | `TURNKEY_SIGN_WITH` |

Access to these secrets is scoped to the consuming service workload
identity only.

### Break-glass quorum

Policy changes, key rotation, or sub-org configuration changes require a
quorum approval through Turnkey's UI from a configured set of
administrators. The quorum is configured on the sub-org's Recovery /
Admin user set.
