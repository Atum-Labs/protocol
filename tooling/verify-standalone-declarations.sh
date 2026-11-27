#!/usr/bin/env bash
#
# Install schemas/declarations the way a consumer does and run the scripts a consumer's task
# runner would select on it.
#
# Consumers vendor this repo as a git submodule, and they reach this package differently.
# settler-agent is the workspace consumer: its `pnpm-workspace.yaml` lists
# `protocol/schemas/declarations`, so its recursive task runner selects the package by name.
# It lists some of this tree's siblings too (`.../PaymentRequest/v1/bindings/typescript/
# sender-auth`), but not all of them, and which ones is its choice, not ours. atum-core is not
# a workspace consumer at all: its npm `workspaces` is only `["tests/e2e"]`, it reaches the
# package through tsconfig `paths` (`tests/e2e/tsconfig.json`), and its one pnpm run against
# protocol, `build-ts-bindings`, filters this package out (`Makefile`) -- so today no script on
# it is exposed there.
#
# Inside THIS repo the package sits next to every sibling package pnpm-workspace.yaml globs
# (ld-signing, ld-data-integrity, sender-auth, ...), so a script on schemas/declarations that
# reaches into a sibling's sources resolves the sibling's dependencies through the workspace
# and passes CI here. In a consumer that did not also install that sibling, those dependencies
# were never installed, and the same script fails on first run. protocol#231 shipped exactly
# that: a `test` script whose suite imported bs58 and tweetnacl through the FulfillmentQuote
# signing package, which turned settler-agent's `turbo test` red the moment it repinned
# (CORE-2968). This is the check that would have caught it.
#
# The one-member workspace below is deliberately stricter than any consumer's: it holds no
# matter which siblings a consumer happens to list, so it does not go stale when one changes.
#
# The copy is built from what git tracks (plus untracked, non-ignored files, so a working tree
# can be checked before committing): no node_modules, no dist/, which is also what a submodule
# checkout holds. It becomes the only member of a throwaway pnpm workspace with no lockfile, as
# a consumer that resolves the package's ranges fresh would see it, and the scripts below run
# against it with `pnpm -r run`, which is how a consumer's recursive task runner selects them.
#
# Usage: tooling/verify-standalone-declarations.sh

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

PKG="schemas/declarations"

# The script names a consumer's recursive task runner invokes on every workspace member it
# finds. settler-agent, the workspace consumer, runs `turbo lint format:check typecheck` (plus
# `turbo build`) across its workspace, and `turbo test` -- today with
# `--filter=!@atum-labs/schema-declarations`, added in settler-agent#354 to keep protocol#231's
# suite out of its pipeline, so `test` is the one name it does not currently select here. That
# filter is a workaround, not a contract: once this package stops shipping a `test` script that
# needs siblings, settler drops the filter and `test` is selected again. So the list is what a
# consumer *can* select, not only what one selects today. A script under any of these names is
# executed by a consumer without the consumer ever choosing to; anything the package wants to
# run only inside this repo belongs under a name that is NOT in this list (for example
# `test:declarations`), invoked explicitly from ci.yml.
CONSUMER_SCRIPTS=(build lint typecheck format:check test)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"

# `--cached --others --exclude-standard`: tracked files plus untracked ones that are not
# ignored, read from the working tree. That mirrors what a submodule checkout contains and
# still lets this run on uncommitted changes.
git ls-files -z --cached --others --exclude-standard -- "$PKG" \
  | tar --null -T - -cf - \
  | tar -xf - -C "$CONSUMER"

printf "packages:\n  - '%s'\n" "$PKG" > "$CONSUMER/pnpm-workspace.yaml"
printf '{ "name": "verify-standalone-declarations", "private": true }\n' > "$CONSUMER/package.json"

cd "$CONSUMER"

echo "::group::install $PKG as the only workspace member"
# No lockfile on purpose: a consumer resolves this package's ranges inside its own lockfile,
# never ours. --prefer-offline reuses the pnpm store the main install already filled.
#
# --ignore-scripts: pnpm 10 fails an install in a workspace that has not approved the build
# scripts of its dependencies (ERR_PNPM_IGNORED_BUILDS), and a throwaway workspace has
# approved nothing. Those build scripts belong to transitive dependencies of the generator
# and are not what this check is about: with them skipped the packages are still installed
# and resolvable, which is what the scripts below exercise. The package's own lifecycle
# scripts are skipped too; it has none.
pnpm install --prefer-offline --ignore-scripts
echo "::endgroup::"

# Which of the consumer-selected names the package actually exposes. Listed up front so the
# log says what was exercised; a name the package does not expose is a pass, not a skip to
# worry about.
EXPOSED=()
for s in "${CONSUMER_SCRIPTS[@]}"; do
  if node -e 'process.exit(((require(process.argv[1]).scripts || {})[process.argv[2]] !== undefined) ? 0 : 1)' \
      "$CONSUMER/$PKG/package.json" "$s"; then
    EXPOSED+=("$s")
  fi
done

if [ "${#EXPOSED[@]}" -eq 0 ]; then
  echo "$PKG exposes none of: ${CONSUMER_SCRIPTS[*]}"
  echo "OK"
  exit 0
fi

echo "$PKG exposes, of the names consumers run: ${EXPOSED[*]}"

FAILED=()
for s in "${EXPOSED[@]}"; do
  echo "::group::pnpm -r run $s"
  if ! pnpm -r run "$s"; then
    FAILED+=("$s")
  fi
  echo "::endgroup::"
done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo
  echo "FAIL: these $PKG scripts do not run when the package is installed alone: ${FAILED[*]}"
  echo
  echo "  A consumer whose workspace lists only $PKG runs them by name and gets this failure."
  echo "  Either the script needs something only this repo's workspace provides (a sibling"
  echo "  package's dependency reached through a relative import), or the package's own"
  echo "  dependencies are missing. Move the script to a name consumers do not select, or"
  echo "  declare what it needs on $PKG itself."
  exit 1
fi

echo "OK"
