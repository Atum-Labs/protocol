#!/usr/bin/env bash
#
# Run the TronBox suite and FAIL if it did not actually run.
#
# `tronbox test` EXITS 0 WHEN MIGRATIONS ABORT. That is not a theoretical concern: this suite
# reported success in CI for months while running zero tests, because
# 2_deploy_all_contracts.js threw `Invalid network` on the development network (and, before
# that, every deployment was rejected at broadcast with "feeLimit must be >= 0 and <=
# 1000000000"). tronbox printed the error, skipped every spec, and returned 0. The CI step was
# green the whole time.
#
# The tests themselves are not self-sufficient either — they resolve contracts through
# `artifact.address`, which only the migration populates — so "migrations failed" always means
# "nothing was tested", never "tested with less setup".
#
# So exit status alone cannot be trusted here. This wrapper additionally requires mocha to have
# reported a passing count, which is only printed when specs actually executed.
set -uo pipefail

# THE TEMPLATE MUST CONTAIN XXXXXX. `mktemp -t tronbox-test` is accepted by BSD/macOS mktemp but
# REJECTED by GNU coreutils ("too few X's in template"), so on a Linux runner it returned empty and
# non-zero. `tee ''` then failed, the log was never written, and the result check below read
# nothing and reported "no passing tests" — for a run that had just printed "26 passing". The
# tests were fine both times; this wrapper was broken on Linux only, which is precisely the class
# of bug that passes locally on a Mac and fails in CI.
#
# Verified against GNU coreutils 9.1: `mktemp -t tronbox-test` exits 1, the form below exits 0.
log="$(mktemp "${TMPDIR:-/tmp}/tronbox-test.XXXXXX")" || {
  echo "ERROR: could not create a temp file to capture the test output." >&2
  exit 1
}
if [ ! -w "$log" ]; then
  echo "ERROR: temp log '$log' is not writable; refusing to run and report an unverifiable result." >&2
  exit 1
fi
trap 'rm -f "$log"' EXIT

# --network development is explicit: tronbox's default network selection is what surfaced as
# "Invalid network" rather than a clear message about which network it picked.
tronbox test --network development "$@" 2>&1 | tee "$log"
status="${PIPESTATUS[0]}"

if [ "$status" -ne 0 ]; then
  echo "TronBox tests failed (exit ${status})." >&2
  exit "$status"
fi

# STRIP ANSI COLOUR BEFORE MATCHING, AND DO NOT ANCHOR TO LINE START. mocha colourises its
# summary, so the line reaches this file as e.g. $'\e[92m  26 passing\e[0m'. An anchored pattern
# fails on the escape sequence and reports "no passing tests" for a run that passed perfectly
# well; that is how the first version of this guard turned a green CI job red. Failing closed is
# the right direction for a guard, but a false red is still a wrong answer.
plain="$(sed -E $'s/\e\\[[0-9;]*[A-Za-z]//g' "$log")"

if ! grep -qE '[0-9]+ passing' <<<"$plain"; then
  echo "" >&2
  echo "ERROR: tronbox exited 0 but reported no passing tests." >&2
  echo "That means the suite never ran — almost always a migration that aborted before the" >&2
  echo "specs loaded. Scroll up for the migration error; do NOT read this as a pass." >&2
  exit 1
fi

if grep -qE '[0-9]+ failing' <<<"$plain"; then
  echo "ERROR: tronbox reported failing tests but exited 0." >&2
  exit 1
fi
