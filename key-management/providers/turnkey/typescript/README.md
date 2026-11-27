# @atum-labs/turnkey-signer

Turnkey-backed `Signer` implementation for EVM, Solana, Stellar, and Tron, plus admin tooling for
provisioning sub-organizations, users, and server-side signing policies. Implements the shared
signer interface from [`@atum-labs/km-core`](../../../common/typescript).

Install chain SDKs as needed — they are optional peer dependencies:

- EVM: `ethers`
- Solana: `@solana/web3.js`, `bs58`
- Stellar: `@stellar/stellar-sdk` (>= 17)
- Tron: `ethers`

Import per chain so an EVM-only consumer does not pull the Solana SDK:

```ts
import { TurnkeyEvmSigner } from '@atum-labs/turnkey-signer/evm';
```

Subpath entry points: `.` (full barrel), `./evm`, `./solana`, `./stellar`, `./tron`, `./client`, `./admin`.
`TurnkeyStellarSigner` is on the `./stellar` subpath only, not the root barrel, so the root keeps
loading where `@stellar/stellar-sdk` is not installed.

### Stellar

Turnkey documents the Stellar account format (`ADDRESS_FORMAT_XLM`, `CURVE_ED25519`, default path
`m/44'/148'/0'/0'/0`) and curve-level raw payload signing, and does **not** document Stellar
transaction parsing (no `TRANSACTION_TYPE_STELLAR`, no `stellar.tx` policy namespace); checked
2026-11-10. `TurnkeyStellarSigner` therefore signs the 32-byte transaction hash (which binds
the network passphrase) as a raw ed25519 payload with `HASH_FUNCTION_NOT_APPLICABLE`, and verifies
the result locally against the hash and the account's public key. Consequence: Turnkey policy can
fence the activity, encoding, hash function and wallet account, but not what is signed. The
settler's client-side `PolicyCheckedSigner` is the only thing that inspects a Stellar transaction,
and the Stellar key should hold only what its role needs. Not live-verified: no Stellar signature has
been requested from Turnkey by this code (see `scripts/PROVISIONING.md`, "Stellar").

Each signer exposes `signMessage`, `signTransaction`/`sendTransaction`, `signPreimage`, and — on
EVM and Tron — `signTypedData(domain, types, message)` for EIP-712/TIP-712.

`signTypedData` sends the struct as `PAYLOAD_ENCODING_EIP712`, so Turnkey parses it server-side
and its policy engine can read `eth.eip_712.domain.*` and `eth.eip_712.message['field']`. The
signature is identical to one over the collapsed digest, so this is a policy capability rather
than a wire change: a `HEXADECIMAL` payload would be an opaque blob no field-level policy can
bind. `signMessage` / `signPreimage` are the `HASH_FUNCTION_KECCAK256` paths, for EIP-191 /
TIP-191. Every policy set denies KECCAK256, so every non-transaction secp256k1 signature goes
through `signTypedData`.

Logger and metrics meter are injectable via client options and default to no-ops; no logging or
telemetry dependency is imposed on consumers.

## Admin

`@atum-labs/turnkey-signer/admin` derives and applies Turnkey server-side policies for settler,
sender and verifier sub-organizations (`derivePoliciesFromAllowlist`,
`buildSettlerRawPayloadPolicies`, `buildSenderPolicies`, `buildVerifierPolicies`, `applyPolicies`,
`listPolicies`) and manages users, sub-organizations, and wallets.

## Go

A self-contained Go Turnkey signer lives at [`../go`](../go).
