# Contract version registry

Every escrow version a service may trust, one file per chain in `chains/`, named by the CAIP-2
chain id with `:` written as `_` (for example `chains/eip155_4217.json`, `chains/tron_mainnet.json`).

`chains/` is generated, never edited by hand. Addresses live only in the deployments files, and
`versions.json` says which deployments files are versions and with which signature domain. After
editing either, run `go run ./cmd/gen-chains` here.

A version is one immutable escrow with its fulfillment proxies, Permit2 and signature domain. Its id
(`v4`, `v5`) is the deployments file it was recorded in, unique within a chain. Versions are only ever
added: a payment is released and refunded on the escrow it was created on for life.

## Rules

- An address is trusted only if a registry version lists it.
- Every address comes from the deployments file the version cites (`source`). A trusted proxy no
  deployments file holds is listed in `versions.json` under `unrecordedFulfillmentProxies` with the
  reason.
- Every chain in a deployments file `versions.json` lists gets that version.
- `published.txt` lists every version ever published. A published version is never removed and its
  escrow and signature domain never change, even when its deployments file is edited in place: a new contract is a new
  version. CI fails a pull request that drops or changes a line of the base branch's `published.txt`
  (`check-published.sh`).
- A Stellar version's `stellarDomainVersion` is one byte (1 to 255), the version every Stellar escrow
  digest commits to. Stellar's deployments file keys chains by full CAIP-2 id, and a chain it records
  as `"deployed": false` is not a version.
- A Solana version's `svmDomainVersion` is one byte (1 to 255). `svmMessage` is the form its signers
  sign; empty (the only accepted value today) is the raw 32 byte hash.
- Chain ids are looked up regardless of case (two chain files may not differ only in case). Escrow
  and proxy addresses fold case on EVM only; Tron, Solana and Stellar addresses match exactly.
- Only versions some service trusts today are listed. Older deployments files (v1 to v3) are not.
- Each environment chooses the versions new payments may name with an id list per chain in its
  own config (`chain=id[,id];chain=id`). The list doesn't pick a default: each service keeps its
  configured escrow as the default. `ParseEnvList` and
  `CheckEnvList` read and check that list (`CheckEnvList` is case sensitive), and `Allowed` returns
  the listed versions of one chain. `VersionOfEscrow` finds the version of an escrow address.

## Use

Go: `github.com/atum-labs/protocol/contracts/registry`, which embeds the files.
TypeScript: `@atum-labs/contract-registry` in `typescript/`, which bundles the files.
Anyone else: read the JSON files in this directory at the protocol commit you pin.

`go test ./...` here checks every rule above. Both readers rebuild `published.txt` from `chains/`.
