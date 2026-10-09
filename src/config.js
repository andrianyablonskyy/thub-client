/**
 * @file        packages/client/src/config.js
 * @description Client config resolution: JSON config loading, per-instance path defaults, clientId (README §8.6)
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

const fs = require('node:fs'),
  {
    validateClientConfig, shareableClientConfigFile, importClientConfigFile, hwDevicesOf, HW_DEVICES_SECTION
  } = require('@andrian.yablonskyy/thub-common'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');

// User-level default (§13) — consulted when neither --config nor
// THUB_CLIENT_CONFIG is set, before falling back to the bundled default
// below. A specific instance (dut0, dut1, ...) still always needs an
// explicit --config/THUB_CLIENT_CONFIG pointing at its own file — this is
// only ever the fallback for the single default/no-flag case, same as it
// was when that fallback was the fixed path /etc/thub/dut0.json.
const USER_CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'client.json'),

  // Bundled with the package as a working example; a real Client overrides
  // it with THUB_CLIENT_CONFIG or ~/.config/thub/client.json (§13).
  PACKAGE_DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json'),

  // Upper bound on each HW device list (hw.uarts/usbs/stlinks) and on
  // Client instances per host — matching the dut1..dut8 symlink naming
  // (udev.js, §8.2, §8.6).
  MAX_SLOTS = 8,

  // Entries per hw-devices list: two per board fit (a UART adapter and the
  // board's own USB serial port, both in `uarts`, README §8.6).
  MAX_DEVICES_PER_LIST = 16;

// Matches README.md §13 (~/.config/thub/client.json). `overrides.name` (the
// daemon's --name, when started by hand with one) wins over the file's
// `name`, which in turn defaults to the config file's basename — the
// systemd instance name, as the unit passes only --config.
function findConfigFile(configPath){
  const candidate = [configPath, USER_CONFIG_PATH, PACKAGE_DEFAULT_CONFIG_PATH].find(
    (p) => p && fs.existsSync(p)
  );
  if (!candidate){
    throw new Error(
      'Client config not found (set THUB_CLIENT_CONFIG, or create ~/.config/thub/client.json)'
    );
  }
  return candidate;
}

// Per-instance defaults derived from the config file's own name (e.g.
// dut3.json -> dut3.token / dut3.sock / dut3.pid), so several Client
// instances on one host don't collide on a shared default path — each
// still overridable explicitly for non-standard layouts.
function instanceName(configFile){
  return path.basename(configFile, path.extname(configFile));
}

function loadConfig(configPath = process.env.THUB_CLIENT_CONFIG, overrides = {}){
  const candidate = findConfigFile(configPath),
    raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) || {},
    instance = instanceName(candidate),

    // Default to a directory under the current working directory — always
    // writable, on every platform, with zero setup — rather than an FHS
    // system path. That used to be the reverse (defaulting to /var/lib/thub
    // and /run/thub, the systemd-deployment paths, §8.5) and every new
    // path-based config field added since kept inheriting the same bug: it
    // worked under systemd (which grants exactly those two directories via
    // ReadWritePaths=/var/lib/thub and RuntimeDirectory=thub) and failed
    // everywhere else — worst of all on macOS, where /run doesn't exist at
    // all. A systemd deployment now sets `varDir`/`runDir` explicitly in its
    // /etc/thub/dut<N>.json (§8.6) to opt *into* the FHS paths, instead of
    // every other environment needing to opt *out* of them.
    varDir = raw.varDir || path.join(process.cwd(), '.data'),
    runDir = raw.runDir || varDir,

    // `hw-devices`, checked against the shared schema (an HW Client's; an
    // SW Client has no settings of its own).
    hw = resolveHwConfig(hwSection(raw), raw.type),

    config = {
      coordinatorUrl: raw.coordinatorUrl,
      name: overrides.name || raw.name || instance,
      // Names this instance's udev rule file (udev.js, 99-thub-<instance>.rules).
      instance,
      type: raw.type,
      labels: raw.labels || [],
      // Which resource group(s) this Client belongs to (README §13.1) — a
      // job can be constrained with `thub run --group <id>` to only run on
      // resources in a given group. A resource can be in several at once.
      groups: raw.groups || [],
      // Shared secret that lets this Client self-register with no admin
      // action on the Coordinator side (see daemon.js _ensureRegistered).
      joinKey: process.env.THUB_CLIENT_JOIN_KEY || raw.joinKey || '',
      tokenFile: raw.tokenFile || path.join(varDir, `${instance}.token`),
      workDir: raw.workDir || path.join(varDir, 'work', instance),
      socketPath: raw.socketPath || path.join(runDir, `${instance}.sock`),
      pidFile: raw.pidFile || path.join(runDir, `${instance}.pid`),
      // Filename is literally .client-id; lives under a per-instance dir (not
      // varDir directly) so 8 Client instances on one host don't share one.
      clientIdFile: raw.clientIdFile || path.join(varDir, instance, '.client-id'),
      // Written when the Coordinator asks for a self-update; host-wide, and
      // watched by the root thub-client-update.path unit (README §10.2).
      updateRequestFile: raw.updateRequestFile || path.join(varDir, 'update-request.json'),
      // Created by the root update helper next to the request while an
      // update is being applied: no instance takes new jobs meanwhile.
      updateHoldFile: raw.updateHoldFile || path.join(varDir, 'update-hold.json'),
      // Scheduled host reboot (README §10): this instance's schedule as last
      // sent by the Coordinator, and the host-wide request the root
      // thub-client-reboot.path unit watches.
      rebootScheduleFile: raw.rebootScheduleFile || path.join(varDir, instance, 'reboot-schedule.json'),
      // The dashboard config revision (Config tab) this instance has applied.
      configRevisionFile: raw.configRevisionFile || path.join(varDir, instance, 'config-revision.json'),
      rebootRequestFile: raw.rebootRequestFile || path.join(varDir, 'reboot-request.json'),
      hw,
      heartbeatIntervalSec: raw.heartbeatIntervalSec || 10,
      longPollWaitSec: raw.longPollWaitSec || 30,
      configPath: candidate
    };

  if (!config.coordinatorUrl || !config.type){
    throw new Error('Client config requires coordinatorUrl and type');
  }

  // The Coordinator identifies this Client by this id (registry.registerAuto,
  // §5.1), not by `name` — so `name`/`type`/`labels` can all be freely
  // changed in this config and the Coordinator updates the same resource
  // in place on the next restart, instead of registering a new one.
  //
  // An explicit `clientId` (config field, or THUB_CLIENT_ID which wins over
  // it) skips the clientIdFile read-or-create entirely. This is the escape
  // hatch for running several instances that all resolve to the *same*
  // config file and thus the same `instance`/`clientIdFile` default (e.g.
  // both launched from the same cwd against the bundled config.json without
  // --config) — without it they'd read/write the identical .client-id file
  // and collide on one shared identity. `--config`/dutN.json naming already
  // avoids this for the normal one-file-per-instance layout (§8.6); this is
  // for when that's not how the instances are told apart.
  const explicitClientId = (process.env.THUB_CLIENT_ID || raw.clientId || '').trim();
  config.clientId = explicitClientId || readOrCreateClientId(config.clientIdFile);

  return config;
}

// Just what udev.js needs, with none of loadConfig's side effects (it
// creates the .client-id file) — the udev sync runs as root from the
// systemd unit's ExecStartPre=+, before the daemon runs as its own user,
// and must not leave root-owned files in that user's state directory.
function loadDeviceConfig(configPath = process.env.THUB_CLIENT_CONFIG){
  const candidate = findConfigFile(configPath),
    raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) || {};
  return { instance: instanceName(candidate), type: raw.type, hw: resolveHwConfig(hwSection(raw), raw.type) };
}

function readOrCreateClientId(clientIdFile){
  try {
    const id = fs.readFileSync(clientIdFile, 'utf8').trim();
    if (id){
      return id;
    }
  }
  catch {
    // fall through to generate one
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(clientIdFile), { recursive: true });
  fs.writeFileSync(clientIdFile, id + '\n', { mode: 0o600 });
  return id;
}

// udev symlinks are named 1-based (dut1..dut8).
function assertDeviceIndex(field, index){
  if (!Number.isInteger(index) || index < 1 || index > MAX_SLOTS){
    throw new Error(`${field} must be an integer 1-${MAX_SLOTS}, got ${index}`);
  }
}

// Symlink format (udev.js): /dev/thub/dut<N>-uart|usb|stlink.
function devicePath(index, kind){
  return `/dev/thub/dut${index}-${kind}`;
}

const LIST_FIELDS = ['uarts', 'usbs', 'stlinks'],
  // Device list entries as the schema and the dashboard see them: always
  // objects — the shorthand forms (a udev index number, a path string)
  // spelled out.
  asDeviceObjects = (list) => (Array.isArray(list) ? list : []).map((e) =>
    typeof e === 'number' ? { index: e } : typeof e === 'string' ? { path: e } : e);

function assertListSize(field, list){
  if (!Array.isArray(list)){
    throw new Error(`${field} must be an array`);
  }
  if (list.length > MAX_DEVICES_PER_LIST){
    throw new Error(`${field} supports at most ${MAX_DEVICES_PER_LIST} entries, got ${list.length}`);
  }
}

// Each entry is a udev index (number), an explicit path (string), or an
// object with `index` or `path` (an explicit path always wins). ST-Link
// entries may instead give the probe's `serial` directly, skipping the
// udev lookup hw.js otherwise does to find it from the path. An object
// with `devpath` (plus optional vendorId/productId/subsystem) also gets a
// udev rule creating its `path` symlink on Client start (udev.js).
function resolveDeviceList(field, list, kind){
  assertListSize(field, list);
  return list.map((entry, i) => {
    const item = typeof entry === 'number' ? { index: entry } : typeof entry === 'string' ? { path: entry } : entry;
    if (!item || typeof item !== 'object'){
      throw new Error(`${field}[${i}] must be an index, a path or an object`);
    }
    if (item.path || (kind === 'stlink' && item.serial && item.index === undefined)){
      return item;
    }
    assertDeviceIndex(`${field}[${i}].index`, item.index);
    return { ...item, path: devicePath(item.index, kind) };
  });
}

// §8.2/§8.6: up to MAX_DEVICES_PER_LIST each of UART adapters (or boards'
// own USB serial ports), DUT USB devices and ST-Link probes per Client. An
// HW Client's section is checked against the shared schema first (shorthand
// entries spelled out): a field it doesn't know stops the start, named.
// The `hw-devices` section; an HW Client's file that still says `hw` would
// otherwise start with no devices at all.
function hwSection(raw){
  if (raw.type === 'hw' && raw.hw !== undefined){
    throw new Error(`the \`hw\` section is named \`${HW_DEVICES_SECTION}\` now: rename it`);
  }
  return hwDevicesOf(raw) || {};
}

function resolveHwConfig(hw, type = 'hw'){
  if (type === 'hw'){
    const spelledOut = Object.fromEntries(Object.entries(hw).map(([k, v]) =>
        [k, LIST_FIELDS.includes(k) && Array.isArray(v) ? asDeviceObjects(v) : v])),
      { valid, errors } = validateClientConfig('hw', spelledOut);
    if (!valid){
      throw new Error(errors.join('; '));
    }
  }
  return {
    ...hw,
    uarts: resolveDeviceList(`${HW_DEVICES_SECTION}.uarts`, hw.uarts || [], 'uart'),
    usbs: resolveDeviceList(`${HW_DEVICES_SECTION}.usbs`, hw.usbs || [], 'usb'),
    stlinks: resolveDeviceList(`${HW_DEVICES_SECTION}.stlinks`, hw.stlinks || [], 'stlink')
  };
}

// ---- Capabilities edited from the dashboard (README §10, Config tab) ----

// The editable part of this Client's config: an HW Client's hw-devices as
// in the file, its shorthand entries spelled out; an SW Client's is empty.
// Reported at registration.
function readEditableConfig(configPath, type){
  if (type !== 'hw'){
    return {};
  }
  const section = hwDevicesOf(JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}) || {};
  return {
    ...section,
    stlinks: asDeviceObjects(section.stlinks),
    uarts: asDeviceObjects(section.uarts),
    usbs: asDeviceObjects(section.usbs)
  };
}

// The config file as reported to the Coordinator (for the dashboard's
// Export), never with the joinKey.
function readShareableConfigFile(configPath){
  const { joinKey, ...file } = shareableClientConfigFile(JSON.parse(fs.readFileSync(configPath, 'utf8')) || {});
  return file;
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== '').map((k) => [k, obj[k]]));

// Applies a dashboard edit to the config file: validated (the shared schema,
// then exactly as loadConfig would resolve it) and written atomically — an
// HW Client's devices under `hw-devices`. Throws with a
// readable reason if it can't be applied. `fields`: an Import's other
// top-level fields — filtered here again (never joinKey, coordinatorUrl,
// name, this Client's id or paths). `identity`: { coordinatorUrl, name,
// type, joinKey? } the running Client uses, written into the file as they
// are, so a restart comes back with the same ones.
function applyEditableConfig(configPath, type, section, fields = null, identity = null){
  const { valid, errors } = validateClientConfig(type, section);
  if (!valid){
    throw new Error(errors.join('; '));
  }
  let raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  if (fields){
    const checked = importClientConfigFile(type, fields);
    if (!checked.valid){
      throw new Error(checked.errors.join('; '));
    }
    raw = { ...raw, ...checked.fields };
  }
  if (type === 'hw'){
    resolveHwConfig({ ...section }); // throws where loadConfig would
  }
  const pinned = { ...raw, ...(identity ? pick(identity, ['coordinatorUrl', 'name', 'type', 'joinKey']) : {}) },
    next = type === 'hw' ? { ...pinned, [HW_DEVICES_SECTION]: section } : pinned,
    mode = fs.statSync(configPath).mode & 0o777,
    tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode });
  fs.renameSync(tmp, configPath);
}

function readAppliedConfigRevision(file){
  try {
    const { revision, error } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { revision: Number.isInteger(revision) ? revision : 0, error: error || null };
  }
  catch {
    return { revision: 0, error: null };
  }
}

function writeAppliedConfigRevision(file, revision, error = null){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ revision, error, at: new Date().toISOString() }) + '\n');
}

// Stored as JSON so a restarted daemon knows its resourceId without
// needing an API call it isn't authorized to make (resource tokens can
// only act on their own resource, §12).
function readCredentials(tokenFile){
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  }
  catch {
    return null;
  }
}

function writeCredentials(tokenFile, { resourceId, resourceToken }){
  fs.mkdirSync(require('node:path').dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ resourceId, resourceToken }), { mode: 0o600 });
}

module.exports = {
  readShareableConfigFile,
  loadConfig,
  loadDeviceConfig,
  readEditableConfig,
  applyEditableConfig,
  readAppliedConfigRevision,
  writeAppliedConfigRevision,
  readCredentials,
  writeCredentials
};
