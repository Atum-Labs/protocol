#!/usr/bin/env bash
# Install a pinned Go tool, retrying a transient fetch failure, and prove it landed.
#
#   .github/scripts/go-install.sh <binary-name> <module@version>
#
# WHY. `go install` reaches the module proxy and the checksum database over the network, and a
# blip there is indistinguishable from a real failure in the logs -- except that it has nothing
# to do with the change under review. It has happened here: `Install gojq` failed, took the
# whole Schema guards lane with it, and the PR author was left reading a red build caused by
# someone else's outage. The tools are already version-pinned, so a retry cannot pick up
# different code; it only removes the coin-flip.
#
# The binary is then executed. `go install` normally reports failure honestly, but a tool that is
# somehow absent from GOPATH/bin afterwards fails later, in a step that blames the wrong thing --
# the same way a missing golangci-lint surfaced as a confusing error from make rather than from
# the install that never happened.
set -euo pipefail

BIN="${1:?usage: go-install.sh <binary-name> <module@version>}"
MODULE="${2:?usage: go-install.sh <binary-name> <module@version>}"
GOBIN="$(go env GOPATH)/bin"

for attempt in 1 2 3; do
  if go install "$MODULE"; then
    # Belt and braces: prove the binary is on disk rather than trusting the exit status.
    if [ -x "$GOBIN/$BIN" ]; then
      echo "installed $BIN from $MODULE"
      exit 0
    fi
    echo "::error::go install $MODULE reported success but $GOBIN/$BIN is not executable" >&2
    exit 1
  fi
  echo "go install $MODULE failed (attempt ${attempt}/3); retrying in $((attempt * 5))s" >&2
  sleep "$((attempt * 5))"
done

echo "::error::go install $MODULE failed after 3 attempts"
exit 1
