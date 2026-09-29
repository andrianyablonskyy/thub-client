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
- install `/etc/systemd/system/thub-client@.service`, rendered for that user: `User=`/`Group=`, `SupplementaryGroups=` whichever of `dialout`, `plugdev` and `docker` exist on the host, `THUB_CLIENT_CONFIG=~/.config/thub/%i.json`, the state directory as `WorkingDirectory=`/`ReadWritePaths=`, and `ExecStart` pointing at this install's real `node`/`daemon.js` (works with `apt`-installed Node, `nvm` or any npm prefix) with `--name %i`, so each instance registers under its own instance name, plus an `ExecStartPre=+` that generates the instance's udev rules as root on every start (see "udev rules" below);
- install and enable `thub-client-update.path`/`.service`, the root helper that applies self-updates requested from the Coordinator (see "Updates" below);
- on a **fresh machine** only (no `thub-client@*` instance set up before), enable and start `thub-client@client` once `client.json` is filled in. On an already set-up host an install never enables or starts the default instance; it only restarts the instances already running, so an upgrade takes effect immediately.

On a fresh install the service isn't started yet — the daemon would exit at once with blank required fields. Fill in the config, then start it (below).

## Ubuntu 26.04 host setup

```bash
sudo apt install -y nodejs npm stlink-tools openocd
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

Every install step is best-effort and never fails the `npm install` itself, and only runs for an actual global install (`npm install -g`) — a plain local `npm install` (e.g. in a dev checkout, or as root inside a CI/Docker image, which is common) never touches `/etc/systemd`, `~/.config/thub` or `~/var/lib/thub`. A global install without root, or on a non-Linux machine, still creates the directories and `client.json` for the current user, but skips systemd and prints the `sudo npm i -g` command to run instead.

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

**Running several Clients on one host** — start one daemon process per config file, each pointed at its own `dutN.json`; every default path (`tokenFile`, `workDir`, `socketPath`, `pidFile`, `clientIdFile`) is already namespaced by the config file's own basename, so up to 8 instances (`dut0`..`dut7`, one per UART/ST-Link) coexist with zero extra setup:

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
| `artifactory.allowedArtifactPrefixes` | No | `[]` | Artifactory URL prefixes: downloads from here get the Artifactory token. |
| `sources.allowedPrefixes` | No | `[]` | Other places a job's `--download-file` files and `--git-repo` may come from (`"*"` = any), never with the token. A URL under neither list is refused; with both empty, anything is allowed (with the token). |

**Capabilities.** At every registration (each start/restart) the Client reports what this config lets it drive: for HW each `hw.stlinks`/`uarts`/`usbs` device (path, ST-Link serial, UART baud rate, and whether the device node exists right now); for SW the image, its source and the CPU/memory limits. The Coordinator's resource card lists them and flags a configured device that's missing. After plugging in or moving an adapter, restart the instance to refresh them.

**Heartbeats** (every `heartbeatIntervalSec`) report the state, the host's network addresses, the host's uptime and the current activity (idle, running a job until it's fully finished including uploads, locked locally, or held for a self-update) with its duration — shown on the Coordinator's resource card.

**SW-only** (`type: sw`): `sw.image` (required — a plain repository name like `dut-emulator:2026.08`), `sw.registry` (local registry `host[:port]`), `sw.registryAuth` (`{ username, passwordFile | password }`), `sw.allowDockerHub` (default `false`), `sw.cpus` (default 2), `sw.memory` (default `2g`).

The image is looked up in order: `sw.registry` first, then Docker Hub only if `sw.allowDockerHub` is `true`, and if neither has it the job fails with the reason for each source. An image already cached on the host counts for its source. An image that names its own registry host (`other.example.com/emu:1`) is pulled from that host only. A plain-HTTP registry must also be in the Docker daemon's `insecure-registries`.

**HW-only** (`type: hw`): up to 8 each of `hw.stlinks`, `hw.uarts`, `hw.usbs` (entries: udev index 1–8 → `/dev/thub/dut<N>-stlink|uart|usb`, a path, or `{ index | path, ... }`; ST-Link entries may give `serial`, UARTs `baudRate`; any of them `devpath` plus optional `vendorId`/`productId`/`subsystem` to get a udev symlink rule). The legacy `hw.stlinkSerial` and `hw.uart` still work. Power control from older versions (`hw.relays`, `hw.power`) is ignored.

Example SW config:

```json
{
  "coordinatorUrl": "https://thub.example.com",
  "name": "lab-sw-01",
  "type": "sw",
  "joinKey": "<same value as the Coordinator's clientJoinKey>",
  "artifactory": { "tokenFile": "/etc/thub/artifactory.token" },
  "sw": { "image": "dut-emulator:2026.08", "registry": "registry.lab.local:5000", "allowDockerHub": false, "cpus": 2, "memory": "2g" }
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

## Updates

```bash
thub-client check-update                 # installed vs latest published version
thub-client self-update [--to <x.y.z>]   # sudo npm i -g; restarts every running instance
```

A Client updates only when an admin requested it (Coordinator dashboard: per resource or **Update all clients**) **and** it isn't running a job. A job counts as running until it's completely finished, including the artifact upload, the result and the final log flush. The Coordinator sends a `self-update` command in the heartbeat response. The daemon runs sandboxed as an unprivileged user, so it only writes `<varDir>/update-request.json`, once per version and only while idle with no local lock. The root `thub-client-update.path` unit, installed and enabled by `sudo npm i -g`, starts `thub-client-update.service`, which:
1. creates `<varDir>/update-hold.json`. While it exists no instance on the host takes a new job, and each shows on the Coordinator as busy (`local — self-update in progress`), so jobs submitted meanwhile stay queued;
2. waits 45 s so a job handed out just before the hold is visible, then waits (up to 24 h) until no instance has a job running or a manual lock;
3. runs `npm i -g @andrian.yablonskyy/thub-client@<version>` for the Client's user. That restarts every instance on the new version;
4. removes the hold, also on failure or `systemctl stop`. A hold older than 2 h is ignored.

An admin can abort it until the moment it installs with **Cancel** on the Coordinator's resource card: the Client deletes the hold and the helper stops without installing. The same button cancels the Client's running job (aborting a download in progress) or releases a manual local lock.

It only ever installs `thub-client`, at a strictly validated version. Logs: `journalctl -u thub-client-update`.

## Job execution lifecycle

1. Receive the job from long-poll and `accept` it.
2. Create a fresh workspace `<workDir>/<jobId>`.
3. **Log in to the job's registry**, if its `--env` has `DOCKER_REGISTRY`, `DOCKER_USERNAME` and `DOCKER_PASSWORD`: `echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USERNAME" --password-stdin`, into `<workDir>/<jobId>/docker` (mode `0700`) — a Docker config of the job's own, never the service user's. A failed login ends the job as ERROR.
4. **Prepare the task's inputs**: clone `--git-repo` into `work/` at its ref and depth (else an empty `work/`), and download every `--download-file` into `downloads/`.
5. **Prepare** the DUT through the executor: HW resolves ST-Link serials and captures UARTs (nothing is flashed — the command does that); SW starts the DUT container (`--docker-image` or `sw.image`, downloads at `/downloads`), pulled with the job's registry login when it comes from `DOCKER_REGISTRY`.
6. **Run** the job's `--command` with `sh -c` in `work/`, `--arg` values as `"$@"`, and the environment: the job's `--env` variables, `DOCKER_CONFIG` (after a registry login), `THUB_DUT_*`, `THUB_DOWNLOAD_<n>`/`THUB_DOWNLOADS_DIR`/`THUB_DOWNLOADS`, `THUB_GIT_COMMIT`, `THUB_JOB_ID`, `THUB_SUITE`, `THUB_WORK_DIR`, one `THUB_META_<KEY>` per job metadata field. Its exit code is the verdict.
7. Collect results: everything in `work/results/` and `work/artifacts/`, plus `flash.log` / `console.log`. JUnit XML among them is summed into the job's `summary` (total/passed/failed/skipped). The verdict stays the exit code.
8. Upload artifacts, post the result, delete the workspace (the registry login with it), report `IDLE`.

The job's `--env` variables are set for **every** command above — the git commands of step 4, the login, the DUT setup, `--command` — on top of the service's own environment. `THUB_*`, `GIT_TERMINAL_PROMPT`, `GIT_ALLOW_PROTOCOL` and `DOCKER_CONFIG` can't be set this way. The values come from the Coordinator with the job, and the Client never logs them: the login line shows the registry and user, not the password.

**Docker from the command.** The command runs on the Client host, as the service user. To run tests inside an image it starts the container itself (`docker run --rm -v "$THUB_WORK_DIR:/work" -w /work <image> …`, logged in through `DOCKER_CONFIG`), which needs Docker on the host and the service user in the `docker` group. SW hosts are set up that way (see *Ubuntu 26.04 host setup*); an HW host needs it added. Examples: the Agent README, *Docker*.

A cancel command or job timeout sends `SIGTERM` to the test process group, waits 10s, then `SIGKILL`, and always runs executor teardown. If `spec.dryRun` is set, nothing is executed. Instead the job's log lists every command the real job would run on this Client, in full and in order: the job's `--env` (secret-looking values masked), the registry login, each git command with its `--git-options`, the downloads, the DUT setup, and `cd <work> && sh -c …` with its environment. It adds `WOULD FAIL:` lines for anything this Client's config would refuse.

### HW executor

ST-Link via `st-flash`/`openocd`, UART via the `serialport` npm package. Stable device paths (`/dev/thub/dut<N>-uart`, `/dev/thub/dut<N>-usb`, `/dev/thub/dut<N>-stlink`, N = 1–8) come from udev rules the Client generates from its own config.

**udev rules.** No udev setup at install time. On every start the Client writes `/etc/udev/rules.d/99-thub-<instance>.rules` from the `hw.stlinks`/`hw.uarts`/`hw.usbs` entries that have a `devpath` (the USB port path, `ATTRS{devpath}` in `udevadm info -a -n <device>`). It then reloads udev, re-triggers `usb`/`tty` devices and waits for them to settle, but only when the file actually changes. Defaults per kind: ST-Link `0483:3748` on `usb`, UART `0403:6001` on `tty`, USB `0483:5740` on `usb`; override them per entry with `vendorId`/`productId`/`subsystem`. Under systemd, the unit's `ExecStartPre=+` does this as root. Preview the rules with `thub-client [--config <path>] udev --print`, and apply them without a restart with `sudo thub-client [--config <path>] udev`. Upgrading from ≤ 1.0.17: move each `ATTR{devpath}` from the old `/etc/udev/rules.d/99-thub.rules` into the matching config entry, then delete that file. Nothing is flashed by the Client: the job's `--command` does it, with every device in its environment as `THUB_DUT_UART_<n>`/`THUB_DUT_USB_<n>`/`THUB_DUT_STLINK_<n>` (ST-Links by serial; `THUB_DUT_STLINK` = the first).

### SW executor

Runs the job's own image (`--docker-image`, if `sw.allowJobImages`) or else `sw.image` (with `sw.cmd`, if set) as the DUT, the job's downloads mounted read-only at `/downloads`; with neither, the command runs without a container. Pulls from the local registry (`sw.registry`), then Docker Hub if `sw.allowDockerHub`, else fails (see "Configuration reference"). Runs the emulator (e.g. Renode, QEMU) in Docker via `dockerode`, one container per job, isolated network, always removed in teardown. The emulator's virtual UART is exposed as a TCP port the test runner connects to via `THUB_DUT_HOST`.

## Development

```bash
npm install
npm run lint
```

## License

Proprietary — see the header comment in each source file.
