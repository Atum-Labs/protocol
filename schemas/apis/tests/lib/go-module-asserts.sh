# Shared assertions for the Go module regression tests. Source it; each
# function exits the calling script on failure.

# assert_minimum <module dir> <dependency> <minimum version>
assert_minimum() {
  local actual
  actual=$(cd "$1" && go list -mod=readonly -m -f '{{.Version}}' "$2")
  if ! awk -v actual="$actual" -v minimum="$3" 'BEGIN {
    sub(/^v/, "", actual); sub(/^v/, "", minimum)
    split(actual, a, /[.\-+]/); split(minimum, m, /[.\-+]/)
    for (i = 1; i <= 3; i++) {
      if (a[i] + 0 > m[i] + 0) exit 0
      if (a[i] + 0 < m[i] + 0) exit 1
    }
    exit (actual ~ /-/)
  }'; then
    echo "$1: $2 expected >= $3, got $actual" >&2
    exit 1
  fi
}

# assert_go_version <module dir>
assert_go_version() {
  local actual
  actual=$(cd "$1" && go list -m -f '{{.GoVersion}}')
  if [ "$actual" != 1.25.0 ]; then
    echo "$1: expected Go minimum 1.25.0, got $actual" >&2
    exit 1
  fi
}
