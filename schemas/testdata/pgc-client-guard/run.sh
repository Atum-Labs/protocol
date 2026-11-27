#!/usr/bin/env bash
# Self-test for the check-pgc-openapi-client guard in schemas/Makefile.
#
# Why this exists: the bug this guard was fixed for was not "the guard was missing".
# It was "the guard was GREEN when it should have been RED", for months, and nobody
# noticed -- because a silently-passing gate looks exactly like a passing one. It
# named 3 of the 13 files the generator emits, so a hand-edit to any of the other 10
# sailed through. Nothing would have caught a repeat of that, so: this.
#
# The guard compares a committed tree against a fresh generate. PGC_OPENAPI_CLIENT_PATHS
# selects the tree, so each case points it at a scratch copy and mutates that copy --
# the real src/generated is never touched.
#
# Each case asserts the exit code AND a substring of the output. Exit code alone is not
# enough: a guard mutated to reject everything would satisfy every failing case while
# being completely broken, which is the same class of silent wrongness being guarded.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCHEMAS=${SCHEMAS_DIR:-$(cd "$HERE/../.." && pwd)}
GENERATED=${PGC_GENERATED_TREE:-$(cd "$SCHEMAS/apis/payment-gateway/v1/bindings/typescript/client/src/generated" && pwd)}
# Exported by the calling recipe so the sub-make is the same make, and MAKEFLAGS is
# cleared so a parent -j / -k / variable override cannot reach it.
# Without set -e, a failed `cd` in the substitution above leaves GENERATED as the empty
# string -- which set -u does not catch, because it IS assigned. `cp -R "$GENERATED/."`
# would then expand to `cp -R "/."` and start copying the filesystem root into a temp
# directory this script also rm -rf's. Cheap to make unambiguous.
[ -d "$GENERATED" ] || { echo "generated tree not found: ${GENERATED:-<empty>}" >&2; exit 1; }

MAKE=${MAKE:-make}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pgc-client-guard.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

fail=0
run_case() {
  local name=$1 expect=$2 needle=$3 mutate=$4
  local tree="$WORK/$name"
  mkdir -p "$tree"
  cp -R "$GENERATED/." "$tree/"
  ( cd "$tree" && eval "$mutate" )

  local out status
  out=$(cd "$SCHEMAS" && MAKEFLAGS= $MAKE check-pgc-openapi-client \
          PGC_OPENAPI_CLIENT_PATHS="$tree" 2>&1)
  status=$?

  local ok=1
  if [ "$expect" = pass ]; then
    [ $status -eq 0 ] || ok=0
  else
    [ $status -ne 0 ] || ok=0
  fi
  grep -qF "$needle" <<<"$out" || ok=0

  if [ $ok -eq 1 ]; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s (expected %s, exit %d, looking for %q)\n' "$name" "$expect" "$status" "$needle"
    sed 's/^/      /' <<<"$out"
    fail=1
  fi
}

echo "Self-testing the payment-gateway client drift guard..."

# An untouched copy must pass, or every failing case below proves nothing.
run_case unmodified        pass 'is up to date'    'true'
# The original bug: a hand-edit outside the three *.gen.ts files.
run_case edited-core       fail 'is out of date'   "echo '// hand edit' >> core/request.ts"
run_case edited-gen        fail 'is out of date'   "echo '// hand edit' >> types.gen.ts"
# The hole the file-list version could never see: hand-written code added to the
# generated tree. openapi-ts overwrites the files it emits and leaves the rest alone,
# so this file survives every regeneration, identical to the index and untracked by
# nothing -- invisible to a git-based check.
run_case added-toplevel    fail 'is out of date'   "echo 'export const x = 1;' > helpers.ts"
run_case added-in-core     fail 'is out of date'   "echo 'export const x = 1;' > core/stray.ts"
# A file the generator has stopped emitting, or that someone deleted by hand.
run_case deleted-toplevel  fail 'is out of date'   'rm index.ts'
run_case deleted-in-core   fail 'is out of date'   'rm core/ApiError.ts'

if [ $fail -ne 0 ]; then
  echo "❌ the drift guard did not behave as specified"
  exit 1
fi
echo "✅ the drift guard fails on every kind of drift, and passes on none"
