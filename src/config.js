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
    validateClientConfig, publicClientConfig, shareableClientConfigFile, importClientConfigFile, CLIENT_CONFIG_PRIVATE_FIELDS
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

  // Upper bound on each HW device list (hw.uarts/usbs/stlinks/relays) and on
  // Client instances per host — matching the dut1..dut8 symlink naming
  // (udev.js) and a relay board's 8 channels (§8.2, §8.6).
  MAX_SLOTS = 8;

// Matches README.md §13 (~/.config/thub/client.json). `overrides.name` (the
// daemon's --name, which the systemd unit sets to its instance name) wins
// over the file's `name`, which in turn defaults to the config file's
// basename — the same thing as the systemd instance name, so the control
// CLI (which never gets --name) loads a name-less config fine too.
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

    hw = resolveHwConfig(raw.hw || {}),

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
      artifactory: resolveArtifactoryConfig(raw.artifactory || {}),
      // Other places a task's --download-file files and --git-repo may come
      // from — URL prefixes, "*" for any. Never sent the Artifactory token
      // (downloader.js downloadAccess).
      sources: { allowedPrefixes: Array.isArray(raw.sources?.allowedPrefixes) ? raw.sources.allowedPrefixes : [] },
      hw,
      sw: resolveSwConfig(raw.sw || {}),
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
  return { instance: instanceName(candidate), type: raw.type, hw: resolveHwConfig(raw.hw || {}) };
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

function assertSlotIndex(field, index){
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SLOTS){
    throw new Error(`${field} must be an integer 0-${MAX_SLOTS - 1}, got ${index}`);
  }
}

// udev symlinks are named 1-based (dut1..dut8), unlike relay
// channels, which are the relay board's own 0-7 numbering.
function assertDeviceIndex(field, index){
  if (!Number.isInteger(index) || index < 1 || index > MAX_SLOTS){
    throw new Error(`${field} must be an integer 1-${MAX_SLOTS}, got ${index}`);
  }
}

// Symlink format (udev.js): /dev/thub/dut<N>-uart|usb|stlink.
function devicePath(index, kind){
  return `/dev/thub/dut${index}-${kind}`;
}

function assertListSize(field, list){
  if (!Array.isArray(list)){
    throw new Error(`${field} must be an array`);
  }
  if (list.length > MAX_SLOTS){
    throw new Error(`${field} supports at most ${MAX_SLOTS} entries, got ${list.length}`);
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

function resolveRelayList(field, list, defaultBaseUrl){
  assertListSize(field, list);
  return list.map((entry, i) => {
    const item = typeof entry === 'number' ? { channel: entry } : entry;
    assertSlotIndex(`${field}[${i}].channel`, item?.channel);
    return { ...item, baseUrl: item.baseUrl || defaultBaseUrl };
  });
}

// §8.2/§8.6: up to MAX_SLOTS each of UART adapters, DUT USB devices,
// ST-Link probes and relay channels per Client. The single-device fields
// (`uart`, `stlinkSerial`, `power.relayIndex`) are still accepted and fold
// into the matching list when that list isn't set.
function resolveHwConfig(hw){
  const { uart, stlinkSerial, ...rest } = hw,
    power = hw.power || {},
    uarts = hw.uarts || (uart ? [uart] : []),
    stlinks = hw.stlinks || (stlinkSerial ? [{ serial: stlinkSerial }] : []),
    relays = hw.relays || (power.relayIndex !== undefined ? [{ channel: power.relayIndex }] : []);

  return {
    ...rest,
    uarts: resolveDeviceList('hw.uarts', uarts, 'uart'),
    usbs: resolveDeviceList('hw.usbs', hw.usbs || [], 'usb'),
    stlinks: resolveDeviceList('hw.stlinks', stlinks, 'stlink'),
    relays: resolveRelayList('hw.relays', relays, power.baseUrl)
  };
}

// §8.3: where the SW executor gets `sw.image` from, in order — the lab's
// own registry (`registry`, host[:port]; an http(s):// prefix is dropped,
// Docker picks the scheme), then Docker Hub only if `allowDockerHub` is
// true. Registry credentials follow the Artifactory token's pattern: the
// password comes from a file, not the config itself.
function resolveSwConfig(sw){
  const registry = typeof sw.registry === 'string' ? sw.registry.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') : '',
    auth = sw.registryAuth;
  let registryAuth = null;
  if (registry && auth?.username){
    let password = auth.password || '';
    if (!password && auth.passwordFile){
      try {
        password = fs.readFileSync(auth.passwordFile, 'utf8').trim();
      }
      catch (err){
        throw new Error(`sw.registryAuth.passwordFile: ${err.message}`);
      }
    }
    registryAuth = { username: auth.username, password, serveraddress: registry };
  }
  // allowJobImages: run a job's own Docker image (`thub run --type sw
  // --docker-image alpine`, spec `image`) instead of sw.image. Off by default:
  // it lets anyone with an agent token pick the DUT image this host runs (in
  // the usual sandboxed container). Reported to the Coordinator, which only
  // schedules such jobs here when it's on. cmd: the container command for
  // sw.image (e.g. ["--firmware", "/downloads/app.bin"]); default: the image's own.
  if (sw.cmd !== undefined && !(Array.isArray(sw.cmd) && sw.cmd.every((a) => typeof a === 'string'))){
    throw new Error('sw.cmd must be an array of strings');
  }
  return {
    ...sw,
    registry: registry || null,
    allowDockerHub: sw.allowDockerHub === true,
    allowJobImages: sw.allowJobImages === true,
    registryAuth
  };
}

// §13: the Client's read-only Artifactory token lives in its own file
// (tokenFile), never inline in config or passed through the Coordinator (§12).
function resolveArtifactoryConfig(artifactory){
  if (artifactory.token || !artifactory.tokenFile){
    return artifactory;
  }
  try {
    return { ...artifactory, token: fs.readFileSync(artifactory.tokenFile, 'utf8').trim() };
  }
  catch {
    return artifactory;
  }
}

// ---- Capabilities edited from the dashboard (README §10, Config tab) ----

// Device list entries as the dashboard sees them: always objects — the
// shorthand forms (a udev index number, a path string) spelled out.
const asDeviceObjects = (list) => (Array.isArray(list) ? list : []).map((e) =>
  typeof e === 'number' ? { index: e } : typeof e === 'string' ? { path: e } : e);

// The editable part of this Client's config: its `hw` or `sw` section as in
// the file, normalized (shorthand entries, legacy single-device fields) and
// without secrets. Reported at registration.
function readEditableConfig(configPath, type){
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {},
    section = { ...(raw[type] || {}) };
  if (type === 'hw'){
    const { uart, stlinkSerial, ...rest } = section,
      power = rest.power && typeof rest.power === 'object' ? { ...rest.power } : rest.power,
      out = {
        ...rest,
        stlinks: asDeviceObjects(rest.stlinks || (stlinkSerial ? [{ serial: stlinkSerial }] : [])),
        uarts: asDeviceObjects(rest.uarts || (uart ? [uart] : [])),
        usbs: asDeviceObjects(rest.usbs),
        relays: (rest.relays || (power?.relayIndex !== undefined ? [power.relayIndex] : [])).map((r) => (typeof r === 'number' ? { channel: r } : r))
      };
    if (power){
      delete power.relayIndex;
    }
    out.power = power || null;
    return publicClientConfig('hw', out);
  }
  return publicClientConfig(type, section);
}

// The whole config file, its secrets left out — reported at registration
// for the dashboard's Export.
function readShareableConfigFile(configPath){
  return shareableClientConfigFile(JSON.parse(fs.readFileSync(configPath, 'utf8')) || {});
}

// Applies a dashboard edit to the config file: validated (the shared schema,
// then exactly as loadConfig would resolve it), merged with the section's
// private fields (e.g. sw.registryAuth, never sent to the Coordinator),
// legacy single-device fields dropped, and written atomically. Throws with a
// readable reason if it can't be applied. `fields`: an Import's other
// top-level fields — filtered here again (never joinKey, coordinatorUrl,
// name, this Client's id or paths), artifactory's token and tokenFile kept.
function applyEditableConfig(configPath, type, section, fields = null){
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
    const { token, tokenFile } = raw.artifactory || {};
    raw = { ...raw, ...checked.fields };
    if (checked.fields.artifactory){
      raw.artifactory = { ...checked.fields.artifactory, ...(token ? { token } : {}), ...(tokenFile ? { tokenFile } : {}) };
    }
  }
  const current = raw[type] || {},
    next = { ...section };
  for (const key of CLIENT_CONFIG_PRIVATE_FIELDS[type] || []){
    if (current[key] !== undefined){
      next[key] = current[key];
    }
  }
  if (type === 'hw'){
    resolveHwConfig(next);
  }
  else {
    resolveSwConfig(next);
  }
  const mode = fs.statSync(configPath).mode & 0o777,
    tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ ...raw, [type]: next }, null, 2) + '\n', { mode });
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

function saveConfigField(configPath, key, value){
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  raw[key] = value;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
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
  saveConfigField,
  readCredentials,
  writeCredentials,
  readOrCreateClientId,
  assertSlotIndex,
  assertDeviceIndex,
  devicePath,
  MAX_SLOTS
};
