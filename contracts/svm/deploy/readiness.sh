#!/usr/bin/env bash
# v4 SVM (Solana) readiness check. READ-ONLY — deploys nothing.
#
#   readiness.sh                          # devnet
#   CLUSTER=mainnet-beta readiness.sh
#   ESC=<id> FP=<id> readiness.sh         # inspect a DIFFERENT pair (e.g. post-cutover)
#
# Reports, per gate, whether the cluster can take a v4 deployment today.
#
# Runs from anywhere: the on-chain checks need only `curl`/`python3`, and the two
# source-tree checks are SKIPPED with a clear marker when no checkout is reachable,
# rather than aborting. So a copy of this file alone is useful.
#
# NOTE the gate COUNT is calibrated for an in-place upgrade and overstates a fresh-program-ID
# deploy: "deployer key present locally" asserts the local key equals the EXISTING authority, and
# "old-shape DepositInfo drained" only matters if the old accounts must be readable by the new
# program. Neither applies on the fresh-ID route. Use this for facts, not for a verdict.
set -uo pipefail
# Resolve through symlinks so this works when invoked from a PATH symlink: BASH_SOURCE points
# at the LINK, and the files that ship beside this script (derive.py, ../source) live next to the
# TARGET. Without this, a global install silently loses them.
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
: "${CLUSTER:=devnet}"
# Normalise the alias ONCE, here, rather than in each case statement. "mainnet" was
# accepted by the EXPECT_PAYER case below but rejected by the URL case, so
# CLUSTER=mainnet got as far as picking a mainnet payer policy and then died with
# "CLUSTER must be devnet|testnet|mainnet-beta" -- an argument that half worked.
# `solana` itself accepts both spellings, so refusing one is our own inconsistency.
case "$CLUSTER" in
  mainnet|mainnet-beta) CLUSTER=mainnet-beta ;;
  dev|devnet)           CLUSTER=devnet ;;
  test|testnet)         CLUSTER=testnet ;;
  *) echo "CLUSTER must be devnet|testnet|mainnet (mainnet-beta accepted); got '$CLUSTER'" >&2; exit 1 ;;
esac

# Find a source checkout if one is reachable; otherwise carry on without it.
is_src() { [ -f "$1/Anchor.toml" ] && [ -d "$1/programs" ]; }
if [ -z "${SRC_DIR:-}" ]; then
  # cwd FIRST: if you are standing in a source tree, you mean that one. Putting the script's own
  # sibling ahead of it made the repo copy and a PATH symlink give opposite verdicts from the same
  # directory — the sibling won for one and the cwd for the other.
  for c in "$(pwd)" "$HERE/../source" "$HERE/../../svm/source"; do
    is_src "$c" && { SRC_DIR="$(cd "$c" && pwd)"; break; }
  done
  if [ -z "${SRC_DIR:-}" ]; then
    d="$(pwd)"
    while [ "$d" != "/" ]; do
      is_src "$d/contracts/svm/source" && { SRC_DIR="$d/contracts/svm/source"; break; }
      d="$(dirname "$d")"
    done
  fi
fi
SRC_DIR="${SRC_DIR:-}"

# The pair to INSPECT: the v4 programs in ../deployments-v4.json (mainnet-beta pair, else devnet pair).
case "$CLUSTER" in
  mainnet-beta)
    : "${ESC:=5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx}"
    : "${FP:=CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ}" ;;
  *)
    : "${ESC:=2MHznjRgbc4AbXkYaq69CiL4ZmnvBShg8QmyLxniwMkf}"
    : "${FP:=FGMSseEvfdXHWnYwDcSyCorqJr3pT83zuasdy8ve8KmS}" ;;
esac

# The program keypairs for v4 (Step 2c of the guide), custodied under $ATUM_HOME/keys/.
# These are what target/deploy must contain — not whatever anchor build fabricated.
# Per cluster, because devnet and mainnet deliberately differ. These were ONE global
# pair defaulting to the devnet ids, so a mainnet run was measured against devnet's
# programs and reported a mismatch that looked like a missing keypair rather than a
# category error.
#
# devnet already runs v4 at 2MHznjRg… / FGMSseEv… -- verified live on chain, loader-
# owned, executable, with an initialised 636-byte proxy protocol_config. Their
# keypairs are custodied elsewhere, which is fine: upgrades are signed by the
# AUTHORITY (6jbdyQZc…), not by the program keypair.
#
# mainnet gets a fresh pair, generated deliberately into $ATUM_HOME/keys/svm-mainnet-programs/
# rather than fabricated by `anchor build` into the gitignored target/deploy/.
case "$CLUSTER" in
  mainnet-beta)
    : "${EXPECT_ESCROW_KP:=5BD9UAUCRCg6Chv6CS5k4sBHGd7CciWpng9u7iJxJFjx}"
    : "${EXPECT_FP_KP:=CMxMPzpmeJPJbyUK4DDSDEhEYdCCAUt7w5cr5SWEHoNJ}" ;;
  *)
    : "${EXPECT_ESCROW_KP:=2MHznjRgbc4AbXkYaq69CiL4ZmnvBShg8QmyLxniwMkf}"
    : "${EXPECT_FP_KP:=FGMSseEvfdXHWnYwDcSyCorqJr3pT83zuasdy8ve8KmS}" ;;
esac

# The INTENDED deployer/payer (Step 2a): the seed's m/44'/501'/0'/0'. This is the account that pays
# the deploy and therefore becomes the new upgrade authority, so it is what must be funded — and the
# keypair that will sign must resolve to it. Override with EXPECT_PAYER.
# Per-cluster, because checking the devnet payer during a mainnet run is a false verdict rather
# than a check. Solana is ed25519, so there is no derivation from the secp256k1 deployer.
# The deploy payer per cluster, which is also the v4 programs' upgrade authority
# (contracts/svm/deployments-v4.json). Override with EXPECT_PAYER to check a different account.
case "$CLUSTER" in
  mainnet-beta) : "${EXPECT_PAYER:=FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW}" ;;
  *)            : "${EXPECT_PAYER:=6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS}" ;;
esac
# Upgrade authority of the served v4 programs, per contracts/svm/deployments-v4.json.
DEV_AUTH=6jbdyQZcMm8AsgpNCQnEKHNzb2fqbV84JqeAabUqQ1bS
MAIN_AUTH=FVt14Ru5WvzRgy64qDBxCSPf815wUnrSsR4p58eaitBW

# SOLANA_RPC_URL wins when set: mainnet through the public endpoint is rate-limited
# and cannot carry a program deploy reliably, so an operator will be on a provider.
case "$CLUSTER" in
  devnet)       URL=${SOLANA_RPC_URL:-https://api.devnet.solana.com};       AUTH=$DEV_AUTH ;;
  mainnet-beta) URL=${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}; AUTH=$MAIN_AUTH ;;
  testnet)      URL=${SOLANA_RPC_URL:-https://api.testnet.solana.com};      AUTH=$DEV_AUTH ;;
esac

# A supplied endpoint that CONTRADICTS the cluster is the worst case: the header
# would say mainnet-beta while every read went to devnet. svm.env ships a devnet
# SOLANA_RPC_URL, so this is reachable by simply sourcing it and passing
# CLUSTER=mainnet-beta. Refuse when the URL names a different cluster; accept a
# private provider (which names none) but say it could not be confirmed.
if [ -n "${SOLANA_RPC_URL:-}" ]; then
  case "$SOLANA_RPC_URL" in
    *devnet*)       URL_CLUSTER=devnet ;;
    *testnet*)      URL_CLUSTER=testnet ;;
    *mainnet*)      URL_CLUSTER=mainnet-beta ;;
    *)              URL_CLUSTER=unknown ;;
  esac
  if [ "$URL_CLUSTER" != unknown ] && [ "$URL_CLUSTER" != "$CLUSTER" ]; then
    echo "REFUSING: CLUSTER=$CLUSTER but SOLANA_RPC_URL names $URL_CLUSTER" >&2
    echo "  $SOLANA_RPC_URL" >&2
    echo "  Every check below would read $URL_CLUSTER while the report said $CLUSTER." >&2
    echo "  Unset SOLANA_RPC_URL to use the public endpoint for $CLUSTER, or point it at $CLUSTER." >&2
    exit 2
  fi
  [ "$URL_CLUSTER" = unknown ] && RPC_NOTE="  (private endpoint; cluster not confirmable from the URL)"
fi

: "${ROUTE:=fresh-id}"
# Which PHASE is being scored. Some constraints bind at the config FLIP rather than
# at the deploy, and scoring them as deploy blockers made the tool disagree with its
# own comments -- see the open-deposits gate. PHASE=flip scores them as blockers.
: "${PHASE:=deploy}"
case "$PHASE" in deploy|flip) ;; *) echo "PHASE must be deploy|flip; got '$PHASE'" >&2; exit 1 ;; esac      # fresh-id | in-place
case "$ROUTE" in fresh-id|in-place) ;; *) echo "ROUTE must be fresh-id|in-place" >&2; exit 1;; esac

# Gates you have consciously decided are not your problem. Comma-separated substrings matched
# against a slug of the gate label, e.g.:
#   SKIP_GATES=old-deposits atum-svm-readiness
#   SKIP_GATES=old-deposits,upgrade-authority atum-svm-readiness
# A suppressed gate is still PRINTED, as `skip`, with the reason — it is never silently dropped,
# because a report that hides what it did not check is worse than one that blocks.
: "${SKIP_GATES:=}"
_slug() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//'; }
_suppressed() {
  [ -n "$SKIP_GATES" ] || return 1
  local sl; sl="$(_slug "$1")"
  local IFS=','
  for pat in $SKIP_GATES; do
    pat="$(_slug "$pat")"
    [ -n "$pat" ] || continue
    case "$sl" in *"$pat"*) return 0 ;; esac
  done
  return 1
}

FAIL=0
SKIPPED=0
gate() {
  if _suppressed "$2"; then
    printf '  \033[35mskip\033[0m %-34s %s\n' "$2" "suppressed via SKIP_GATES (was: $1)"
    SKIPPED=$((SKIPPED+1)); return
  fi
  if [ "$1" = ok ]; then printf '  \033[32mPASS\033[0m %-34s %s\n' "$2" "$3"
  else printf '  \033[31mBLOCK\033[0m %-34s %s\n' "$2" "$3"; FAIL=$((FAIL+1)); fi
}
# A gate that only matters for an in-place upgrade. Reported, never counted, on the fresh-id route.
# Adversarially verified 2026-08-24: no CPI into the old program, no program id in any PDA seed, so a
# fresh id yields a disjoint PDA namespace and the old program's state cannot gate a new deployment.
ip_gate() { if [ "$ROUTE" = in-place ]; then gate "$@"
            else printf '  \033[36minfo\033[0m %-34s %s\n' "$2" "$3 [in-place only]"; fi; }

echo "cluster : $CLUSTER  ($URL)${RPC_NOTE:-}"
echo "expected upgrade authority: $AUTH"
echo

# 1. is the authority even signable?
python3 - "$AUTH" <<'PY' > /tmp/_oncurve
import sys
B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n=0
for c in sys.argv[1]: n=n*58+B58.index(c)
pk=n.to_bytes(32,'big'); p=2**255-19
y=int.from_bytes(pk,'little')&((1<<255)-1)
ok=False
if y<p:
    d=(-121665*pow(121666,p-2,p))%p
    u=(y*y-1)%p; v=(d*y*y+1)%p
    xx=(u*pow(v,p-2,p))%p
    x=pow(xx,(p+3)//8,p)
    if (x*x-xx)%p!=0: x=(x*pow(2,(p-1)//4,p))%p
    ok=((x*x-xx)%p==0)
print("oncurve" if ok else "offcurve")
PY
CURVE=$(cat /tmp/_oncurve)
# Route-aware, as the "holds existing upgrade authority" gate below already is, and
# as the "old authority balance" line further down already says in words. On the
# fresh-id route the INCUMBENT authority governs programs we are not touching: new
# programs get whatever authority we set. Blocking fresh-id because mainnet's
# existing authority is a Squads PDA gated a route the fact does not apply to.
if [ "$ROUTE" = in-place ]; then
  [ "$CURVE" = oncurve ] && gate ok "authority is a real keypair" "$CURVE" \
    || gate no "authority is a real keypair" \
       "OFF-CURVE (PDA/Squads) — no private key exists; an in-place upgrade must go via Squads"
else
  if [ "$CURVE" = oncurve ]; then
    printf '  \033[36minfo\033[0m %-34s %s\n' "incumbent authority" \
      "$AUTH — on-curve; not a gate on the fresh-ID route"
  else
    printf '  \033[36minfo\033[0m %-34s %s\n' "incumbent authority" \
      "$AUTH — OFF-CURVE (PDA/Squads); not a gate on the fresh-ID route, but the NEW programs' authority is whatever you set, so decide it deliberately"
  fi
fi

# 2. do we hold it?
LOCAL=$(solana-keygen pubkey ~/.config/solana/id.json 2>/dev/null || echo none)
if [ "$ROUTE" = in-place ]; then
  [ "$LOCAL" = "$AUTH" ] && gate ok "holds existing upgrade authority" "$LOCAL" \
    || gate no "holds existing upgrade authority" "local id.json is $LOCAL, need $AUTH"
else
  # On the fresh-id route the BPF loader does not need the old authority — but deploy.ts does.
  # Verified 2026-08-24: ESCROW_PROGRAM_ID / FULFILLMENT_PROXY_PROGRAM_ID are `const` at
  # deploy.ts:46-53 with no env override, so step 3 sends initializeProtocol to the OLD program and
  # derives programData from the OLD id; on-chain verify_upgrade_authority (protocol.rs:93-126) then
  # requires the OLD authority to sign. Also deploy.ts:435-456 verifies the OLD ids, so it reports a
  # FALSE GREEN. Until those constants are repointed, deploy.ts cannot perform a fresh-id deploy.
  # With no checkout the grep fails, the condition is false, and the else branch below
  # reported "no stale hardcoded id found" -- a PASS asserted from a file that was never
  # read. Every other source-dependent gate in this file prints SKIPPED instead.
  if [ ! -f "${SRC_DIR:-/nonexistent}/scripts/deploy.ts" ]; then
    printf '  \033[33m--\033[0m   %-34s %s\n' "deploy.ts targets the new ids" \
      "SKIPPED — no source checkout (set SRC_DIR)"
  elif grep -qE 'ESCROW_PROGRAM_ID[^=]*=[^=]*new PublicKey' "$SRC_DIR/scripts/deploy.ts" 2>/dev/null \
     && ! grep -q "$EXPECT_ESCROW_KP" "$SRC_DIR/scripts/deploy.ts" 2>/dev/null; then
    gate no "deploy.ts targets the new ids" "deploy.ts:46-53 still hardcodes the OLD program ids — initializeProtocol would hit the old program and demand its authority ($AUTH); verifyDeployment is a false green"
  else
    gate ok "deploy.ts targets the new ids" "no stale hardcoded id found"
  fi
fi

# 3. what version is live?
anchor idl fetch "$ESC" --provider.cluster "$CLUSTER" >/tmp/_idl.json 2>/dev/null
if [ -s /tmp/_idl.json ]; then
  V=$(python3 -c "
import json;d=json.load(open('/tmp/_idl.json'))
ins={i['name']:[a['name'] for a in i.get('args',[])] for i in d.get('instructions',[])}
dep=ins.get('deposit',[])
print('v4' if 'deposit_request_hash' in dep or 'destination' in dep else ('v3' if 'quote_hash' in str(d) else 'V1'))")
  [ "$V" = v4 ] && ip_gate ok "live program version" "$V" || ip_gate no "live program version" "$V — v4 needs new PDAs; layouts are not in-place migratable"
else ip_gate no "live program version" "could not fetch IDL"; fi

# 4. live ProtocolConfig size vs what v4 needs
SIZES=$(python3 - "$URL" "$FP" <<'PY'
import json,urllib.request,base64,sys
req=urllib.request.Request(sys.argv[1],data=json.dumps({"jsonrpc":"2.0","id":1,"method":"getProgramAccounts",
  "params":[sys.argv[2],{"encoding":"base64"}]}).encode(),headers={"Content-Type":"application/json"})
try:
    r=json.load(urllib.request.urlopen(req,timeout=30)).get("result",[])
    s={}
    for a in r: n=len(base64.b64decode(a["account"]["data"][0])); s[n]=s.get(n,0)+1
    print(json.dumps(s))
except Exception as e: print("{}")
PY
)
echo "$SIZES" | grep -q '"636"' \
  && ip_gate ok "fulfillment_proxy ProtocolConfig" "636 B present (v4 layout)" \
  || ip_gate no "fulfillment_proxy ProtocolConfig" "sizes=$SIZES — v4 needs 636 B; no realloc/close exists by design"

# 5. open old-shape deposits (must be drained)
OPEN=$(python3 - "$URL" "$ESC" <<'PY'
import json,urllib.request,base64,sys
req=urllib.request.Request(sys.argv[1],data=json.dumps({"jsonrpc":"2.0","id":1,"method":"getProgramAccounts",
  "params":[sys.argv[2],{"encoding":"base64"}]}).encode(),headers={"Content-Type":"application/json"})
try:
    r=json.load(urllib.request.urlopen(req,timeout=30)).get("result",[])
    s={}
    for a in r: n=len(base64.b64decode(a["account"]["data"][0])); s[n]=s.get(n,0)+1
    print(sum(v for k,v in s.items() if k in (217,249)))
except Exception: print("?")
PY
)
if [ "$OPEN" = "0" ]; then gate ok "old-shape DepositInfo drained" "0 open"
elif [ "$ROUTE" = in-place ]; then
  gate no "old-shape DepositInfo drained" "$OPEN open at 217/249 B — FATAL for in-place; unreadable by a 313-B program"
else
  # Verified 2026-08-24: the deploy itself strands nothing (disjoint PDAs, old binary keeps its own
  # crate::ID and domain version 2). What blocks is OFF-CHAIN: veri-fill keys ONE (cluster_id,
  # version) off the CAIP-2 chain id (signature.go:632-646) with no per-deposit or per-program
  # override, so it cannot serve the old and new domains at once. Settle these BEFORE the flip.
  # This gate used to block the DEPLOY, which contradicts the comment directly above
  # it: the deploy strands nothing, and what cannot serve two domains at once is
  # veri-fill, off-chain, at the moment the config flips. Blocking the deploy for it
  # conflated two phases and made the only remaining mainnet blocker a condition the
  # deploy does not create.
  #
  # So: a warning at PHASE=deploy, a hard block at PHASE=flip. It stays VISIBLE
  # either way -- the open count is real and settling it is still required before the
  # flip; what changed is which phase it stops.
  if [ "$PHASE" = flip ]; then
    gate no "old deposits settled pre-flip" "$OPEN open — veri-fill cannot hold two domains per chain; settle or abandon BEFORE this flip"
  else
    printf '  \033[33mwarn\033[0m %-34s %s\n' "old deposits settled pre-flip" \
      "$OPEN open — does NOT block the deploy (disjoint PDAs; the old binary keeps its own crate::ID and domain version). MUST be settled before the config flip: re-run with PHASE=flip to score it as a blocker"
  fi
fi

# 6. funding — of the account that ACTUALLY PAYS.
# On the fresh-program-ID route the payer is whoever holds the new program keypair and signs the
# deploy; that payer becomes the new upgrade authority. The OLD authority ($AUTH) is never involved,
# so measuring its balance is a false green. Default to the local id.json, which is what
# `anchor deploy` / deploy.ts use unless DEPLOYER_KEYPAIR overrides it.
# deploy.ts defaults the payer to <repo>/.anchor/deployer.json (deploy.ts:38-41), NOT
# ~/.config/solana/id.json. Mirror that order or the gate measures a key the deploy never uses.
# Resolution order mirrors what will actually sign: an explicit DEPLOYER_KEYPAIR, then deploy.ts's
# own default, then what `atum-svm-import-deployer --write` produces, then the solana CLI default.
PAYER_KP=""
for c in "${DEPLOYER_KEYPAIR:-}" \
         "${SRC_DIR:+$SRC_DIR/.anchor/deployer.json}" \
         "$HOME/.atum-svm-deployer.json" \
         "$HOME/.config/solana/id.json"; do
  [ -n "$c" ] && [ -f "$c" ] && { PAYER_KP="$c"; break; }
done
if [ -n "$PAYER_KP" ]; then
  PAYER_HELD=$(solana-keygen pubkey "$PAYER_KP" 2>/dev/null || echo unreadable)
else
  PAYER_HELD=none
fi
# Does a signable keypair for the intended payer actually exist here?
if [ -z "$EXPECT_PAYER" ]; then
  # No expected payer defined for this cluster. Do not compare against nothing: an empty
  # expectation makes every held key "wrong" and prints "the intended payer is " with a blank.
  if [ "$PAYER_HELD" = none ]; then
    gate no "payer keypair present" "no keypair found, and no expected payer is defined for cluster '$CLUSTER' — decide which key pays, then import it"
  else
    gate no "payer keypair present" "holding $PAYER_HELD, but no expected payer is defined for cluster '$CLUSTER' — set EXPECT_PAYER to assert it deliberately"
  fi
elif [ "$PAYER_HELD" = "$EXPECT_PAYER" ]; then
  gate ok "payer keypair present" "$EXPECT_PAYER  ($PAYER_KP)"
elif [ "$PAYER_HELD" = none ]; then
  gate no "payer keypair present" "no keypair found — run: DERIVATION_PATH=\"m/44'/501'/0'/0'\" atum-svm-import-deployer --write"
else
  gate no "payer keypair present" "found $PAYER_HELD at $PAYER_KP, but the intended payer is $EXPECT_PAYER"
fi
# Fund the INTENDED payer — that is the account that will pay, whether or not a key is here yet.
PAYER="$EXPECT_PAYER"
BAL=$(solana balance "$PAYER" --url "$URL" 2>/dev/null | awk '{print $1}')
# Mainnet wants retry headroom; a testnet does not, because a shortfall there is an
# airdrop away. NEED_SOL overrides either, and is the same variable deploy.sh reads.
# 6.0 on mainnet: above the 5.73 measured for both programs plus IDLs, so this is
# still a real check, and the current 7.0187 SOL balance clears it.
#
# It is NOT 12.0, which would cover a full retry's stranded write buffer. That was
# considered and deliberately rejected: `solana program deploy --buffer <keypair>`
# RESUMES a failed upload into the same buffer rather than paying rent for a new
# one, so a retry costs no additional SOL provided the deploy is run that way. The
# guide's mainnet procedure requires it. If you deploy WITHOUT an explicit buffer,
# a mid-upload failure strands ~3.45 SOL and 6.0 is not enough to start again --
# reclaim it with `solana program close --buffers` before retrying.
case "$CLUSTER" in
  mainnet-beta) : "${NEED_SOL:=6.0}" ;;
  *)            : "${NEED_SOL:=7.0}" ;;
esac
python3 - "${BAL:-0}" "$NEED_SOL" <<'PY' > /tmp/_fund
import sys
# MEASURED on the real devnet deploy 2026-08-24, not estimated. `anchor deploy` does NOT pass
# --max-len, so ProgramData is allocated at exactly the .so size, not 2x it:
#   escrow.so           495,536 B -> ProgramData 495,536 B -> 3.45 SOL rent
#   fulfillment_proxy.so 307,920 B -> ProgramData 307,920 B -> 2.14 SOL rent
# Observed total spend for both, including the two IDL accounts and fees: 5.73 SOL
# (payer 13.998 -> 8.269). A margin over that covers the transient write buffer.
# Earlier figures here were wrong in both directions: 7.8 was a guess, and 13.4 came from a
# "ProgramData is 2x the .so" claim that the on-chain Data Length disproves.
# Per cluster, and overridable, matching deploy.sh's NEED_SOL -- this was hardcoded
# to 7.0 while deploy.sh already honoured NEED_SOL, so the gate and the driver could
# disagree about whether the same balance was sufficient.
#
# 7.0 is right for a testnet, where a shortfall is one airdrop away. It is NOT right
# for mainnet: a failed upload strands its write buffer (~3.45 SOL for the escrow),
# which leaves ~3.5 of a 7 SOL balance -- short of the 5.59 a retry needs -- and
# there is no airdrop. The buffer is reclaimable via `solana program close --buffers`,
# so this is a stall rather than a loss, but the gate should not call 7.0 ready on
# mainnet and let the operator discover that mid-deploy.
b=float(sys.argv[1] or 0)
need=float(sys.argv[2])
print(("ok" if b>=need else "no")+f" {b:.4f} SOL (need ~{need} SOL; measured 5.73 for both programs + IDLs)")
PY
if [ -z "$PAYER" ]; then
  # `solana balance ""` yields nothing, which became 0.0000 and printed as though a
  # broke account had been measured. Nothing was measured; say so.
  gate no "payer funded" "cannot check — no payer address to measure (see the gate above)"
else
  read -r FS FM < <(sed 's/^\([a-z]*\) /\1 /' /tmp/_fund)
  gate "$FS" "payer funded" "$PAYER — $(cut -d' ' -f2- /tmp/_fund)"
fi
# The old authority's balance is reported for information only; it does not gate this route.
OLDBAL=$(solana balance "$AUTH" --url "$URL" 2>/dev/null | awk '{print $1}')
printf '  \033[36minfo\033[0m %-34s %s\n' "old authority balance" "$AUTH — ${OLDBAL:-?} SOL (not a gate on the fresh-ID route)"

# 6b. the program keypairs themselves — the single most common way this goes wrong.
# anchor build FABRICATES a random keypair for any program missing one, anchor deploy takes the
# address from that file (not Anchor.toml), and with SKIP_REVOKE_AUTHORITY unset the run then
# --finals it. Absent keypairs therefore mean deploying immutable programs at unprovisioned ids.
if [ -n "$SRC_DIR" ]; then
  for pair in "escrow:$EXPECT_ESCROW_KP" "fulfillment_proxy:$EXPECT_FP_KP"; do
    nm=${pair%%:*}; want=${pair#*:}
    kp="$SRC_DIR/target/deploy/$nm-keypair.json"
    if [ ! -f "$kp" ]; then
      gate no "$nm keypair present" "ABSENT — anchor build will fabricate a random id"
    else
      got=$(solana-keygen pubkey "$kp" 2>/dev/null || echo unreadable)
      [ "$got" = "$want" ] && gate ok "$nm keypair present" "$got" \
        || gate no "$nm keypair matches" "$got != provisioned $want"
    fi
  done
else
  printf '  \033[33m--\033[0m   %-34s %s\n' "program keypairs" "SKIPPED — no source checkout (set SRC_DIR)"
fi

# 6c. declare_id! must equal the id being deployed at.
#
# Nothing checked this, and it is the one mismatch that bricks a deployment at a
# permanent address: a program deployed at X whose own declare_id!(Y) derives every
# PDA and the signature domain from Y. `derive.py --check` does NOT cover it -- it
# compares declare_id! against PROGRAM_ID_BYTES, i.e. internal consistency, so with
# both still holding the retired v1/v3 id it reports "already in sync". A green that
# says nothing about whether the id is the right one.
#
# Step 2c is where these get propagated; this gate is what makes forgetting it loud.
if [ -n "$SRC_DIR" ]; then
  for pair in "escrow:$EXPECT_ESCROW_KP" "fulfillment_proxy:$EXPECT_FP_KP"; do
    nm=${pair%%:*}; want=${pair#*:}
    lib="$SRC_DIR/programs/$nm/src/lib.rs"
    if [ ! -f "$lib" ]; then
      gate no "$nm declare_id!" "$lib not found"
      continue
    fi
    got=$(sed -nE 's/^[[:space:]]*declare_id!\("([^"]+)"\).*/\1/p' "$lib" | head -1)
    if [ -z "$got" ]; then
      gate no "$nm declare_id!" "no declare_id! found in ${lib#$SRC_DIR/}"
    elif [ "$got" = "$want" ]; then
      gate ok "$nm declare_id!" "$got"
    else
      gate no "$nm declare_id!" "${lib#$SRC_DIR/} says $got, deploying at $want — every PDA and the signature domain would derive from the WRONG id (Step 2c)"
    fi
  done
else
  # No checkout reachable. Without this the gate vanished from the report entirely --
  # neither passed nor mentioned -- while every sibling source-dependent gate says SKIPPED.
  printf '  \033[33m--\033[0m   %-34s %s\n' "declare_id! matches" "SKIPPED — no source checkout (set SRC_DIR)"
fi

# 6c. Revocation is now opt-IN: deploy.ts revokes only when REVOKE_UPGRADE_AUTHORITY lowercases to
# "true", so an unset environment retains the upgrade authority. SKIP_REVOKE_AUTHORITY is obsolete
# and deploy.ts refuses on any presence of it, so flag it here rather than letting the operator
# discover it after `anchor deploy` has already spent SOL.
if [ -n "${SKIP_REVOKE_AUTHORITY+x}" ]; then
  gate no "no obsolete revoke variable" "SKIP_REVOKE_AUTHORITY is set — deploy.ts refuses on it; remove it from the environment"
elif [ "$(printf '%s' "${REVOKE_UPGRADE_AUTHORITY:-}" | tr A-Z a-z)" = true ]; then
  gate no "upgrade authority retained" "REVOKE_UPGRADE_AUTHORITY=true — deploy.ts WILL run set-upgrade-authority --final on BOTH programs, permanently"
else
  gate ok "upgrade authority retained" "REVOKE_UPGRADE_AUTHORITY unset — the default"
fi

# 7. tooling gaps (static, cluster-independent)
if [ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ]; then
  grep -rq 'add_authorized_settler' "$SRC_DIR/scripts" 2>/dev/null \
    && gate ok "settler-allowlist tooling" "present" \
    || gate no "settler-allowlist tooling" "only in tests/ — the settler allowlist cannot be provisioned"
  grep -rqiE 'AddressLookupTable|createLookupTable' "$SRC_DIR/scripts" 2>/dev/null \
    && gate ok "ALT tooling" "present" \
    || gate no "ALT tooling" "none — required by the v4 plaintext-destination sizing, not optional"
else
  # No checkout reachable. Say so instead of reporting a result we did not measure.
  printf '  \033[33m--\033[0m   %-34s %s\n' "settler-allowlist tooling" "SKIPPED — no source checkout found (set SRC_DIR)"
  printf '  \033[33m--\033[0m   %-34s %s\n' "ALT tooling" "SKIPPED — no source checkout found (set SRC_DIR)"
fi

echo
echo "route: $ROUTE   phase: $PHASE   (ROUTE=in-place / PHASE=flip to score those gates instead)"
[ "$SKIPPED" -gt 0 ] && echo "NOTE  $SKIPPED gate(s) suppressed via SKIP_GATES='$SKIP_GATES' — not measured, not counted"
if [ $FAIL -eq 0 ]; then
  [ "$SKIPPED" -gt 0 ] && echo "READY, except for what you suppressed" || echo "READY"
else
  echo "NOT DEPLOYABLE — $FAIL gate(s) blocking on the $ROUTE route"
fi
exit "$FAIL"
