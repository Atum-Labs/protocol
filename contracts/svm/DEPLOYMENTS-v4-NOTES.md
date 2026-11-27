# Solana v4 deployment record: notes

Notes for `deployments-v4.json`. They live here because that file is a machine-readable registry:
every top-level key must be a cluster, and a loader that reads it into a per-cluster map rejects
the whole file on any other key.

## Status

v4 is the served Solana escrow deployment on devnet and mainnet. Both programs on each cluster run
`signature_domain_version` 5.

| Cluster | Escrow | FulfillmentProxy |
|---|---|---|
| devnet | `2MHznjRgbc4AbXkYaq69CiL4ZmnvBShg8QmyLxniwMkf` | `FGMSseEvfdXHWnYwDcSyCorqJr3pT83zuasdy8ve8KmS` |
| mainnet | `5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx` | `CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ` |

The ids differ per cluster because each cluster was deployed from its own program keypairs.
Solana testnet has no v4 deployment.

The pre-v4 program pair (`44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs` /
`77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe`) is recorded in `deployments-v1.json` and
`deployments-v3.json`. It is not the served deployment and does not verify v4 signatures.

## Verifying a cluster

Check the chain, not this file:

```sh
solana program show <program id> --url <cluster endpoint>
```

Both programs on each cluster are loader-owned and executable, and have an initialised
`protocol_config`:

| Cluster | Program | Data length | Upgrade authority |
|---|---|---|---|
| devnet | escrow | 495536 B | `6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS` |
| devnet | fulfillment_proxy | 307920 B | `6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS` |
| mainnet | escrow | 495536 B | `FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW` |
| mainnet | fulfillment_proxy | 307920 B | `FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW` |

Equal data lengths on both clusters mean the same build. The fulfillment_proxy `protocol_config`
is 636 bytes (the v4 layout); the escrow `protocol_config` is 216 bytes.
