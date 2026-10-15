# Release notes — @andrian.yablonskyy/thub-client

What changed in each release, newest first. `## Unreleased` collects the changes since the version on npm; `bin/publish` turns that heading into the version and date it releases.

## 1.1.24 — 2026-10-15

### Changed

- Requires thub-common 2.2.3.

## 1.1.22 — 2026-10-14

### Changed

- Requires thub-common 2.2.2.

## 1.1.21 — 2026-10-13

### Changed

- **No `serialport`, no failed jobs.** A Client host without the `serialport` package failed every job of an HW Client with UARTs in `ERROR` ("HW executor needs the 'serialport' package installed"). Such jobs now run, and the job's log says UART capture is off and how to add it.
- **`serialport` is an optional dependency**, installed with thub-client (prebuilt binaries for amd64 and arm64). An install where it can't be added still succeeds.

## 1.1.20 — 2026-10-13

### Changed

- Requires thub-common 2.2.1.

## 1.1.19 — 2026-10-13

### Added

- **A udev filter's own `SYMLINK+="path"`** overrides `thub/dut<index>-<kind>`: the rule makes `/dev/<path>`, and the Client uses that as the device's path (UART capture, capabilities). Needs thub-common 2.2.0.

## 1.1.18 — 2026-10-13

### Added

- **Mass storage drives** (`hw-devices.storages`, README §8.6): `/dev/thub/dut<N>-storage` from a udev filter, e.g. an STLINK-V3's drive. They're reported with the capabilities, and `block` devices are re-triggered with `usb` and `tty` after the rules change. `storages` is reported in the editable config only when the file has it, because a Coordinator from before it would refuse the list.
- **udev filters** (README §8.6): an `hw-devices` entry with `"udev": "SUBSYSTEM==\"tty\", ATTRS{serial}==\"…\""` and an `index` gets the rule `<filter>, SYMLINK+="thub/dut<index>-<kind>"`. The filter is checked again before it's written (matches only), and a config with a bad one is refused at start. Entries with `devpath` produce the same rules as before. Needs thub-common 2.1.0.

## 1.1.17 — 2026-10-09

### Changed

- **A Coordinator whose license has no room for another runner** (`402` at registration, README §13.5): the Client logs the reason and tries again every minute, instead of exiting and being restarted by systemd. Any other refusal still stops it as before.

## 1.1.16 — 2026-10-09

### Removed

- **Old config shapes.** The Client reads `hw-devices` only: an HW Client's file that still has a `hw` section stops the start, asking to rename it. `hw-devices` is checked against its schema at start, so old fields (`uart`, `stlinkSerial`, `relays`, `power`) stop it too, named. Write `uarts` / `stlinks` lists instead of the single-device fields, and remove the power-control fields. `sw`, `artifactory` and `sources` sections are no longer stripped on a dashboard save; they were unused already.
- **The `99-thub.rules` hint.** A conflicting udev rule is reported like any other; delete a leftover `/etc/udev/rules.d/99-thub.rules` (thub-client ≤ 1.0.17) by hand.
- Unused code and the `uuid` dependency.

## 1.1.15 — 2026-10-09

Changes since 1.1.14.

### Changed

- **Back on npm.** Install with `npm i -g @andrian.yablonskyy/thub-client`. `check-update`, `self-update` and dashboard-requested updates use npm again, and require thub-common from npm. The git-based updates in the versions released only as git tags (1.1.13–1.1.14) are gone. An install of one of those updates from git tags, which are still pushed with every release, so it keeps updating.

## 1.1.14 — 2026-10-08

Changes since 1.1.13.

### Changed

- **Updates come from the Client's git repository.** `thub-client check-update` reads its newest release tag. The root update helper (dashboard **Update**) and `thub-client self-update` install with `npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-client.git#vX.Y.Z`.
- **The postinstall sets up once per install.** npm also runs it while preparing a git package, and it skips that run, so instances restart once, not twice.

### Upgrading from npm

- A Client installed from npm (1.1.12 or older) can only update from npm, where nothing new comes. Reinstall it once on its host with `sudo npm i -g --install-links git+https://github.com/andrianyablonskyy/thub-client.git`; it restarts its instances. From then on the dashboard updates it as usual.

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
