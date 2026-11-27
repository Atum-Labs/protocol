#!/usr/bin/env bash
#
# Resolve every Go module the way a consumer does and build+test it from the module cache.
#
# Every other CI lane builds from a full checkout, so each module sees the whole repo on
# disk. A consumer sees only the files inside that module's own directory. Anything a
# module reaches for outside itself -- a file two directories up, a sibling module behind
# a relative `replace` -- works in CI and fails on first use for everyone else. This lane
# is the only one that can tell the difference for files; a sibling's version is checked by the
# release gate (VERIFY_AS_TAGGED, below), because the default mode resolves siblings at HEAD.
#
# Resolution goes through a local bare mirror of this repo with a synthetic tag per module,
# reached via git's insteadOf. That is real `go get` resolution, including the
# <module-dir>/vX.Y.Z tag-prefix convention a subdirectory module is published under, so it
# also exercises the release tagging scheme. It needs no credential and no network, which
# is what lets it run before anything is published.
#
# Usage: tooling/verify-standalone-modules.sh [module-dir ...]
#        (no arguments = every module in the repo)
#
# Each module is tested against HEAD's code for its siblings: the mirror gets a throwaway commit
# on top of HEAD in which every intra-repo require names the synthetic version, and that commit is
# what gets tagged. That answers "could a release be cut from HEAD", which is what a merge needs to
# keep true. Testing against the sibling versions HEAD's go.mod files name instead fails every
# change that uses a new sibling API until the next release bumps the requires, so main would sit
# red between releases for something the release itself fixes.
#
# VERIFY_AS_TAGGED=1 skips that rewrite and resolves siblings at the versions the go.mod files
# name. Only the release gate sets it: there the requires already name the versions being tagged,
# and checking them as written is the point.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

ALLOWLIST="tooling/verify-standalone-modules.allow"

# Any valid semver works; nothing is pushed and the mirror is thrown away.
VERSION="v0.0.1"

WORK=$(mktemp -d)
trap 'chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"' EXIT

if [ -n "$(git status --porcelain)" ]; then
  echo "warning: working tree is dirty; the mirror is built from HEAD, so uncommitted changes are NOT tested" >&2
fi

MODULES=()
if [ "$#" -gt 0 ]; then
  MODULES=("$@")
else
  # `while read` rather than mapfile: macOS ships bash 3.2 and this has to run on a laptop.
  while IFS= read -r line; do MODULES+=("$line"); done < <(git ls-files 'go.mod' '*/go.mod' | xargs -n1 dirname | sort)
fi

MIRROR="$WORK/protocol.git"
git clone --quiet --bare "$REPO_ROOT" "$MIRROR"
TAG_SHA=$(git -C "$MIRROR" rev-parse HEAD)

# Every module is tagged, not only the ones under test, because any of them can be a sibling
# that a module under test requires.
ALL_MODULES=()
while IFS= read -r line; do ALL_MODULES+=("$line"); done < <(git ls-files 'go.mod' '*/go.mod' | xargs -n1 dirname | sort)

if [ "${VERIFY_AS_TAGGED:-}" != 1 ]; then
  HEADTREE="$WORK/head"
  git clone --quiet "$MIRROR" "$HEADTREE"
  PATHS=()
  for d in "${ALL_MODULES[@]}"; do
    PATHS+=("$(awk '/^module /{print $2; exit}' "$HEADTREE/$d/go.mod")")
  done
  for d in "${ALL_MODULES[@]}"; do
    ( cd "$HEADTREE/$d"
      for p in $(go mod edit -json | awk -F'"' '/^\t"Require": \[/{r=1; next} r && /^\t\]/{r=0} r && /"Path":/{print $4}'); do
        for q in "${PATHS[@]}"; do
          if [ "$p" = "$q" ]; then go mod edit -require="$p@$VERSION"; fi
        done
      done )
  done
  git -C "$HEADTREE" add -A
  # commit-tree rather than commit: no identity or hooks to configure, and --no-gpg-sign because
  # this commit only ever lives in the throwaway mirror.
  TREE=$(git -C "$HEADTREE" write-tree)
  TAG_SHA=$(GIT_AUTHOR_NAME=verify GIT_AUTHOR_EMAIL=verify@localhost GIT_COMMITTER_NAME=verify GIT_COMMITTER_EMAIL=verify@localhost \
    git -C "$HEADTREE" commit-tree --no-gpg-sign -p HEAD -m "verify: intra-repo requires at $VERSION" "$TREE")
  git -C "$HEADTREE" push --quiet origin "$TAG_SHA:refs/heads/verify-head"
  git -C "$MIRROR" symbolic-ref HEAD refs/heads/verify-head
fi

# update-ref rather than `git tag`: a lightweight ref needs no message and no signing key,
# so this works the same on a laptop with tag.gpgSign set and on a bare CI runner.
for d in "${ALL_MODULES[@]}"; do
  if [ "$d" = "." ]; then
    git -C "$MIRROR" update-ref "refs/tags/$VERSION" "$TAG_SHA"
  else
    git -C "$MIRROR" update-ref "refs/tags/$d/$VERSION" "$TAG_SHA"
  fi
done

export GOPRIVATE='github.com/atum-labs/*'
export GOFLAGS=-mod=mod
export GOMODCACHE="$WORK/gomodcache"
# Rewrite the remote through the environment instead of `git config --global`, so running
# this locally does not edit the developer's own git configuration.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.file://$MIRROR.insteadOf"
export GIT_CONFIG_VALUE_0="https://github.com/atum-labs/protocol"

# Failures are recorded by the stage they happen at, because the stages mean different things:
#
#   resolve/build -- the module is unusable for a consumer. A hard publishing blocker.
#   test          -- the module itself is fine; only its own test suite needs files from the
#                    repo (golden vectors, conformance fixtures, the vendored contract source).
#                    A consumer never runs those, so this does not block publishing -- but it
#                    is still the stage that catches a module reading a missing file at RUNTIME,
#                    which builds cleanly and fails on first use. Not downgradable to a warning.
# Warm the shared cache with every third-party dependency FIRST, where the relative `replace`
# directives still apply. Without this the isolation loop fetches them from the public proxy
# 36 times over, and a single DNS blip reads as "this module is broken" -- the lane then
# flakes, and a gate that flakes gets ignored.
#
# Warm up in a throwaway checkout, never in REPO_ROOT: `go mod download all` writes go.sum,
# and a verification script must not leave the tree it is verifying modified.
echo "::group::warm the module cache"
WARM="$WORK/warm"
git clone --quiet "$MIRROR" "$WARM"
for d in "${MODULES[@]}"; do
  # Fail fast rather than warn. Every module builds in-tree in the other lanes, so warm-up
  # failing here always means infrastructure. Carrying on would hand the module to the loop
  # with an empty cache under GOPROXY=off, where it fails as "cannot be resolved" -- exactly
  # the mislabel GOPROXY=off exists to prevent.
  if ! ( cd "$WARM/$d" && go mod download all ); then
    echo "error: warm-up failed for $d (network or proxy, not a module defect)" >&2
    exit 2
  fi
done
echo "::endgroup::"

# From here the only fetch allowed is the local mirror, which GOPRIVATE routes through git
# rather than the proxy. Anything else must already be cached, so a network fault surfaces as
# an unambiguous "module lookup disabled" instead of masquerading as a broken module.
export GOPROXY=off

# Each allowlist line is "<stage> <module-dir>", where stage is the WORST stage that module
# is known to reach: resolve or test. Carrying the stage is what stops a module allowed for
# a harmless test-fixture failure from silently degrading into an unresolvable one -- the two
# are listed in the same file but mean completely different things.
ALLOWED=()
if [ -f "$ALLOWLIST" ]; then
  while IFS= read -r line; do ALLOWED+=("$line"); done < <(grep -vE '^[[:space:]]*(#|$)' "$ALLOWLIST" || true)
fi

# bash 3.2 has no associative arrays, so the lines are scanned. Prints the allowed stage for
# a module, or nothing if it is not listed.
allowed_stage() {
  local needle="$1" a
  for a in ${ALLOWED[@]+"${ALLOWED[@]}"}; do
    if [ "${a#* }" = "$needle" ]; then
      echo "${a%% *}"
      return
    fi
  done
}

describe() {
  case "$1" in
    ok)      echo "resolves, builds and tests cleanly" ;;
    resolve) echo "cannot be resolved or built by a consumer" ;;
    test)    echo "resolves and builds, but its own tests do not run standalone" ;;
  esac
}

N_OK=0; N_RESOLVE=0; N_TEST=0
MISMATCH=()

for d in "${MODULES[@]}"; do
  modpath=$(awk '/^module /{print $2; exit}' "$REPO_ROOT/$d/go.mod")
  echo "::group::$d"

  consumer="$WORK/consumer/$(echo "$d" | tr '/' '_')"
  mkdir -p "$consumer"
  stage=ok
  (
    cd "$consumer"
    go mod init verify/consumer >/dev/null 2>&1
    go get "$modpath@$VERSION" && go build "$modpath/..."
  ) || stage=resolve
  if [ "$stage" = ok ]; then
    ( cd "$consumer" && go test "$modpath/..." ) || stage=test
  fi

  case "$stage" in
    ok)      N_OK=$((N_OK + 1)) ;;
    resolve) N_RESOLVE=$((N_RESOLVE + 1)) ;;
    test)    N_TEST=$((N_TEST + 1)) ;;
  esac
  echo "  -> $(describe "$stage")"

  # An exact stage match in both directions. A module that gets worse fails the lane, and so
  # does one that gets better, because a stale entry is how an allowlist rots into a blanket
  # exemption.
  expected=$(allowed_stage "$d")
  [ -n "$expected" ] || expected=ok
  if [ "$stage" != "$expected" ]; then
    MISMATCH+=("$d|$expected|$stage")
  fi

  echo "::endgroup::"
done

# A listed module that no longer exists is never exercised by the loop, so it would otherwise
# sit in the file forever. Only meaningful on a full run; with arguments, most modules are
# legitimately absent.
STALE=()
if [ "$#" -eq 0 ]; then
  for a in ${ALLOWED[@]+"${ALLOWED[@]}"}; do
    entry="${a#* }"
    [ -f "$REPO_ROOT/$entry/go.mod" ] || STALE+=("$entry")
  done
fi

echo
echo "of ${#MODULES[@]} modules: $N_OK clean, $N_RESOLVE unresolvable, $N_TEST resolve but cannot self-test"

status=0

if [ "${#MISMATCH[@]}" -gt 0 ]; then
  status=1
  echo
  echo "FAIL: these modules do not match $ALLOWLIST:"
  for m in "${MISMATCH[@]}"; do
    d="${m%%|*}"; rest="${m#*|}"; exp="${rest%%|*}"; act="${rest##*|}"
    echo
    echo "  $d"
    echo "    expected: $(describe "$exp")"
    echo "    actual:   $(describe "$act")"
    case "$act" in
      resolve)
        echo "    The module requires something it cannot fetch -- usually a sibling module at a"
        echo "    placeholder version behind a relative 'replace'. A dependency's replace directives"
        echo "    are ignored; only the main module's apply."
        ;;
      test)
        echo "    The module itself is fine for a consumer. Its tests read a file from outside the"
        echo "    module directory -- a golden vector, a conformance fixture, the vendored source."
        ;;
      ok)
        echo "    It passes now. Drop its line from $ALLOWLIST."
        ;;
    esac
  done
fi

if [ "${#STALE[@]}" -gt 0 ]; then
  status=1
  echo
  echo "FAIL: $ALLOWLIST lists modules that no longer exist:"
  printf '  %s\n' "${STALE[@]}"
  echo "They were moved or deleted. Drop or repoint the lines."
fi

if [ "$status" -eq 0 ]; then
  echo "OK"
fi
exit "$status"
