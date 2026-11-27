#!/usr/bin/env bash
# Fails when a line of published.txt at <base-ref> is missing from the working copy, so a published
# version can't be removed or repointed by editing the chain files and published.txt together.
# Usage: check-published.sh <base-ref>
set -euo pipefail
base_ref="${1:?usage: check-published.sh <base-ref>}"
path=contracts/registry/published.txt
cd "$(git rev-parse --show-toplevel)"
git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null || { echo "::error::$base_ref is not a commit"; exit 1; }
rows() { grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' | sort -u; }
if ! base=$(git show "$base_ref:$path" 2>/dev/null); then
  echo "$path is not on $base_ref yet, nothing to compare"
  exit 0
fi
[ -f "$path" ] || { echo "::error file=$path::$path was removed"; exit 1; }
missing=$(comm -23 <(printf '%s\n' "$base" | rows) <(rows < "$path"))
if [ -n "$missing" ]; then
  echo "::error file=$path::published versions removed or changed since $base_ref (a new contract is a new version):"
  printf '%s\n' "$missing"
  exit 1
fi
echo "every published version on $base_ref is still published"
