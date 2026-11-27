#!/usr/bin/env bash
# Fail if a surface this repository publishes leaks internal process into it.
#
#   .github/scripts/check-process-references.sh [path...]
#
# WHY. Once this repository is public, every workflow, script and template under .github/ is
# read by people who cannot open our issue tracker. A comment that cites one of our issue
# identifiers points them at a door they cannot open and tells them we have one. Rationale
# belongs in the comment itself, so the check refuses any identifier of the form CORE-<digits>.
#
# The same argument covers the published SDK, which ships further than this repository does: its
# `files` array puts src-derived output and docs/ inside a tarball on npm, and the package's own
# AGENTS.md already rules out code-review references there. That surface re-dirties on its own --
# a CORE- key landed in docs/signing.md six days after the pre-publication audit snapshot -- so
# the paths to guard are an argument list rather than a single hardcoded directory.
#
# It also refuses the pull_request_target trigger in any workflow. That trigger runs with the
# base repository's secrets on code from a fork, which is exactly the combination a public
# repository must not offer.
#
# A guard that cannot read its input fails rather than reporting a clean tree: a missing target
# directory, or any scan error, exits 2. Exit 1 means the tree was read and something was found.
set -euo pipefail

TARGETS=("$@")
[ "${#TARGETS[@]}" -gt 0 ] || TARGETS=(.github)
SELF="$(basename "$0")"
status=0

for target in "${TARGETS[@]}"; do
  if [ ! -e "$target" ]; then
    echo "$SELF: $target does not exist; nothing was scanned." >&2
    exit 2
  fi
done

# grep's exit status is three-valued: 0 found something, 1 read the tree and found nothing,
# anything else could not do the search. Folding that third case into "found nothing" is how a
# guard reports success on a directory it never opened, so it exits instead. Hits land in $hits.
scan() {
  local pattern="$1"
  shift
  local rc=0
  hits="$(grep -rnE "$@" -- "$pattern" "${TARGETS[@]}")" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "$SELF: grep exited $rc scanning ${TARGETS[*]}." >&2
    exit 2
  fi
  return "$rc"
}

if scan 'CORE-[0-9]+' --exclude="$SELF"; then
  echo "Internal issue identifiers found (move the rationale into the comment):"
  echo "$hits"
  status=1
fi

# Match the trigger as a YAML key or list item, not the word inside a comment. A key may be
# quoted and may carry a trailing comment, so neither ends the match; a line opening with "#"
# still cannot match either alternative.
trigger_key="^[[:space:]]*(-[[:space:]]*)?[\"']?pull_request_target[\"']?[[:space:]]*:?[[:space:]]*(#.*)?\$"
trigger_inline="^[[:space:]]*[\"']?on[\"']?[[:space:]]*:.*\bpull_request_target\b"
if scan "$trigger_key|$trigger_inline" --include='*.yml' --include='*.yaml'; then
  echo "pull_request_target trigger found (forbidden: fork code with base secrets):"
  echo "$hits"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "No internal process references under ${TARGETS[*]}."
fi
exit "$status"
