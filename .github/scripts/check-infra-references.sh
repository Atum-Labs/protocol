#!/usr/bin/env bash
# Fail if Atum's deployment infrastructure leaks back into this repository.
#
#   .github/scripts/check-infra-references.sh [path...]
#
# WHY. The pre-publication audit (audit/pre-publication-2026-09-16.md, sections 4.2 and 12.1) found
# 22 `gcloud secrets ... --project atum-core` invocations across contracts/*/deploy/, together with
# the Secret Manager names, the GKE overlay path and its Flux behaviour, and the terraform and
# settler-agent layouts of a private repository. Individually inert; together an enumeration map of
# our infrastructure, which is why the team split them out to atum-core rather than accepting them
# for publication. An integrator needs none of it.
#
# They accumulated one convenient paste at a time, and nothing stopped that. The same decay is
# already on the record elsewhere in this tree: a CORE- key landed in the published SDK's
# docs/signing.md six days after the audit snapshot. So this is a check rather than a sweep somebody
# remembers to re-run.
#
# This is deliberately NOT part of check-process-references.sh. That guard forbids CORE-<digits>
# anywhere it looks, and the audit ACCEPTED those keys in tracked files outside .github/ and the
# published SDK -- so widening its path list would fail on content we chose to publish. Different
# rule, different paths, separate script.
#
# A guard that cannot read its input fails rather than reporting a clean tree: a missing path, or
# any scan error, exits 2. Exit 1 means the tree was read and something was found.
set -euo pipefail

TARGETS=("$@")
[ "${#TARGETS[@]}" -gt 0 ] || TARGETS=(.)
SELF_PATH=".github/scripts/check-infra-references.sh"
SELF="$(basename "$0")"
status=0

for target in "${TARGETS[@]}"; do
  if [ ! -e "$target" ]; then
    echo "$SELF: $target does not exist; nothing was scanned." >&2
    exit 2
  fi
done

# The audit report documents every pattern below, by design: it is the register that records what
# was removed and why. Excluding it by path keeps the report readable without weakening the guard
# over everything else.
EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=audit --exclude="$SELF")

# pattern|what it is, printed when it matches
CHECKS=(
  'gcloud|a gcloud invocation: how Atum reaches its own secret store'
  '--project[= ]atum-core|the GCP project id, as a gcloud argument'
  'config-gen|the atum-core service-config generator and its recipes'
  '[a-z0-9{}$_]*_rpc_url|a Secret Manager entry name for an RPC endpoint'
  'tron_api_key|the Secret Manager entry name for the TronGrid key'
  'deploy/apps/envs|the GKE overlay path, whose reconcile goes to prod unapproved'
  'terraform/environments|the terraform per-environment layout'
  'settler-agents/prod|paths inside a private repository'
  '[Cc]loud [Aa]rmor|an internal edge component, named in text that ships in a package'
)

# grep's exit status is three-valued: 0 found something, 1 read the tree and found nothing, anything
# else could not do the search. Folding that third case into "found nothing" is how a guard reports
# success on a tree it never opened, so it exits instead.
for check in "${CHECKS[@]}"; do
  pattern="${check%%|*}"
  reason="${check#*|}"
  rc=0
  hits="$(grep -rnE "${EXCLUDES[@]}" -- "$pattern" "${TARGETS[@]}")" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "$SELF: grep exited $rc scanning ${TARGETS[*]}." >&2
    exit 2
  fi
  if [ "$rc" -eq 0 ]; then
    echo "Found $reason:"
    echo "$hits"
    echo "  This belongs in atum-core. See $SELF_PATH for why, and"
    echo "  deploy/docs/runbook-contract-deploy-secrets.md there for where it went."
    echo
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "No deployment-infrastructure references under ${TARGETS[*]}."
fi
exit "$status"
