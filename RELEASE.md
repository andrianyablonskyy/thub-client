# Release notes — @andrian.yablonskyy/thub-client

What changed in each release, newest first. `## Unreleased` collects the changes since the version on npm; `bin/publish` turns that heading into the version and date it releases.

## 1.1.13 — 2026-10-08

Changes since 1.1.13.

### Changed

- **Not published to npm any more.** A release is its `vX.Y.Z` tag on GitHub. thub-common comes from its public repository by tag (`git+https://github.com/andrianyablonskyy/thub-common.git#semver:^…`), so installing needs `git` on the host. `package.json` has `"private": true`.

## 1.1.10 — 2026-10-08

Changes since 1.1.9.

### Added

- **Serial ports survive resets.** A captured UART that disappears is reopened as soon as it's back, with a line in the log each way. That includes a board's own USB serial port while the board resets, e.g. after the job flashes it. A UART that isn't there when the job starts is waited for. Until now, its capture just stopped.
- **Boards' own USB serial ports can be captured** like UART adapters: list them in `hw-devices.uarts` with `"subsystem": "tty"` and the board's USB id.
- **Up to 16 devices per list** (`stlinks`, `uarts`, `usbs`; was 8), e.g. five boards with an ST-Link, a UART adapter and a USB serial port each on one Client.

### Changed

- **UART lines are tagged with the port's name** — its `label`, or its device's file name (`[dut2-usb] …`) — instead of its position in the list (`[uart7] …`), when a Client captures more than one.
- A dry run (`thub run --dry-run`) says each captured UART is reopened if it disconnects.

### Fixed

- **A configured UART that wasn't there could end the Client.** Opening it raised an error event nothing listened to. Every serial error is now written to the job's log instead.

### Requires

- `@andrian.yablonskyy/thub-common` 1.1.7 or later (16-entry device lists, the UART `label`): it validates the Client's config.

### Docs

- README: serial ports in the log (tags, reopening, boards' USB serial ports).

## 1.1.9 — 2026-10-08

Changes since 1.1.8.

### Added


### Changed


### Fixed

- **Disabled tests no longer count as passed.** GoogleTest (`DISABLED_` tests) and CTest report tests that never ran in a separate `disabled` attribute, which the job's test counts ignored, so they showed as passed. They're now counted as skipped.

### Docs

- README: Node.js 24 from NodeSource on Ubuntu 26.04 (whose own `nodejs` is 22), test results (where the Client reads JUnit XML, and why a test that drives the board itself mustn't use a UART the Client captures), private CAs for `--download-file`; the license is now `LICENSE.md` (`"license"` and `"author"` set in `package.json`).
- These release notes (`RELEASE.md`) are now part of the package.
