#!/usr/bin/env bash
# Self-test for the check-shared-error-shape guard in schemas/Makefile.
#
# The guard scans a whole tree and aggregates one exit code, so a single tree
# holding both conforming and drifted fixtures could only ever produce one
# verdict. Each case therefore gets its own tree, and the guard is re-invoked
# per case with ERROR_SHAPE_ROOT pointed at it and SHARED_ERROR_SPECS set to
# that case's list.
#
# Each case asserts the exit code AND a substring of the output. Exit code
# alone is not enough: a guard mutated to reject everything would satisfy every
# failing case while being completely broken.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCHEMAS=${SCHEMAS_DIR:-$(cd "$HERE/../.." && pwd)}
GUARD_MAKEFILE=${GUARD_MAKEFILE:-$SCHEMAS/Makefile}
# Exported by the calling recipe so the sub-make is the same make, and
# MAKEFLAGS is cleared so a parent -j / -k / variable override cannot reach it.
MAKE=${MAKE:-make}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/shared-error-shape.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# name | SHARED_ERROR_SPECS | expect | needle | stub
CASES=$(cat <<'TABLE'
match|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
direct-ref|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
allof-ref|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
allof-ref-extended|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
apierror-alias|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
reordered|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
unlisted-no-error||pass|Service specs use the error/v1 ErrorResponse field set|
skip-node-modules|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
skip-embed|svc/v1/openapi.yaml|pass|Service specs use the error/v1 ErrorResponse field set|
diff-fields|svc/v1/openapi.yaml|fail|defines its own error field set|
type-diff|svc/v1/openapi.yaml|fail|defines its own error field set|
extra-required|svc/v1/openapi.yaml|fail|defines its own error field set|
missing-optional|svc/v1/openapi.yaml|fail|defines its own error field set|
unlisted-own-shape||fail|defines its own error field set|
no-error-component|svc/v1/openapi.yaml|fail|defines no ErrorResponse component|
unlisted-with-errors||fail|declares a 4xx/5xx response but is not in SHARED_ERROR_SPECS|
foreign-file-ref|svc/v1/openapi.yaml|fail|references an error shape that is not|
suffix-component-ref|svc/v1/openapi.yaml|fail|references an error shape that is not|
internal-component-ref|svc/v1/openapi.yaml|fail|references an error shape that is not|
allof-foreign-ref|svc/v1/openapi.yaml|fail|references an error shape that is not|
allof-foreign-first|svc/v1/openapi.yaml|fail|references an error shape that is not|
stale-list-entry|svc/v1/openapi.yaml nested/svc/v1/openapi.yaml|fail|which no spec matched|
bad-yaml|svc/v1/openapi.yaml|fail|could not be projected|
broken-canon|svc/v1/openapi.yaml|fail|did not project a field set|
match|svc/v1/openapi.yaml|fail|did not project a field set|gojq-empty
match|svc/v1/openapi.yaml|fail|did not project a field set|gojq-none
match|svc/v1/openapi.yaml|fail|gojq not found|gojq-absent
TABLE
)

pad() { printf '%-38s' "$1"; }
fails=0; ran=0

while IFS='|' read -r name specs expect needle stub; do
  [ -n "$name" ] || continue
  ran=$((ran + 1))
  label=$name; [ -n "$stub" ] && label="$name [$stub]"

  tree=$WORK/$ran
  mkdir -p "$tree"
  cp -R "$HERE/cases/$name/." "$tree/"
  # A case that ships its own error/v1 is testing the canonical side; leave it.
  [ -e "$tree/error/v1/openapi.yaml" ] || cp -R "$HERE/canon/." "$tree/"
  # node_modules cannot be committed, so materialize it here.
  if [ -f "$tree/node-modules-spec.yaml" ]; then
    mkdir -p "$tree/vendor/node_modules/pkg/v1"
    mv "$tree/node-modules-spec.yaml" "$tree/vendor/node_modules/pkg/v1/openapi.yaml"
  fi

  path=$PATH
  case $stub in
    gojq-empty)  mkdir -p "$tree/.stub"; printf '#!/bin/sh\nexit 0\n'          > "$tree/.stub/gojq"; chmod +x "$tree/.stub/gojq"; path=$tree/.stub:$PATH;;
    gojq-none)   mkdir -p "$tree/.stub"; printf '#!/bin/sh\necho \x27"none"\x27\n' > "$tree/.stub/gojq"; chmod +x "$tree/.stub/gojq"; path=$tree/.stub:$PATH;;
    # A PATH holding everything the recipe shells out to EXCEPT gojq, so the
    # "gojq not found" branch is what fires and not a missing coreutil.
    gojq-absent)
      mkdir -p "$tree/.nogojq"
      for t in "$MAKE" which find sed sort grep cat; do
        ln -sf "$(command -v "$t")" "$tree/.nogojq/$(basename "$t")"
      done
      path=$tree/.nogojq;;
  esac

  out=$(PATH="$path" MAKEFLAGS= "$MAKE" -C "$SCHEMAS" -f "$GUARD_MAKEFILE" check-shared-error-shape \
          "ERROR_SHAPE_ROOT=$tree" "SHARED_ERROR_SPECS=$specs" 2>&1)
  rc=$?

  got=pass; [ $rc -eq 0 ] || got=fail
  if [ "$got" = "$expect" ] && printf '%s' "$out" | grep -qF -- "$needle"; then
    echo "  ✓ $(pad "$label") expected $expect"
  else
    echo "  ✗ $(pad "$label") expected $expect matching \"$needle\", got $got (rc=$rc)"
    printf '%s\n' "$out" | sed 's/^/      | /'
    fails=$((fails + 1))
  fi
done <<< "$CASES"

echo
if [ $fails -ne 0 ]; then
  echo "✗ $fails of $ran guard self-test cases failed. check-shared-error-shape does not behave as specified."
  exit 1
fi
echo "✅ all $ran check-shared-error-shape self-test cases behave as specified"
