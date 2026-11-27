# In-place Solana program upgrades

Use this procedure to upgrade an escrow or fulfillment proxy while retaining its program ID and
compatible accounts. Rehearse the exact release and client combination on a non-production cluster
before scheduling an upgrade.

If the release changes stored account layouts incompatibly, use a reviewed migration or the
[fresh-program-ID deployment procedure](../../../deploy/README.md). An in-place binary upgrade
does not migrate accounts.

## Prepare a release-specific plan

Record the target cluster, program IDs, old and new source revisions, toolchain, executable hashes,
IDLs and compatible client versions. Verify these against the selected release and the chain;
a deployment record alone does not establish what is running.

Review the following before choosing an in-place upgrade:

- Compare stored account fields and sizes, PDA derivation, instruction account lists, signature
  preimages and error codes for the two revisions.
- Identify every client using either program, including clients sharing a program across
  environments. Confirm capabilities, not only version labels or configuration values.
- A client for the per-settler strict-fulfillment layout must derive
  `[b"strict_fulfilled", quote_hash, settler]` and supply the additional read-only
  `legacy_strict_fulfillment` account at `[b"strict_fulfilled", quote_hash]`. A marker-mode
  setting cannot add these capabilities to a client that lacks them.
- Confirm release/refund clients supply the accounts required by the target IDL, including
  `memo_program` where required.
- If replay epoch units or marker layouts change, review both directions of the transition.
  Determine the drain interval from authorization validity, replay retention and clock assumptions
  for those revisions. Stop new issuance before draining; a fixed sleep without those conditions
  is insufficient.
- Decide how old and new clients will switch while traffic is held, and how each will switch back.
  Include every consumer of the affected program.
- Complete the release's required audit and approval, and agree on the maintenance window.

Read the [escrow state](../../programs/escrow/src/state.rs),
[proxy state](../../programs/fulfillment_proxy/src/state.rs) and
[replay implementation](../../crates/replay/src/check.rs) for the selected revision.

## Check access and prepare artifacts

Identify the actual fee payer, upgrade authority, buffer authority, pauser, protocol administrator
and IDL authority. Read the program and config accounts rather than assuming one signer holds every
role. If an authority is a multisig, use its reviewed proposal and signing process. Changing upgrade
authority does not also change IDL authority.

Build reproducible artifacts for the exact target IDs and toolchain. Review how `declare_id!` and
the generated IDLs receive those IDs. A binary with a different declared program ID can deploy but
then reject instructions, including pause and unpause.

Record each executable's byte length and SHA-256, and have an independent build reproduce it.
Keep a verified previous executable and compatible clients ready for rollback.

Run the commands below from `contracts/svm/source` in a shell dedicated to one target cluster.
Set `RPC_URL`, `PROGRAM_ID`, `ARTIFACT`, `IDL_FILE`, `PAYER_KEYPAIR`,
`UPGRADE_AUTHORITY_KEYPAIR`, `BUFFER_AUTHORITY_KEYPAIR`, `BUFFER_KEYPAIR` and
`IDL_AUTHORITY_KEYPAIR` to the reviewed values. These are separate roles even when one signer
happens to hold several. Do not print an RPC URL that contains credentials.

Set `OTHER_PROGRAM_ID` to the other program's ID when checking a two-program release. Set
`ADDITIONAL_BYTES`, `PRIORITY_FEE` and `ATTEMPTS` from the approved capacity/upload plan, and
`AFTER_DUMP` to the local path for post-upgrade evidence. Record `BUFFER_ID` and `BUFFER_DUMP`
after staging; do not mix those values between targets.

The examples use the Solana 2.3 and Anchor 0.32 command forms. Check the installed versions' help
and complete the rehearsal before signing an upgrade.

### Check the embedded program ID

Pass other program IDs from the release as additional arguments; the artifact must contain its own
ID exactly once and none of those alternatives. This byte check complements the reviewed build and
IDL checks; it does not establish the provenance of an arbitrary executable.

```bash
python3 -I - "$ARTIFACT" "$PROGRAM_ID" ${OTHER_PROGRAM_ID:+"$OTHER_PROGRAM_ID"} <<'PY'
import pathlib
import sys

alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(value):
    number = 0
    for character in value:
        number = number * 58 + alphabet.index(character)
    return number.to_bytes(32, 'big')

artifact = pathlib.Path(sys.argv[1]).read_bytes()
target = b58(sys.argv[2])
others = [b58(value) for value in sys.argv[3:]]
if artifact.count(target) != 1 or any(artifact.count(value) for value in others):
    raise SystemExit('program ID verification failed')
print('program ID verified')
PY
```

Assert that the IDL names the same target:

```bash
python3 -I -c "import json,sys; sys.exit(json.load(open(sys.argv[1]))['address'] != sys.argv[2])" "$IDL_FILE" "$PROGRAM_ID"
```

### Compare dumped bytes with the reviewed executable

Define this function in the operator shell. It returns nonzero on a mismatch. The commands below
chain each check with `&&`, so a failed check skips the signing command and the operator shell,
with its variables, stays open.

```bash
verify_dump() {
  python3 -I - "$1" "$2" <<'PY'
import pathlib
import sys

expected = pathlib.Path(sys.argv[1]).read_bytes()
actual = pathlib.Path(sys.argv[2]).read_bytes()
if not expected or actual[:len(expected)] != expected or any(actual[len(expected):]):
    raise SystemExit('artifact verification failed')
print('artifact verified')
PY
}
```

A program or buffer dump can have zero padding beyond the executable. Compare using the reviewed
executable's length; do not trim trailing zeros, since an ELF may itself end in zero bytes.
Only the reviewed executable and zero padding are permitted.

## Snapshot and stage before pausing

### Record the current state

```bash
solana program show "$PROGRAM_ID" --url "$RPC_URL"
solana program dump "$PROGRAM_ID" before-program.so --url "$RPC_URL"
shasum -a 256 before-program.so
python3 ../deploy/read-protocol-config.py --program "$PROGRAM_ID" --url "$RPC_URL" --field size
```

Preserve the deployment slot, authorities, executable identity and config values needed for later
comparison. Read each field separately. Escrow fields include `default_admin`, `pauser`, `paused`,
`treasurer`, `token_config_authority`, `signature_domain_version` and `cluster_id`; proxy fields
include `default_admin`, `pauser`, `paused`, `enforce_settler_allowlist` and
`authorized_settlers`. The config reader rejects unsupported lengths and fields; the two layouts
are different.

Keep the full dump as evidence. Record and verify the previous executable's actual length and bytes
before using it as a rollback artifact; a padded dump's full length is not its executable length.

### Check capacity

Compare the new executable's length with the program's data capacity. If extension is needed,
calculate the additional bytes and rent for this release and approve the headroom first.

```bash
wc -c "$ARTIFACT"
solana program show "$PROGRAM_ID" --url "$RPC_URL"
solana rent "$ADDITIONAL_BYTES" --url "$RPC_URL"
```

Extension cannot be undone. Check the cluster's authority requirements and confirm the resulting
capacity during rehearsal; do not infer one cluster's behavior from another.

Only after the headroom is approved, extend the program:

```bash
solana program extend "$PROGRAM_ID" "$ADDITIONAL_BYTES" --keypair "$PAYER_KEYPAIR" --url "$RPC_URL"
```

### Upload and verify a buffer

Retain the buffer keypair so an interrupted upload can resume into the same buffer. Choose a
priority fee and attempt limit appropriate to the target cluster.

```bash
solana program write-buffer "$ARTIFACT" \
  --keypair "$PAYER_KEYPAIR" --fee-payer "$PAYER_KEYPAIR" \
  --buffer "$BUFFER_KEYPAIR" --buffer-authority "$BUFFER_AUTHORITY_KEYPAIR" \
  --use-rpc --with-compute-unit-price "$PRIORITY_FEE" --max-sign-attempts "$ATTEMPTS" --url "$RPC_URL"
```

An interrupted upload can be resumed with the same artifact, buffer and authorities after checking
the upload result. Do not create another buffer merely because confirmation is uncertain.

Confirm the buffer address and authority. If its authority must change, complete the reviewed
handoff before verifying its bytes. Keep the buffer under the reviewed authority and prevent
concurrent writes after verification.

```bash
solana program dump "$BUFFER_ID" "$BUFFER_DUMP" --url "$RPC_URL" &&
  verify_dump "$ARTIFACT" "$BUFFER_DUMP"
```

Set `BUFFER_ID` and `BUFFER_DUMP` to the recorded address and local evidence path first.
A failed dump skips the comparison, even if an older file exists at that path; do not continue
until this chain succeeds. Re-run this
comparison immediately before the upgrade and after any intervening buffer write or authority
change. It verifies a read snapshot, not an atomic on-chain commitment to the later upgrade.

Stage and verify rollback buffers before the pause. Do not run a bulk buffer-close operation while
forward or rollback buffers are needed; identify any abandoned buffer separately before cleanup.

## Hold traffic, drain and upgrade

1. Hold new traffic and authorization issuance for every affected consumer.
2. Pause the required programs using their actual pauser. Read back `paused` before proceeding.
   Pausing escrow blocks release and refund as well as deposit/reserve, so prepare artifacts and
   client changes beforehand and minimize its pause interval.
3. Complete the reviewed release-specific drain interval. A replay-format transition must account
   for authorizations issued before the pause in both forward and rollback directions; for a
   slice-length change, follow [Upgrading from 128-second slices](../architecture/replay-protection.md#upgrading-from-128-second-slices).
4. Recheck the selected buffer's authority and bytes, then upgrade one program at a time.

```bash
solana program dump "$BUFFER_ID" "$BUFFER_DUMP" --url "$RPC_URL" &&
  verify_dump "$ARTIFACT" "$BUFFER_DUMP" &&
  solana program upgrade "$BUFFER_ID" "$PROGRAM_ID" \
    --upgrade-authority "$UPGRADE_AUTHORITY_KEYPAIR" --keypair "$PAYER_KEYPAIR" --url "$RPC_URL"
```

The upgrade runs only if the dump and comparison succeed. If either fails, the chain stops before
signing; resolve the failure and re-run the whole chain.

Record the transaction signature and confirm its result. Do not assume that an interrupted CLI
command means the transaction was never submitted, or blindly sign another upgrade.

## Verify before reopening

Read back the program's deployment slot and bytes, and compare with the reviewed artifact.
An RPC read can lag even after transaction confirmation. Use bounded read-only retries against the
intended cluster and confirm the deployment slot's freshness; never repeat the signing operation
just to obtain a newer read.

```bash
verify_live_program() {
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if solana program dump "$PROGRAM_ID" "$AFTER_DUMP" --url "$RPC_URL" &&
       verify_dump "$ARTIFACT" "$AFTER_DUMP"; then
      return 0
    fi
    if [ "$attempt" -lt 10 ]; then sleep 6; fi
  done
  echo 'Program verification pending; hold traffic and reconcile the confirmed upgrade.' >&2
  return 1
}
solana program show "$PROGRAM_ID" --url "$RPC_URL"
verify_live_program
```

`solana program show` is informational; `verify_live_program` is the gate. If it returns nonzero,
do not upload the IDL or unpause.

If verification remains unavailable or mismatching after the bounded read retries, keep traffic held
and reconcile the confirmed transaction, target, deployment slot and fresh program data. A failed
check after an upgrade does not mean the old program is still running. Do not automatically roll back
based on a single stale read. Follow the reviewed recovery plan for a confirmed mismatch.

Compare protocol config values and account layouts with the snapshot. Verify the IDL address again,
then upload it with the actual IDL authority:

```bash
anchor idl upgrade "$PROGRAM_ID" --filepath "$IDL_FILE" \
  --provider.cluster "$RPC_URL" --provider.wallet "$IDL_AUTHORITY_KEYPAIR"
```

Switch every affected client to the compatible account layout and marker derivation while traffic
is still held. Unpause the required programs and run a controlled canary through each distinct
consumer path: deposit, reserve, release/refund and strict fulfill as applicable. Those operations
require unpaused programs. Reopen traffic only after they pass, and record the final revision,
executable hashes, deployment slots, IDLs and client versions.

## Rollback constraints

A binary rollback does not undo state written by the newer program. Before approving rollback,
check whether the old program can interpret every account, replay epoch and fulfillment marker
created since the upgrade. If it cannot, keep affected operations disabled until the reviewed
migration or reconciliation is complete. A plain binary revert is insufficient.

- **Replay buckets.** A slice-length change wipes buckets in both directions: the older build reads
  epochs written in 256-second units as 128-second units, just as the newer build reads the old
  ones. Pause first and wait at least 256 seconds before the rollback upgrade as well, as described
  in [Upgrading from 128-second slices](../architecture/replay-protection.md#upgrading-from-128-second-slices).
- **Strict-fulfillment markers.** The per-settler build writes its marker at
  `[b"strict_fulfilled", quote_hash, settler]`; the older build checks only
  `[b"strict_fulfilled", quote_hash]`, which is empty for any quote strict-fulfilled after the
  upgrade, so the same settler could pay that quote again. Before unpausing a rolled-back proxy,
  either keep it paused until every quote strict-fulfilled since the upgrade slot is terminal
  (released, refunded or expired), or have settlers refuse the quote hashes recorded in
  `StrictFulfilled` events since the upgrade slot. Switch clients back to the legacy marker
  derivation while the proxy is still paused.

Keep the verified rollback buffers ready. Hold traffic, pause the affected programs, complete the
rollback drain interval, reverify the selected rollback buffer and upgrade to it. Reconcile transaction
confirmation and read freshness just as for a forward upgrade. Switch clients back in the coordinated
order and verify compatible state before unpausing. Do not finalize an upgrade authority as part of
this procedure; making a program immutable is a separate irreversible decision.
