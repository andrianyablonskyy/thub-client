'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

// Bundled with the package as a working example; a real Client overrides
// it with THUB_CLIENT_CONFIG or /etc/thub/dut0.yaml (§13).
const PACKAGE_DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.json');

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

  const config = {
    coordinatorUrl: raw.coordinatorUrl,
    name: raw.name,
    type: raw.type,
    labels: raw.labels || [],
    // Shared secret that lets this Client self-register with no admin
    // action on the Coordinator side (see daemon.js _ensureRegistered).
    joinKey: process.env.THUB_CLIENT_JOIN_KEY || raw.joinKey || '',
    tokenFile: raw.tokenFile || '/var/lib/thub/dut0.token',
    workDir: raw.workDir || '/var/lib/thub/work',
    socketPath: raw.socketPath || '/run/thub/client.sock',
    artifactory: resolveArtifactoryConfig(raw.artifactory || {}),
    hw: raw.hw || {},
    sw: raw.sw || {},
    heartbeatIntervalSec: raw.heartbeatIntervalSec || 10,
    longPollWaitSec: raw.longPollWaitSec || 30,
    configPath: candidate,
  };

  if (!config.coordinatorUrl || !config.name || !config.type) {
    throw new Error('Client config requires coordinatorUrl, name and type');
  }
  return config;
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

module.exports = { loadConfig, saveConfigField, readCredentials, writeCredentials };
