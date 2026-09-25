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
  // Client instances per host — matching the dut1..dut8 symlinks in
  // udev/99-thub.rules and a relay board's 8 channels (§8.2, §8.6).
  MAX_SLOTS = 8;

// Matches README.md §13 (~/.config/thub/client.json). `overrides.name` (the
// daemon's --name, which the systemd unit sets to its instance name) wins
// over the file's `name`, which in turn defaults to the config file's
// basename — the same thing as the systemd instance name, so the control
// CLI (which never gets --name) loads a name-less config fine too.
function loadConfig(configPath = process.env.THUB_CLIENT_CONFIG, overrides = {}){
  const candidate = [configPath, USER_CONFIG_PATH, PACKAGE_DEFAULT_CONFIG_PATH].find(
    (p) => p && fs.existsSync(p)
  );
  if (!candidate){
    throw new Error(
      'Client config not found (set THUB_CLIENT_CONFIG, or create ~/.config/thub/client.json)'
    );
  }
  const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) || {},

    // Per-instance defaults derived from the config file's own name (e.g.
    // dut3.json -> dut3.token / dut3.sock / dut3.pid), so several Client
    // instances on one host don't collide on a shared default path — each
    // still overridable explicitly for non-standard layouts.
    instance = path.basename(candidate, path.extname(candidate)),

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
      artifactory: resolveArtifactoryConfig(raw.artifactory || {}),
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

// udev/99-thub.rules names devices 1-based (dut1..dut8), unlike relay
// channels, which are the relay board's own 0-7 numbering.
function assertDeviceIndex(field, index){
  if (!Number.isInteger(index) || index < 1 || index > MAX_SLOTS){
    throw new Error(`${field} must be an integer 1-${MAX_SLOTS}, got ${index}`);
  }
}

// Symlink format from udev/99-thub.rules: /dev/dut<N>-uart|usb|stlink.
function devicePath(index, kind){
  return `/dev/dut${index}-${kind}`;
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
// udev lookup hw.js otherwise does to find it from the path.
function resolveDeviceList(field, list, kind){
  assertListSize(field, list);
  return list.map((entry, i) => {
    const item = typeof entry === 'number' ? { index: entry } : typeof entry === 'string' ? { path: entry } : entry;
    if (!item || typeof item !== 'object'){
      throw new Error(`${field}[${i}] must be an index, a path or an object`);
    }
    if (item.path || (kind === 'stlink' && item.serial)){
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
  return { ...sw, registry: registry || null, allowDockerHub: sw.allowDockerHub === true, registryAuth };
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
  loadConfig,
  saveConfigField,
  readCredentials,
  writeCredentials,
  readOrCreateClientId,
  assertSlotIndex,
  assertDeviceIndex,
  devicePath,
  MAX_SLOTS
};
