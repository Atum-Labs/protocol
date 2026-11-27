# v5 Solana escrow IDL

The Anchor IDL of the v5 escrow program: `deposit` takes `destination_hash: [u8; 32]`, and every
signed instruction verifies the readable text of its hash (`escrow-text-v1`). v5 deploys at a new
program id beside v4 (`../../../../../deploy/README.md`, "v5 escrow ... deploy checklist").

Consumers build v5 instructions from this file, not from `src/generated/escrow.json`, so a later
source change can't rewrite how a live v5 escrow is called. `src/idl-history.test.ts` pins its
sha256, and until v5 deploys also checks it equals `src/generated/escrow.json`. Once v5 is
deployed, a change to its interface ships as a new program and a new registry version.
