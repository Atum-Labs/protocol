# Contributing Guidelines

## Code Style

| Language   | Convention                                                                    |
| ---------- | ----------------------------------------------------------------------------- |
| Rust       | Modules split by concern; instructions in `programs/<name>/src/instructions/` |
| TypeScript | 2-space indent, semicolons, camelCase                                         |
| Tests      | snake_case with numeric prefix (e.g., `03_deposit_lifecycle.ts`)              |

Run `pnpm lint:fix` before committing.

## Commits

**Format:** Short, lowercase, imperative mood (max 72 chars)

| Good                            | Bad                       |
| ------------------------------- | ------------------------- |
| `add replay protection`         | `Added replay protection` |
| `fix ATA validation in release` | `Fixed stuff`             |
| `scope deposits to authority`   | `WIP`                     |

One concern per commit: feature, fix, refactor, docs, or test.

## Pull Requests

**Checklist:**

- [ ] Tests pass (`anchor test`)
- [ ] Code formatted (`pnpm lint`)
- [ ] Commits focused and well-described
- [ ] Documentation updated if needed

## Testing

| Requirement   | Guideline                                  |
| ------------- | ------------------------------------------ |
| New features  | Happy path + error conditions + edge cases |
| Bug fixes     | Regression test that fails before fix      |
| New test file | Use next available numeric prefix          |

## Security Review Checklist

- [ ] Signature verification uses correct message format
- [ ] Replay protection tested
- [ ] Account constraints complete
- [ ] Token accounts use canonical ATAs

## Program IDs

| Program           | ID                                             |
| ----------------- | ---------------------------------------------- |
| Escrow            | `F9mjwmRfYWVUJPwSm3ygG7c9Pq2JF2eqpHC6MpVffV85` |
| Fulfillment Proxy | `679cgQsBfvGLbeJutpRmJvEZtx5pWsXxwN6cGJggMjSx` |

## Key Constants

| Program           | Constant          | Value |
| ----------------- | ----------------- | ----- |
| Escrow            | Replay horizon    | 128s  |
| Escrow            | Valid nonce slots | < 235 |
| Fulfillment Proxy | Replay horizon    | 128s  |
| Fulfillment Proxy | Valid nonce slots | < 235 |

Ed25519 signature instruction must immediately precede target instruction.

## Related Documentation

- [Development Setup](setup.md)
- [Testing Guide](testing.md)
- [Security Model](../architecture/security.md)
