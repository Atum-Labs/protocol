#!/usr/bin/env bash
# Bootstrap the SVM deployment tooling for a fresh clone.
# Thin wrapper — all the logic is in contracts/deploy/bootstrap.sh so the three VMs
# cannot drift apart. Accepts the same flags (--check, --help).
set -uo pipefail
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  _d="$(cd -P "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$_d/$SELF" ;; esac
done
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
exec bash "$HERE/../../deploy/bootstrap.sh" svm "$@"
