# @andrian.yablonskyy/thub-client

The Client (`thub-client`) component of [TestHub](https://github.com/andrianyablonskyy/thub) — a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. This is the daemon that runs on lab machines, executes test jobs against a DUT, streams logs back, and uploads results. It owns exactly one DUT slot per process — a machine with two boards runs two instances with different configs.

Clients only make **outbound** connections to the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) — nothing in the lab needs to be exposed. See the [main TestHub repo](https://github.com/andrianyablonskyy/thub) for the full system architecture.

## Install

```bash
sudo npm i -g @andrian.yablonskyy/thub-client
```

That one command is the complete installation. Run as root on Linux, for the user who ran `sudo` (`SUDO_USER` — not root; that user owns every file and runs the service), the package's postinstall scripts:

- create `~/.config/thub` and `~/var/lib/thub/client` (with `work/`) — the state directory for tokens, client ids, job workspaces, control sockets and pidfiles;
- create `~/.config/thub/client.json` (0600) if it doesn't exist yet, with blank `coordinatorUrl`/`joinKey`, `type: hw` and `varDir` pointing at the state directory — a re-install/upgrade never overwrites it;
- install `udev/99-thub.rules` to `/etc/udev/rules.d` (stable `/dev/dut<N>-uart|usb|stlink` paths for HW Clients) and reload udev;
- install `/etc/systemd/system/thub-client@.service`, rendered for that user: `User=`/`Group=`, `SupplementaryGroups=` whichever of `dialout`, `plugdev` and `docker` exist on the host, `THUB_CLIENT_CONFIG=~/.config/thub/%i.json`, the state directory as `WorkingDirectory=`/`ReadWritePaths=`, and `ExecStart` pointing at this install's real `node`/`daemon.js` (works with `apt`-installed Node, `nvm` or any npm prefix) with `--name %i`, so each instance registers under its own instance name;
- enable and (re)start `thub-client@client` once `client.json` is filled in, and restart every other running `thub-client@*` instance, so an upgrade takes effect immediately.

On a fresh install the service isn't started yet — the daemon would exit at once with blank required fields. Fill in the config, then start it (below).

## Ubuntu 26.04 host setup

```bash
sudo apt install -y nodejs npm stlink-tools openocd uhubctl
# SW only: Docker — install it before thub-client so the service gets the
# docker group (re-run the npm i -g below if you add it later)
sudo apt install -y docker.io

sudo npm i -g @andrian.yablonskyy/thub-client

# coordinatorUrl, type and joinKey (the Coordinator's clientJoinKey);
# see "Configuration reference" below for every field
nano ~/.config/thub/client.json

sudo systemctl enable --now thub-client@client
journalctl -u thub-client@client -f
```

The service is started as `thub-client@<instance>.service`. The instance name does two things: it selects the config file (`thub-client@<instance>` reads `~/.config/thub/<instance>.json`), and it is passed to the daemon as `--name <instance>`, which becomes the Client's resource name and overrides any `name` in that file. So the default `thub-client@client` registers as `client`.

**Several DUT slots on one host.** Register one instance per slot — `thub-client register` creates `~/.config/thub/<name>.json` from `client.json` (same `coordinatorUrl`/`joinKey`/`varDir`, the given `type`, no `name`), then enables and starts `thub-client@<name>` (it starts it only once `coordinatorUrl` and `joinKey` are set, and runs `systemctl` through `sudo` if you aren't root):

```bash
thub-client register --name dut1 --type hw   # then edit hw in ~/.config/thub/dut1.json for slot 1
thub-client register --name emu1 --type sw
thub-client deregister --name dut1           # stop + disable thub-client@dut1, remove dut1.json
```

`--name` defaults to `client` and `--type` to `hw`. From a checkout of this repo the same commands are `npm run register -- --name dut1 --type hw` / `npm run deregister -- --name dut1` (or `npm run client:register -- ...` / `npm run client:deregister -- ...` from the monorepo root). Registering an existing instance keeps its config and only updates `type`. Deregistering keeps `client.json` (the template for new instances) and the instance's state under `varDir`, so re-registering the same name comes back as the same resource. Doing it by hand is equivalent: copy `client.json` to `dut1.json`, then `sudo systemctl enable --now thub-client@dut1`.

Keep `varDir` at the one in `client.json` — the service can only write there, and every per-instance path under it is already namespaced by the config's filename. If you change `client.json`'s `varDir`/`runDir`, re-run `sudo npm i -g @andrian.yablonskyy/thub-client` so the unit's `ReadWritePaths=` follows.

Every install step is best-effort and never fails the `npm install` itself, and only runs for an actual global install (`npm install -g`) — a plain local `npm install` (e.g. in a dev checkout, or as root inside a CI/Docker image, which is common) never touches `/etc/udev`, `/etc/systemd`, `~/.config/thub` or `~/var/lib/thub`. A global install without root, or on a non-Linux machine, still creates the directories and `client.json` for the current user, but skips udev/systemd and prints the `sudo npm i -g` command to run instead.

## Running it directly (no systemd — after a global install, development, or a one-off manual run)

`npm install -g` also gives you `thub-client-daemon`, a direct command for the daemon itself (`thub-client` alone is only the control CLI — lock/unlock/status/stop/restart/register/deregister):

```bash
THUB_CLIENT_CONFIG=/etc/thub/dut0.json thub-client-daemon
thub-client-daemon --config /etc/thub/dut0.json   # equivalent
thub-client-daemon --config /etc/thub/dut0.json --name lab-hw-01   # override the config's name
```

`--name`/`-n` overrides the config file's `name`; the systemd unit uses it to pass the instance name.

From a local checkout of this repo (not a global install), the same thing is `node src/daemon.js` in place of `thub-client-daemon`.

Config resolution: `--config`/`-c` flag, or `THUB_CLIENT_CONFIG` env var, → `~/.config/thub/client.json` → the bundled `config.json` default. Plain JSON only. A specific instance still always needs its own explicit `--config`/`THUB_CLIENT_CONFIG` — the `~/.config/thub/client.json` fallback only covers the single default/no-flag case.

`npm install -g` creates `~/.config/thub/client.json` for you if it doesn't already exist (see "Install" above) — a re-install never overwrites it. For a multi-instance setup (`dutN.json` files, above) it's just a starting point for your first/default instance.

**Running several Clients on one host** — start one daemon process per config file, each pointed at its own `dutN.json`; every default path (`tokenFile`, `workDir`, `socketPath`, `pidFile`, `clientIdFile`) is already namespaced by the config file's own basename, so up to 8 instances (`dut0`..`dut7`, one per UART/ST-Link/relay channel) coexist with zero extra setup:

```bash
THUB_CLIENT_CONFIG=/etc/thub/dut0.json thub-client-daemon &
THUB_CLIENT_CONFIG=/etc/thub/dut1.json thub-client-daemon &
```

If two instances instead share the exact same config file (told apart only by `name`), that namespacing collapses and both register as the *same* resource. Set `clientId` (or `THUB_CLIENT_ID`) and distinct `socketPath`/`pidFile` explicitly in that case (and tell them apart with `--name` rather than editing the file).

## Configuration reference

| Field | Required | Default | Meaning |
|---|---|---|---|
| `coordinatorUrl` | Yes | — | Base URL of the Coordinator. |
| `name` | No | config file's basename | Resource name. Overridden by the daemon's `--name` — under systemd, the instance name (`thub-client@<name>`), so it is ignored there. Identity is actually `clientId` — renaming is safe. |
| `type` | Yes | — | `hw` or `sw`. |
| `labels` | No | `[]` | Fully replaces the resource's labels on every registration. |
| `groups` | No | `[]` | Which resource group(s) this Client is a member of — fully replaces membership on every registration. |
| `joinKey` | Yes, unless re-registering is disabled | — | Shared secret proving this Client may self-register. Also settable as `THUB_CLIENT_JOIN_KEY`. Consulted on every start/restart. |
| `varDir` | No | `<cwd>/.data` (`~/var/lib/thub/client` in the installed `client.json`) | Base for `tokenFile`/`workDir`/`clientIdFile` defaults. Under systemd it must stay within the unit's `ReadWritePaths=`. |
| `runDir` | No | `varDir` | Base for `socketPath`/`pidFile` defaults. |
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

**HW-only** (`type: hw`): up to 8 each of `hw.stlinks`, `hw.uarts`, `hw.usbs` (entries: udev index 1–8 → `/dev/dut<N>-stlink|uart|usb`, a path, or `{ index | path, ... }`; ST-Link entries may give `serial`, UARTs `baudRate`) and `hw.relays` (`{ channel: 0-7, baseUrl }`), plus `hw.power.method` (`uhubctl` or `relay`) and `hw.power.hub`/`.port` or `.baseUrl`. The legacy `hw.stlinkSerial`, `hw.uart` and `hw.power.relayIndex` still work.

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
thub-client register [--name client] [--type hw]   # add/update an instance (see "Several DUT slots")
thub-client deregister [--name client]             # remove it
thub-client lock --reason "debugging I2C"   # -> BUSY (source=local)
thub-client unlock                           # -> IDLE
thub-client status
thub-client stop      # SIGTERM; graceful, bounded shutdown
thub-client restart   # stop, then start a new daemon with the same config
```

Run these as the user the Client runs as, not under `sudo` (which would look for `client.json` in root's home). `stop`/`restart` go through the pidfile rather than the control socket, so they work even if the socket is wedged. Stopping is bounded: an idle long-poll is aborted immediately; a running job is killed locally (`SIGTERM`, then `SIGKILL` after a 10s grace period) and reported `ERROR`.

With several instances on one host, target the right one with `--config` before the subcommand:

```bash
thub-client --config ~/.config/thub/dut1.json status
thub-client --config ~/.config/thub/dut1.json lock --reason "debugging I2C"
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

ST-Link via `st-flash`/`openocd`, UART via the `serialport` npm package, optional power cycling via `uhubctl` or a networked relay board's REST API (`hw.power.method: "relay"` — a **stub**, `src/relay-client.js`, pending the real board's API spec). Stable device paths come from udev rules (`/dev/dut<N>-uart`, `/dev/dut<N>-usb`, `/dev/dut<N>-stlink`, N = 1–8). The job's firmware is flashed through the first ST-Link; every device is passed to the test runner as `THUB_DUT_UART_<n>`/`THUB_DUT_USB_<n>`/`THUB_DUT_STLINK_<n>`.

### SW executor

Runs the emulator (e.g. Renode, QEMU) in Docker via `dockerode`, one container per job, isolated network, always removed in teardown. The emulator's virtual UART is exposed as a TCP port the test runner connects to via `THUB_DUT_HOST`.

## Development

```bash
npm install
npm run lint
```

## License

Proprietary — see the header comment in each source file.
