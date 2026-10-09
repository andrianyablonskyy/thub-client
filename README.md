# @andrian.yablonskyy/thub-client

The Client (`thub-client`) component of [TestHub](https://github.com/andrianyablonskyy/thub) — a self-hosted job network that lets CI/CD pipelines and individual developers run firmware tests on real hardware or emulators in a private lab. This is the daemon that runs on lab machines, executes test jobs against a DUT, streams logs back, and uploads results. It owns exactly one DUT slot per process — a machine with two boards runs two instances with different configs.

Clients only make **outbound** connections to the [Coordinator](https://github.com/andrianyablonskyy/thub-coordinator) — nothing in the lab needs to be exposed. 

## Install

```bash
sudo npm i -g @andrian.yablonskyy/thub-client
```

That one command is the complete installation. Run as root on Linux, for the user who ran `sudo` (`SUDO_USER` — not root; that user owns every file and runs the service), the package's postinstall scripts:

- create `~/.config/thub` and `~/var/lib/thub/client` (with `work/`) — the state directory for tokens, client ids, job workspaces, control sockets and pidfiles;
- create `~/.config/thub/client.json` (0600) if it doesn't exist yet, with blank `coordinatorUrl`/`joinKey`, `type: hw` and `varDir` pointing at the state directory — a re-install/upgrade never overwrites it;
- install `/etc/systemd/system/thub-client@.service`, rendered for that user: `User=`/`Group=`, `SupplementaryGroups=` whichever of `dialout`, `plugdev` and `docker` exist on the host, `THUB_CLIENT_CONFIG=~/.config/thub/%i.json`, the state directory as `WorkingDirectory=`/`ReadWritePaths=`, and `ExecStart` pointing at this install's real `node`/`daemon.js` (works with `apt`-installed Node, `nvm` or any npm prefix) with `--config ~/.config/thub/%i.json`, plus an `ExecStartPre=+` that generates the instance's udev rules as root on every start (see "udev rules" below);
- install and enable `thub-client-update.path`/`.service`, the root helper that applies self-updates requested from the Coordinator (see "Updates" below);
- on a **fresh machine** only (no `thub-client@*` instance set up before), enable and start `thub-client@client` once `client.json` is filled in. On an already set-up host an install never enables or starts the default instance; it only restarts the instances already running, so an upgrade takes effect immediately.

On a fresh install the service isn't started yet — the daemon would exit at once with blank required fields. Fill in the config, then start it (below).

## Ubuntu 26.04 host setup

```bash
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo tee /etc/apt/keyrings/nodesource.asc >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install -y nodejs   # Node.js 24 (Ubuntu's own is 22); includes npm
sudo apt install -y stlink-tools openocd
# Docker — SW Clients, and HW Clients whose jobs run docker in --command.
# Install it before thub-client so the service gets the docker group
# (re-run the npm i -g below if you add it later). The resource card's
# Capabilities show whether a Client can use it, and why not.
sudo apt install -y docker.io

sudo npm i -g @andrian.yablonskyy/thub-client

# coordinatorUrl, type and joinKey (the Coordinator's clientJoinKey);
# see "Configuration reference" below for every field
nano ~/.config/thub/client.json

sudo systemctl enable --now thub-client@client
journalctl -u thub-client@client -f
```

The service is started as `thub-client@<instance>.service`. The instance name selects the config file (`thub-client@<instance>` reads `~/.config/thub/<instance>.json`). The Client registers under that file's `name`, or the instance name when the file has none, so the default `thub-client@client` registers as `client`. When a config is applied from the dashboard, the Client writes the `coordinatorUrl`, `name`, `type` and `joinKey` it's running with into the file first. However it's restarted afterwards, it comes back as the same resource. A `joinKey` given in `THUB_CLIENT_JOIN_KEY` stays in the environment and isn't written.

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
| `heartbeatIntervalSec` | No | `10` | How often the daemon heartbeats until the Coordinator says otherwise: it sends its `heartbeat.intervalSec` at registration and in every heartbeat reply, and the Client follows it from then on (a change on the Coordinator's dashboard reaches it within one heartbeat). Only an older Coordinator that sends none leaves this value in charge. |
| `longPollWaitSec` | No | `30` | How long each job long-poll waits before returning `204`. |

**Capabilities.** At every registration (each start/restart) the Client reports what this config lets it drive: for HW each `hw-devices.stlinks`/`uarts`/`usbs` device (path, ST-Link serial, UART baud rate, and whether the device node exists right now); for SW the image, its source and the CPU/memory limits. The Coordinator's resource card lists them and flags a configured device that's missing. After plugging in or moving an adapter, restart the instance to refresh them.

**Heartbeats** (every `heartbeat.intervalSec` of the Coordinator) report the state, the host's network addresses, the host's uptime and the current activity (idle, running a job until it's fully finished including uploads, locked locally, or held for a self-update) with its duration — shown on the Coordinator's resource card.

**SW Clients** (`type: sw`) have no settings of their own: an SW job is its command. The Client never pulls images or starts containers and doesn't need Docker or git; a job's command does whatever it needs, with credentials passed as `--env`. An older file's `sw` section is ignored.

**HW Clients** (`type: hw`): the `hw-devices` section, checked against its schema at start — up to 16 each of `stlinks`, `uarts`, `usbs` (entries: udev index 1–8 → `/dev/thub/dut<N>-stlink|uart|usb`, a path, or `{ index | path, ... }`; ST-Link entries may give `serial`, UARTs `baudRate` and `label`; any of them `devpath` plus optional `vendorId`/`productId`/`subsystem` to get a udev symlink rule). The Client fetches a job's `--download-file` files from wherever the job says, without credentials of its own.

Example SW config:

```json
{
  "coordinatorUrl": "https://thub.example.com",
  "name": "lab-sw-01",
  "type": "sw",
  "joinKey": "<same value as the Coordinator's clientJoinKey>"
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
thub-client power on|off|reset|status [--port <n>] [--delay <sec>]   # USB port power with uhubctl (hw-devices.usbPower)
```

**USB port power.** Install `uhubctl` (`sudo apt install uhubctl`) and find each DUT's hub and port with `sudo uhubctl`. The hub's location is the word after `hub`, and the port is the number after `Port`:

```
Current status for hub 1-1.4 [2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps]
  Port 2: 0103 power enable connect [0483:3748 STMicroelectronics STM32 STLink 066DFF485457725187092834]
```

List them in the config, up to 8. `--port` takes a port's position in this list, starting at 1:

```json
"hw-devices": { "usbPower": { "ports": [{ "hub": "1-1.4", "port": 2 }, { "hub": "1-1.4", "port": 3 }] } }
```

Restart the Client: it installs a udev rule that lets the `plugdev` group switch hub ports. Then:

```bash
thub-client power status                     # 1. hub 1-1.4 port 2: on  (Port 2: 0103 power enable connect [...])
thub-client power reset                      # every port: off, 1 s, on
thub-client power reset --port 2 --delay 3   # hub 1-1.4 port 3 only, 3 s off
thub-client power off --port 1
```

From the Agent, a job can switch them at its start and end (`thub run --power-on-start reset --power-on-end off`), and its owner can switch them while it runs (`thub power reset <jobId>`). Each action is recorded in the job's log. Setup, examples and troubleshooting are in the main README, §8.7.

**Serial ports in the log.** Every entry in `uarts` (USB-UART adapters, and boards' own USB serial ports with `"subsystem": "tty"` and the board's USB id) is captured for the whole job into the `uart` stream. With more than one, each line is tagged with the port's `label` or its device's name (`[dut2-usb] …`). A port that disappears, such as a board's USB serial port while the board resets after flashing, is reopened as soon as it's back. One not there at the start is waited for, and the log says so. A worked example with five boards (ST-Links, FT232RL adapters and the boards' own USB) on one 15-port hub is in the main README, §8.6 (*Five boards on one Client*).

**Test results.** After every job, the Client sums the JUnit XML in `results/` or `artifacts/` (in the work directory, or one folder down) into the job's test counts. GoogleTest's and CTest's disabled tests count as skipped. Jobs that drive the board from the host (pytest with pyserial, say) must use a port the Client doesn't capture: a UART in `hw-devices.uarts` is held open for the whole job, and a second open fails with *Device or resource busy*. Main README, §7.6.

**Private CA.** If `--download-file` URLs (or the Coordinator) use a certificate from a lab or company CA, give the Client the CA. Node.js doesn't read the system store:

```bash
sudo systemctl edit thub-client@.service      # [Service]
                                              # Environment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/lab-ca.crt
sudo systemctl restart 'thub-client@*'
```

`update-ca-certificates` still covers `curl` and `git` in jobs, and Docker reads `/etc/docker/certs.d/<registry>/ca.crt`. A download that needs a *client* certificate can't use `--download-file`: the job fetches it with `curl --cert` (main README, §7.5).

**Smart sockets, PDUs and other devices.** The Client has no driver for these: jobs switch them from their own `--command` or a repository script (main README, §8.8). On the Client host, install the tools those scripts call (`curl`, `sudo apt install snmp`, `pipx install python-kasa`) and check the device answers from the host. Then tell each instance which device is its bench's. Jobs inherit the service's environment:

```bash
sudo systemctl edit thub-client@dut1      # [Service]
                                          # Environment=BENCH_POWER=apc:pdu1.lab:5
sudo systemctl restart thub-client@dut1
```

Every job on that instance can read these variables, so put addresses there and pass credentials with each job's `--env`.

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

A Client updates only when an admin requested it (Coordinator dashboard: per resource or **Update all clients**) **and** it isn't running a job. A job counts as running until it's completely finished, including the result and the final log flush. The Coordinator sends a `self-update` command in the heartbeat response. The daemon runs sandboxed as an unprivileged user, so it only writes `<varDir>/update-request.json`, once per version and only while idle with no local lock. The root `thub-client-update.path` unit, installed and enabled by `sudo npm i -g`, starts `thub-client-update.service`, which:
1. creates `<varDir>/update-hold.json`. While it exists no instance on the host takes a new job, and each shows on the Coordinator as busy (`local — self-update in progress`), so jobs submitted meanwhile stay queued;
2. waits 45 s so a job handed out just before the hold is visible, then waits (up to 24 h) until no instance has a job running or a manual lock;
3. runs `npm i -g @andrian.yablonskyy/thub-client@<version>` for the Client's user. That restarts every instance on the new version;
4. removes the hold, also on failure or `systemctl stop`. A hold older than 2 h is ignored.

An admin can abort it until the moment it installs with **Cancel** on the Coordinator's resource card: the Client deletes the hold and the helper stops without installing. The same button cancels the Client's running job (aborting a download in progress) or releases a manual local lock.

It only ever installs `thub-client`, at a strictly validated version. Logs: `journalctl -u thub-client-update`.

## Job execution lifecycle

1. Receive the job from long-poll and `accept` it.
2. Create a fresh workspace `<workDir>/<jobId>`.
3. **Prepare the task's inputs**: the job directory `<jobId>/` is the work directory (`$THUB_WORK_DIR`); download every `--download-file` into its `downloads/`. Nothing is cloned: a command that needs a repository clones it there itself, into `src/` say.
4. **Prepare** the DUT through the executor: HW resolves ST-Link serials and captures UARTs (nothing is flashed — the command does that); SW has nothing to prepare.
5. **Run** the job's `--command` with `sh -c` in the job directory (`$THUB_WORK_DIR`), `DOCKER_CONFIG` set to its `.docker/`, `--arg` values as `"$@"`, and the environment: the job's `--env` variables, its `thub run` parameters as `JOB_*` (e.g. `JOB_LABEL`, `JOB_SUITE` — the full list: main README §7.4, *Client environment variables*), `THUB_DOWNLOAD_<n>`/`THUB_DOWNLOADS_DIR`/`THUB_DOWNLOADS`, `THUB_JOB_ID`, `THUB_WORK_DIR`, one `THUB_META_<KEY>` per job metadata field. Its exit code is the verdict.
6. Read the JUnit XML the tests left in `results/` or `artifacts/` of the job directory, or of a folder in it (`src/results/`), and sum it into the job's `summary` (total/passed/failed/skipped). The verdict stays the exit code.
7. Post the result — with the artifacts the command listed in `$THUB_ARTIFACTS_FILE` (a JSON array of `{name, size, link, timestamp}`), as metadata — delete the workspace, report `IDLE`. **No files are uploaded** besides the log: a job's files exist only in its workspace, which is deleted when the job ends. A job that needs to keep files publishes them itself from its `--command`, e.g. to Artifactory.

The job's `--env` variables are set for the git commands of step 3 and for `--command`, on top of the service's own environment, under whatever names the job chose: nothing in the Client depends on particular names. Only `THUB_*`, `JOB_*`, `GIT_TERMINAL_PROMPT` and `GIT_ALLOW_PROTOCOL` can't be set this way. The values come from the Coordinator with the job, and the Client never logs them.

**Docker from the command.** The command runs on the Client host, as the service user. To run tests inside an image it starts the container itself (`docker run --rm --user "$(id -u):$(id -g)" -v "$THUB_WORK_DIR/src:/work" -w /work <image> …`), after its own `docker login` if the registry needs one — best with `DOCKER_CONFIG="$THUB_WORK_DIR/.docker"`, so the credentials are deleted with the job rather than left in the service user's `~/.docker`, which needs Docker on the host and the service user in the `docker` group. SW hosts are set up that way (see *Ubuntu 26.04 host setup*); an HW host needs it added. Examples: the Agent README, *Docker*.

A cancel command or job timeout sends `SIGTERM` to the test process group, waits 10s, then `SIGKILL`, and always runs executor teardown. If `spec.dryRun` is set, nothing is executed. Instead the job's log lists every command the real job would run on this Client, in full and in order: the job's `--env` names (every value shown as `***`), the downloads, the HW DUT setup, and `cd <work> && sh -c …` with its environment. It adds `WOULD FAIL:` lines for anything this Client's config would refuse.

### HW executor

ST-Link via `st-flash`/`openocd`, UART via the `serialport` npm package. Stable device paths (`/dev/thub/dut<N>-uart`, `/dev/thub/dut<N>-usb`, `/dev/thub/dut<N>-stlink`, N = 1–8) come from udev rules the Client generates from its own config.

**udev rules.** No udev setup at install time. On every start the Client writes `/etc/udev/rules.d/99-thub-<instance>.rules` from the `hw-devices.stlinks`/`hw-devices.uarts`/`hw-devices.usbs` entries that have a `devpath` (the USB port path, `ATTRS{devpath}` in `udevadm info -a -n <device>`). It then reloads udev, re-triggers `usb`/`tty` devices and waits for them to settle, but only when the file actually changes. Defaults per kind: ST-Link `0483:3748` on `usb`, UART `0403:6001` on `tty`, USB `0483:5740` on `usb`; override them per entry with `vendorId`/`productId`/`subsystem`. Under systemd, the unit's `ExecStartPre=+` does this as root. Preview the rules with `thub-client [--config <path>] udev --print`, and apply them without a restart with `sudo thub-client [--config <path>] udev`. Upgrading from ≤ 1.0.17: move each `ATTR{devpath}` from the old `/etc/udev/rules.d/99-thub.rules` into the matching config entry, then delete that file. Nothing is flashed by the Client: the job's `--command` does it, using the devices by their `/dev/thub/dut<N>-…` paths (or `st-flash`'s own probe selection); no device variables are passed to it.

### SW executor

Nothing to prepare or tear down: an SW job is its `--command`, which starts whatever it needs (an emulator in `docker run`, say) and stops it itself. The Client has no Docker dependency.

## Development

```bash
npm install
npm run lint
```

## License

See [LICENSE.md](./LICENSE.md).
