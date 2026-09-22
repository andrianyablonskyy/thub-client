# @andrian.yablonskyy/thub-client

The Client (`thub-client`) component of [TestHub](https://github.com/andrianyablonskyy/thub) — a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. This is the daemon that runs on lab machines, executes test jobs against a DUT, streams logs back, and uploads results. It owns exactly one DUT slot per process — a machine with two boards runs two instances with different configs.

Clients only make **outbound** connections to the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) — nothing in the lab needs to be exposed. See the [main TestHub repo](https://github.com/andrianyablonskyy/thub) for the full system architecture.

## Install (Ubuntu 26.04)

```bash
sudo apt install -y nodejs npm stlink-tools openocd uhubctl
sudo useradd --system --home /var/lib/thub --groups dialout,plugdev thub

# This also installs udev/99-thub.rules to /etc/udev/rules.d (HW only)
# and systemd/thub-client@.service to /etc/systemd/system, via the
# package's postinstall script — since npm runs it as root here, no
# separate manual `cp` step is needed for either.
sudo npm install -g @andrian.yablonskyy/thub-client

# SW only: Docker
sudo apt install -y docker.io && sudo usermod -aG docker thub

# npm install doesn't create this — write your own, one per DUT slot,
# named to match the systemd instance you enable below (dut0 -> dut0.json).
# %h in the unit resolves to thub's home (/var/lib/thub, set via
# useradd --home above), so the file lives under its .config, same as
# every other package's ~/.config/thub/<name>.json default (§13).
# See "Configuration reference" below for every field and full SW/HW
# examples.
sudo mkdir -p /var/lib/thub/.config/thub
sudo chown thub:thub /var/lib/thub/.config /var/lib/thub/.config/thub
sudo tee /var/lib/thub/.config/thub/dut0.json > /dev/null <<'EOF'
{
  "coordinatorUrl": "https://thub.example.com",
  "name": "lab-hw-01",
  "type": "hw",
  "joinKey": "<same value as the Coordinator's clientJoinKey>"
}
EOF

sudo systemctl enable --now thub-client@dut0
```

The systemd unit uses `Restart=always`, `NoNewPrivileges=yes`, `ProtectSystem=strict` and `ReadWritePaths=/var/lib/thub`; the template name (`@dut0`) selects `~/.config/thub/dut0.json` for the `thub` user (`%h/.config/thub/%i.json` in the unit, i.e. `/var/lib/thub/.config/thub/dut0.json`) so one machine can host multiple DUT slots. Its `ExecStart` is rewritten at install time to this exact install's real `node`/`daemon.js` paths — not just the checked-in file's hardcoded `/usr/lib/node_modules/...` guess — so it works whether Node came from `apt`, `nvm`, or anywhere else.

The udev rule, systemd unit and `~/.config/thub/client.json` install are all best-effort and never fail the `npm install` itself, and only ever run for an actual global install (`npm install -g`) — a plain local `npm install` (e.g. in a dev checkout, or as root inside a CI/Docker image, which is common) never touches `/etc/udev`, `/etc/systemd`, or `~/.config/thub` at all. On a non-Linux machine, or a global install without root, the udev/systemd steps just print their own manual fallback command instead of running it.

## Running it directly (no systemd — after a global install, development, or a one-off manual run)

`npm install -g` also gives you `thub-client-daemon`, a direct command for the daemon itself (`thub-client` alone is only the control CLI — lock/unlock/status/stop/restart):

```bash
THUB_CLIENT_CONFIG=/etc/thub/dut0.json thub-client-daemon
thub-client-daemon --config /etc/thub/dut0.json   # equivalent
```

From a local checkout of this repo (not a global install), the same thing is `node src/daemon.js` in place of `thub-client-daemon`.

Config resolution: `--config`/`-c` flag, or `THUB_CLIENT_CONFIG` env var, → `~/.config/thub/client.json` → the bundled `config.json` default. Plain JSON only. A specific instance still always needs its own explicit `--config`/`THUB_CLIENT_CONFIG` — the `~/.config/thub/client.json` fallback only covers the single default/no-flag case.

`npm install -g` creates `~/.config/thub/client.json` for you if it doesn't already exist, with blank `coordinatorUrl`/`name`/`joinKey` (so nothing registers until you set them) — a re-install never overwrites it. For a multi-instance setup (`dutN.json` files, above) it's just a starting point for your first/default instance.

**Running several Clients on one host** — start one daemon process per config file, each pointed at its own `dutN.json`; every default path (`tokenFile`, `workDir`, `socketPath`, `pidFile`, `clientIdFile`) is already namespaced by the config file's own basename, so up to 8 instances (`dut0`..`dut7`, one per UART/ST-Link/relay channel) coexist with zero extra setup:

```bash
THUB_CLIENT_CONFIG=/etc/thub/dut0.json thub-client-daemon &
THUB_CLIENT_CONFIG=/etc/thub/dut1.json thub-client-daemon &
```

If two instances instead share the exact same config file (told apart only by editing `name` between runs), that namespacing collapses and both register as the *same* resource. Set `clientId` (or `THUB_CLIENT_ID`) and distinct `socketPath`/`pidFile` explicitly in that case.

## Configuration reference

| Field | Required | Default | Meaning |
|---|---|---|---|
| `coordinatorUrl` | Yes | — | Base URL of the Coordinator. |
| `name` | Yes | — | Resource name. Identity is actually `clientId` — renaming is safe. |
| `type` | Yes | — | `hw` or `sw`. |
| `labels` | No | `[]` | Fully replaces the resource's labels on every registration. |
| `groups` | No | `[]` | Which resource group(s) this Client is a member of — fully replaces membership on every registration. |
| `joinKey` | Yes, unless re-registering is disabled | — | Shared secret proving this Client may self-register. Also settable as `THUB_CLIENT_JOIN_KEY`. Consulted on every start/restart. |
| `varDir` | No | `/var/lib/thub` | Base for `tokenFile`/`workDir` defaults. |
| `runDir` | No | `/run/thub` | Base for `socketPath`/`pidFile` defaults. **Must be changed on macOS** — `/run` doesn't exist there. |
| `tokenFile` | No | `<varDir>/<instance>.token` | Where the resource id + token are persisted (0600) after registration. |
| `workDir` | No | `<varDir>/work/<instance>` | Per-job workspace root, cleaned up after each job. |
| `socketPath` | No | `<runDir>/<instance>.sock` | Unix socket for `thub-client lock/unlock/status`. |
| `pidFile` | No | `<runDir>/<instance>.pid` | PID file `thub-client stop`/`restart` use to find the daemon. |
| `clientIdFile` | No | `<varDir>/<instance>/.client-id` | Where the stable identity UUID is persisted, unless `clientId` is set. |
| `clientId` | No | — | Explicit identity UUID, skipping `clientIdFile`. Also settable as `THUB_CLIENT_ID`. |
| `heartbeatIntervalSec` | No | `10` | How often the daemon heartbeats. |
| `longPollWaitSec` | No | `30` | How long each job long-poll waits before returning `204`. |
| `artifactory.tokenFile` | No | — | Path to the Client's own read-only Artifactory token. |
| `artifactory.allowedArtifactPrefixes` | No | `[]` | Job `firmware.url`/`tests.url` must start with one of these. |

**SW-only** (`type: sw`): `sw.image` (required), `sw.cpus` (default 2), `sw.memory` (default `2g`).

**HW-only** (`type: hw`): `hw.stlinkSerial`, `hw.uart.index`/`.path`/`.baudRate`, `hw.power.method` (`uhubctl` or `relay`), `hw.power.hub`/`.port` or `.relayIndex`/`.baseUrl`.

Example SW config:

```json
{
  "coordinatorUrl": "https://thub.example.com",
  "name": "lab-sw-01",
  "type": "sw",
  "joinKey": "<same value as the Coordinator's clientJoinKey>",
  "artifactory": { "tokenFile": "/etc/thub/artifactory.token" },
  "sw": { "image": "registry.example.com/dut-emulator:2026.08", "cpus": 2, "memory": "2g" }
}
```

## `thub-client` — the control CLI

```bash
sudo thub-client lock --reason "debugging I2C"   # -> BUSY (source=local)
sudo thub-client unlock                           # -> IDLE
thub-client status
thub-client stop      # SIGTERM; graceful, bounded shutdown
thub-client restart   # stop, then start a new daemon with the same config
```

`stop`/`restart` go through the pidfile rather than the control socket, so they work even if the socket is wedged. Stopping is bounded: an idle long-poll is aborted immediately; a running job is killed locally (`SIGTERM`, then `SIGKILL` after a 10s grace period) and reported `ERROR`.

With several instances on one host, target the right one with `--config` before the subcommand:

```bash
thub-client --config /etc/thub/dut1.json status
sudo thub-client --config /etc/thub/dut1.json lock --reason "debugging I2C"
```

## Job execution lifecycle

1. Receive the job from long-poll and `accept` it.
2. Create a fresh workspace `<workDir>/<jobId>`.
3. Download firmware and test package from Artifactory; verify `sha256`.
4. **Prepare** the DUT through the executor (flash or start emulator).
5. **Run** `./run-tests.sh --suite <suite> [--arg ...]` with environment variables describing the DUT, plus one `THUB_META_<KEY>` per job metadata field.
6. Collect results (JUnit XML, console log, anything left in `artifacts/`).
7. Upload artifacts, post the result, clean the workspace, report `IDLE`.

A cancel command or job timeout sends `SIGTERM` to the test process group, waits 10s, then `SIGKILL`, and always runs executor teardown. If `spec.dryRun` is set, steps 2–6 are replaced with log lines describing what would have happened — no download, no executor, no `run-tests.sh`.

### HW executor

ST-Link via `st-flash`/`openocd`, UART via the `serialport` npm package, optional power cycling via `uhubctl` or a networked relay board's REST API (`hw.power.method: "relay"` — a **stub**, `src/relay-client.js`, pending the real board's API spec). Stable device paths come from udev rules (`/dev/thub/dut0-uart`, etc.).

### SW executor

Runs the emulator (e.g. Renode, QEMU) in Docker via `dockerode`, one container per job, isolated network, always removed in teardown. The emulator's virtual UART is exposed as a TCP port the test runner connects to via `THUB_DUT_HOST`.

## Development

```bash
npm install
npm run lint
```

## License

Proprietary — see the header comment in each source file.
