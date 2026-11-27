# @atum-labs/km-core

The shared key-management signer interface — no logic, just the vocabulary providers and consumers
agree on:

- `Signer<T>` and the chain primitive/identity types.
- `SigningPolicy` and its zod schema `ZSigningPolicy` (allowlists and caps for signing).
- The error taxonomy: `RetryableError`, `NonRetryableError`, `BaseError`, `SignerErrorCode`, and the
  `signerRetryable` / `signerTerminal` helpers.

Provider packages (e.g. `@atum-labs/turnkey-signer`) depend on this package so the shared classes
and codes resolve to a single definition.
