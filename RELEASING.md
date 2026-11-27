# Releasing the npm SDKs

`<sdk>` is `payment-gateway-client`, `mppx-atum-escrow` or `x402-atum-escrow`. Publish with
**Actions → "Publish \<sdk\>" → Run workflow**. Run it from the branch below; the workflow
refuses any other branch, or a changelog that does not match the version.

## Release candidate (a test build)

1. `git switch --no-track -c rc/<sdk>-0.8.0 origin/main`
2. Set `version` in the SDK's `package.json` to `0.8.0-rc.1`. Leave `CHANGELOG.md` as it is.
3. Commit, push, and run the workflow from this branch with `dist_tag: next`.
4. Test it: `npm install @atumlabs/<sdk>@0.8.0-rc.1` (or `@next` for the newest candidate).

For the next candidate, set `0.8.0-rc.2` on the same branch and run it again. Never merge
the branch; delete it when you are done.

## Release

1. `git switch --no-track -c release/<sdk>-0.8.0 origin/main` (one branch can release
   several SDKs).
2. For each SDK, in one commit:
   - set `version` in `package.json` to `0.8.0`;
   - rename `## [Unreleased]` in `CHANGELOG.md` to `## [0.8.0] - <today>`;
   - add an empty `## [Unreleased]` above it.
3. Open a pull request to `main` with the release template: add
   `?template=release.md&expand=1` to the compare URL.
4. Once it is approved, run the workflow from this branch with `dist_tag: latest`.
5. `git fetch --tags origin && git merge origin/main`, then compare each changelog with
   what was published: `git diff <sdk>-v0.8.0 -- '*<sdk>/CHANGELOG.md'`. It may only add
   lines under `## [Unreleased]`. Git can put a line that `main` added after your cut under
   `## [0.8.0]` without a conflict; move it back. On a conflict, keep `## [0.8.0]` as
   published and only `main`'s new lines under `## [Unreleased]`.
6. Push, then merge the pull request. If `main` moves again first, repeat step 5.

Publish before you merge: `main` may already hold changes that are not in this release.

## What is published

```bash
npm view @atumlabs/<sdk> versions         # every published version
npm view @atumlabs/<sdk> dist-tags        # what `latest` and `next` point at
git fetch --tags && git tag -l '<sdk>-v*' # each publish tags its commit <sdk>-v<version>
```

If the workflow's tag step fails, re-run the failed jobs; the publish is not repeated.

## Wrong version on `latest`

```bash
npm dist-tag add @atumlabs/<sdk>@0.7.0 latest
```
