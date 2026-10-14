/**
 * @file        packages/client/src/instances.js
 * @description thub-client register/deregister: adds or removes a Client instance on this host — its
 *              ~/.config/thub/<name>.json and its thub-client@<name> systemd unit (README §8.5, §8.6)
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
  path = require('node:path'),
  { execFileSync } = require('node:child_process'),
  { isRoot, resolveTargetUser, targetPaths, readConfig } = require('../scripts/install-target');

const TYPES = ['hw', 'sw'],
  // The name is both a systemd instance name and a config file basename.
  NAME_RE = /^[A-Za-z0-9_-]+$/;

function validate(name, type){
  if (!NAME_RE.test(name)){
    throw new Error(`Invalid name "${name}" (letters, digits, '-' and '_' only)`);
  }
  if (type !== undefined && !TYPES.includes(type)){
    throw new Error(`Invalid type "${type}" (expected ${TYPES.join(' or ')})`);
  }
}

// Under `sudo thub-client ...` the instance belongs to SUDO_USER, the same
// user `sudo npm i -g` installed the unit for (install-target.js).
function instancePaths(name){
  const user = resolveTargetUser(),
    paths = targetPaths(user);
  return { user, paths, configPath: path.join(paths.configDir, `${name}.json`), unit: `thub-client@${name}.service` };
}

// systemctl needs root; run it through sudo (which prompts on the terminal)
// when we aren't already.
function systemctl(...args){
  const [cmd, argv] = isRoot() ? ['systemctl', args] : ['sudo', ['systemctl', ...args]];
  execFileSync(cmd, argv, { stdio: 'inherit' });
}

// Same check as install-systemd-unit.js's isConfigured: without these the
// daemon exits at once and the unit would crash-loop.
function isConfigured(raw, paths, name){
  if (!raw.coordinatorUrl || !raw.type){
    return false;
  }
  return Boolean(raw.joinKey) || fs.existsSync(raw.tokenFile || path.join(paths.varDir, `${name}.token`));
}

// Instances (config files) of this user other than `name` that are HW
// Clients with their systemd unit enabled: they'd hold the machine's one
// HW slot (hw-lock.js).
function otherHwInstances(name, paths){
  let files = [];
  try {
    files = fs.readdirSync(paths.configDir).filter((f) => f.endsWith('.json'));
  }
  catch {
    return [];
  }
  return files.map((f) => f.slice(0, -'.json'.length))
    .filter((other) => other !== name && NAME_RE.test(other))
    .filter((other) => {
      try {
        return readConfig(path.join(paths.configDir, `${other}.json`)).type === 'hw';
      }
      catch {
        return false;
      }
    })
    .filter((other) => {
      try {
        execFileSync('systemctl', ['is-enabled', '--quiet', `thub-client@${other}.service`], { stdio: 'ignore' });
        return true;
      }
      catch {
        return false;
      }
    });
}

// A new instance starts from client.json (coordinatorUrl, joinKey, varDir,
// hw-devices, ...) with the requested type — an SW one without hw-devices;
// `name` is dropped, so it registers under the instance name (the config
// file's). An existing config is kept,
// only its type is updated, so re-registering is safe.
function register(name, type){
  validate(name, type);
  const { user, paths, configPath, unit } = instancePaths(name),
    exists = fs.existsSync(configPath),
    raw = exists ? readConfig(configPath) : readConfig(paths.configPath);
  if (!exists){
    delete raw.name;
    if (type === 'sw'){
      delete raw['hw-devices'];
    }
  }
  // One HW Client per machine: it owns the udev rules and the devices.
  if (type === 'hw' && process.platform === 'linux'){
    const others = otherHwInstances(name, paths);
    if (others.length){
      throw new Error(`only one HW Client may run on this machine, and thub-client@${others[0]} is one. ` +
        `Deregister it first (thub-client deregister --name ${others[0]}), or register this one with --type sw`);
    }
  }
  raw.type = type;
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  if (isRoot() && user.uid !== 0){
    fs.chownSync(configPath, user.uid, user.gid);
  }
  console.log(`${exists ? 'Updated' : 'Created'} ${configPath} (type ${type}).`);

  if (process.platform !== 'linux'){
    console.log(`No systemd here — run it directly: thub-client-daemon --config ${configPath} --name ${name}`);
    return;
  }
  systemctl('enable', unit);
  if (isConfigured(raw, paths, name)){
    systemctl('restart', unit);
    console.log(`Registered and started ${unit} (logs: journalctl -u ${unit} -f).`);
  }
  else {
    console.log(`Registered ${unit}. Set coordinatorUrl/joinKey in ${configPath}, then: sudo systemctl start ${unit}`);
  }
}

// Stops and disables the unit and removes the instance's config. The
// default client.json is kept — it's the template new instances start
// from. State under varDir (token, client id) is left alone, so
// re-registering the same name comes back as the same resource.
function deregister(name){
  validate(name);
  const { paths, configPath, unit } = instancePaths(name);
  if (process.platform === 'linux'){
    systemctl('disable', '--now', unit);
  }
  if (configPath !== paths.configPath && fs.existsSync(configPath)){
    fs.rmSync(configPath);
    console.log(`Removed ${configPath}.`);
  }
  console.log(`Deregistered ${unit}.`);
}

module.exports = { register, deregister, otherHwInstances };
