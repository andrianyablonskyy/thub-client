'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

// Bundled with the package as a working example; a real Client overrides
// it with THUB_CLIENT_CONFIG or /etc/thub/dut0.yaml (§13).
const PACKAGE_DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// A host runs one Client process per DUT slot (§3.3), up to MAX_SLOTS of
// them (dut0..dut7) — matching up to 8 UART adapters, 8 ST-Link probes, 8
// USB-controlled DUTs and 8 relay channels on one bench (§8.2, §8.6).
const MAX_SLOTS = 8;

// Matches README.md §13 (/etc/thub/dut0.yaml).
function loadConfig(configPath = process.env.THUB_CLIENT_CONFIG) {
  const candidate = [configPath, '/etc/thub/dut0.yaml', PACKAGE_DEFAULT_CONFIG_PATH].find(
    (p) => p && fs.existsSync(p)
  );
  if (!candidate) {
    throw new Error(
      `Client config not found (set THUB_CLIENT_CONFIG, or create /etc/thub/dut0.yaml)`
    );
  }
  const raw = yaml.load(fs.readFileSync(candidate, 'utf8')) || {};

  // Per-instance defaults derived from the config file's own name (e.g.
  // dut3.yaml -> dut3.token / dut3.sock / dut3.pid), so several Client
  // instances on one host don't collide on a shared default path — each
  // still overridable explicitly for non-standard layouts.
  const instance = path.basename(candidate, path.extname(candidate));

  // Default to a directory under the current working directory — always
  // writable, on every platform, with zero setup — rather than an FHS
  // system path. That used to be the reverse (defaulting to /var/lib/thub
  // and /run/thub, the systemd-deployment paths, §8.5) and every new
  // path-based config field added since kept inheriting the same bug: it
  // worked under systemd (which grants exactly those two directories via
  // ReadWritePaths=/var/lib/thub and RuntimeDirectory=thub) and failed
  // everywhere else — worst of all on macOS, where /run doesn't exist at
  // all. A systemd deployment now sets `varDir`/`runDir` explicitly in its
  // /etc/thub/dut<N>.yaml (§8.6) to opt *into* the FHS paths, instead of
  // every other environment needing to opt *out* of them.
  const varDir = raw.varDir || path.join(process.cwd(), '.data');
  const runDir = raw.runDir || varDir;

  const hw = resolveHwConfig(raw.hw || {});

  const config = {
    coordinatorUrl: raw.coordinatorUrl,
    name: raw.name,
    type: raw.type,
    labels: raw.labels || [],
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
    artifactory: resolveArtifactoryConfig(raw.artifactory || {}),
    hw,
    sw: raw.sw || {},
    heartbeatIntervalSec: raw.heartbeatIntervalSec || 10,
    longPollWaitSec: raw.longPollWaitSec || 30,
    configPath: candidate,
  };

  if (!config.coordinatorUrl || !config.name || !config.type) {
    throw new Error('Client config requires coordinatorUrl, name and type');
  }

  // The Coordinator identifies this Client by this id (registry.registerAuto,
  // §5.1), not by `name` — so `name`/`type`/`labels` can all be freely
  // changed in this config and the Coordinator updates the same resource
  // in place on the next restart, instead of registering a new one.
  config.clientId = readOrCreateClientId(config.clientIdFile);

  return config;
}

function readOrCreateClientId(clientIdFile) {
  try {
    const id = fs.readFileSync(clientIdFile, 'utf8').trim();
    if (id) return id;
  } catch {
    // fall through to generate one
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(clientIdFile), { recursive: true });
  fs.writeFileSync(clientIdFile, id + '\n', { mode: 0o600 });
  return id;
}

function assertSlotIndex(field, index) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SLOTS) {
    throw new Error(`${field} must be an integer 0-${MAX_SLOTS - 1}, got ${index}`);
  }
}

// §8.2/§8.6: `hw.uart.index` (0-7) is a convenience for the udev naming
// convention (/dev/thub/dut<index>-uart) — an explicit hw.uart.path always
// wins. ST-Link has no such shortcut: st-flash needs the probe's real
// serial number, which udev can only alias, not assign.
function resolveHwConfig(hw) {
  if (hw.uart?.index !== undefined && !hw.uart.path) {
    assertSlotIndex('hw.uart.index', hw.uart.index);
    return { ...hw, uart: { ...hw.uart, path: `/dev/thub/dut${hw.uart.index}-uart` } };
  }
  return hw;
}

// §13: the Client's read-only Artifactory token lives in its own file
// (tokenFile), never inline in config or passed through the Coordinator (§12).
function resolveArtifactoryConfig(artifactory) {
  if (artifactory.token || !artifactory.tokenFile) return artifactory;
  try {
    return { ...artifactory, token: fs.readFileSync(artifactory.tokenFile, 'utf8').trim() };
  } catch {
    return artifactory;
  }
}

function saveConfigField(configPath, key, value) {
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  raw[key] = value;
  fs.writeFileSync(configPath, yaml.dump(raw));
}

// Stored as JSON so a restarted daemon knows its resourceId without
// needing an API call it isn't authorized to make (resource tokens can
// only act on their own resource, §12).
function readCredentials(tokenFile) {
  try {
    return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeCredentials(tokenFile, { resourceId, resourceToken }) {
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
  MAX_SLOTS,
};
