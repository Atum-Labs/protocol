# check-shared-error-shape self-test

Fixture trees for `make -C schemas test-shared-error-shape`, which tests the
`check-shared-error-shape` guard in `schemas/Makefile`.

## Why this exists

That guard is the only thing holding the service specs to one error shape, and
it is the only hand-written comparator among the `check-*` targets. The others
regenerate an artifact and diff it, so the generator is the specification and
`git diff` is the comparison. This one is a shell and jq projection with five
decision arms, which makes "someone edits the logic so it always passes" a real
failure mode.

It is not hypothetical. Every false pass this guard has had was found by reading
it, not by CI: an unanchored `$ref` regex that accepted a reference to a
different file's `ErrorResponse`, a missing trailing anchor that accepted
`ErrorResponseV2`, an `allOf` wrapper rejected when it should pass, a prefix
match that let a stale list entry be satisfied by an unrelated path, and a
broken `gojq` that made every spec project to nothing and the whole guard pass
silently. Each of those is now a case here.

Half the guard is also unreachable from the real tree: no spec uses `$ref`
today, so the `shared-ref` and `foreign-ref` arms never run in production. The
fixtures are the only thing exercising them.

## How it works

The guard scans a tree and aggregates one exit code, so one tree mixing
conforming and drifted specs could only produce one verdict. Each case is its
own tree, and the guard is re-invoked against it with `ERROR_SHAPE_ROOT` and
`SHARED_ERROR_SPECS` overridden. `ERROR_SHAPE_ROOT` exists only for this.

Each case asserts the exit code **and** a substring of the diagnostic. The exit
code alone proves nothing, because a guard mutated to reject everything
satisfies every failing case. Two of the mutations verified against this suite
do exit non-zero for the wrong reason, and only the message assertion catches
them.

`canon/error/v1/openapi.yaml` is a synthetic canonical spec, deliberately not a
copy of the real `error/v1`. The guard is what is under test, so the fixtures
must not need editing every time the real error shape gains a field.

## Adding a case

Add a directory under `cases/`, put the spec at `<case>/svc/v1/openapi.yaml`,
and add a row to the table at the top of `run.sh` giving the case name, the
`SHARED_ERROR_SPECS` value, whether it should pass or fail, and a substring of
the expected output.
