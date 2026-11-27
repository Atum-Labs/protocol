<!--
SDK release (see RELEASING.md). Title: "Release <sdk> <version>[, <sdk> <version>]".
Request one named human reviewer and add a review-priority label.
-->

Releases the SDKs below. Version bumps and changelog stamps only, no source changes.

| Package           | From     | To          |
| ----------------- | -------- | ----------- |
| `@atumlabs/<sdk>` | `<prev>` | **`<new>`** |

<!-- One or two lines on what stands out, e.g. breaking changes. Details are in each CHANGELOG.md. -->

- [ ] Approved, then published from this branch with `dist_tag: latest`
- [ ] `main` merged in; each `CHANGELOG.md` differs from its release tag only under `## [Unreleased]`
- [ ] Merged after the publish
