# Release notes — @andrian.yablonskyy/thub-client

What changed in each release, newest first. `## Unreleased` collects the changes since the version on npm; `bin/publish` turns that heading into the version and date it releases.

## Unreleased

Changes since 1.1.8.

### Fixed

- **Disabled tests no longer count as passed.** GoogleTest (`DISABLED_` tests) and CTest report tests that never ran in a separate `disabled` attribute, which the job's test counts ignored, so they showed as passed. They're now counted as skipped.

### Docs

- README: Node.js 24 from NodeSource on Ubuntu 26.04 (whose own `nodejs` is 22), test results (where the Client reads JUnit XML, and why a test that drives the board itself mustn't use a UART the Client captures), private CAs for `--download-file`; the license is now `LICENSE.md` (`"license"` and `"author"` set in `package.json`).
- These release notes (`RELEASE.md`) are now part of the package.
