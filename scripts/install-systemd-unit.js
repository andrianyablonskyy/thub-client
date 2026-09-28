/**
 * @file        scripts/install-systemd-unit.js
 * @description npm postinstall: installs systemd/thub-client@.service to /etc/systemd/system on
 *              Linux when root, rendered for the user who ran `sudo npm i -g` and this install's real
 *              node/daemon.js paths, then enables and (re)starts the default thub-client@client
 *              instance once its config is filled in, and restarts every other running instance so an
 *              upgrade takes effect (README §8.5)
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
  { isGlobalInstall, isRoot, resolveTargetUser, targetPaths, readConfig } = require('./install-target'),

  UNIT_NAME = 'thub-client@.service',
  UNIT_SRC = path.join(__dirname, '..', 'systemd', UNIT_NAME),
  DAEMON_PATH = path.join(__dirname, '..', 'src', 'daemon.js'),
  UDEV_SYNC_PATH = path.join(__dirname, '..', 'src', 'udev.js'),
  UNIT_DEST = `/etc/systemd/system/${UNIT_NAME}`,
  // Root-side self-update (README §10.2): the path unit watches the
  // update request a Client writes, the service installs it.
  UPDATE_PATH_UNIT = 'thub-client-update.path',
  UPDATE_SERVICE_UNIT = 'thub-client-update.service',
  UPDATE_HELPER = path.join(__dirname, 'self-update-helper.js'),
  MANUAL_HINT = 'sudo npm i -g @andrian.yablonskyy/thub-client',

  // Device access (serial adapters, ST-Link/USB probes) and, for SW
  // Clients, the Docker socket. Granted to the service only, without
  // changing the user's own group membership — and only the ones that
  // exist on this host, since systemd refuses to start a unit that names
  // an unknown group (e.g. `docker` on an HW-only box without Docker).
  DEVICE_GROUPS = ['dialout', 'plugdev', 'docker'];

function groupExists(name){
  try {
    execFileSync('getent', ['group', name], { stdio: 'ignore' });
    return true;
  }
  catch {
    return false;
  }
}

// The checked-in unit only has placeholders — fill in the target user,
// their config/state directories (%h in a system unit is root's home, not
// User='s, so the path is written out) and wherever *this* install's node
// and daemon.js actually are, so it works regardless of npm prefix or an
// nvm-managed Node.
function renderUnit(user, paths){
  const writable = [...new Set([paths.varDir, paths.runDir])].join(' '),
    groups = DEVICE_GROUPS.filter(groupExists).join(' ');
  return fs.readFileSync(UNIT_SRC, 'utf8')
    .replace(/^User=.*$/m, `User=${user.name}`)
    .replace(/^Group=.*$/m, `Group=${user.gid}`)
    .replace(/^SupplementaryGroups=.*$/m, groups ? `SupplementaryGroups=${groups}` : '')
    .replace(/^Environment=THUB_CLIENT_CONFIG=.*$/m, `Environment=THUB_CLIENT_CONFIG=${paths.configDir}/%i.json`)
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${paths.varDir}`)
    .replace(/^ExecStartPre=.*$/m, `ExecStartPre=+${process.execPath} ${UDEV_SYNC_PATH} --config ${paths.configDir}/%i.json`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${DAEMON_PATH} --name %i`)
    .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${writable}`);
}

function renderUpdateUnits(user, paths){
  const nodeDir = path.dirname(process.execPath),
    unitPath = (name) => path.join(__dirname, '..', 'systemd', name);
  return {
    [UPDATE_PATH_UNIT]: fs.readFileSync(unitPath(UPDATE_PATH_UNIT), 'utf8')
      .replace(/^PathModified=.*$/m, `PathModified=${paths.updateRequestFile}`),
    // npm is a `#!/usr/bin/env node` script, so this node goes first on PATH.
    [UPDATE_SERVICE_UNIT]: fs.readFileSync(unitPath(UPDATE_SERVICE_UNIT), 'utf8')
      .replace(/^Environment=PATH=.*$/m, `Environment=PATH=${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
      .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${UPDATE_HELPER} ${paths.updateRequestFile} ${user.name} ${paths.runDir}`)
  };
}

// Same check the daemon itself makes (config.js, daemon.js
// _ensureRegistered): without these it exits at once, and an enabled
// unit would just crash-loop until systemd's start limit gives up.
function isConfigured(paths){
  const raw = readConfig(paths.configPath);
  if (!raw.coordinatorUrl || !raw.type){
    return false;
  }
  return Boolean(raw.joinKey) || fs.existsSync(raw.tokenFile || path.join(paths.varDir, `${paths.instance}.token`));
}

function listInstances(extraArgs){
  const out = execFileSync(
    'systemctl',
    ['list-units', '--type=service', '--plain', '--no-legend', ...extraArgs, 'thub-client@*'],
    { encoding: 'utf8' }
  );
  return out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
}

function activeInstances(){
  return listInstances(['--state=active']);
}

// Instances enabled to start at boot: their symlinks in any *.wants dir.
function enabledInstances(){
  const root = '/etc/systemd/system',
    found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root).filter((d) => d.endsWith('.wants'));
  }
  catch {
    return found;
  }
  for (const dir of dirs){
    try {
      found.push(...fs.readdirSync(path.join(root, dir)).filter((f) => /^thub-client@.+\.service$/.test(f)));
    }
    catch {
      // not a directory / unreadable
    }
  }
  return found;
}

// The default instance is only ever set up on a fresh machine (README
// §8.5): one where no thub-client@ instance has been set up before —
// none enabled, none known to systemd (even stopped or failed), and no
// marker from an earlier install. Otherwise an upgrade would bring
// thub-client@client up next to the instances actually in use, since
// client.json stays filled in as the template `thub-client register`
// copies. The marker keeps a host where every instance was deliberately
// disabled from counting as fresh again.
function isFreshMachine(markerFile){
  return !fs.existsSync(markerFile) && !enabledInstances().length && !listInstances(['--all']).length;
}

function markSetUp(markerFile){
  try {
    fs.writeFileSync(markerFile, `instances set up; the default instance is no longer started automatically (${new Date().toISOString()})\n`);
  }
  catch (err){
    console.warn(`thub-client: could not write ${markerFile} (${err.message})`);
  }
}

// Best-effort, never fails the `npm install` itself. Runs after
// install-default-config.js, so the config and state dirs the unit points
// at already exist (ReadWritePaths= on a missing path fails the unit).
// `restart` (not `start`) so an upgrade picks up the new code immediately.
function main(){
  if (process.platform !== 'linux' || !isGlobalInstall()){
    return;
  }
  if (!isRoot()){
    console.log(`\nthub-client: skipping systemd service install (not root). To install it, run:\n  ${MANUAL_HINT}\n`);
    return;
  }

  const user = resolveTargetUser(),
    paths = targetPaths(user),
    defaultUnit = `thub-client@${paths.instance}.service`;
  let step = 'write';
  try {
    fs.writeFileSync(UNIT_DEST, renderUnit(user, paths));
    for (const [name, content]of Object.entries(renderUpdateUnits(user, paths))){
      fs.writeFileSync(`/etc/systemd/system/${name}`, content);
    }
    step = 'daemon-reload';
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    step = `enable ${UPDATE_PATH_UNIT}`;
    execFileSync('systemctl', ['enable', '--now', UPDATE_PATH_UNIT], { stdio: 'ignore' });

    step = 'list-units';
    const restart = new Set(activeInstances()),
      fresh = isFreshMachine(paths.instancesMarkerFile);
    if (fresh && isConfigured(paths)){
      step = 'enable';
      execFileSync('systemctl', ['enable', defaultUnit], { stdio: 'ignore' });
      restart.add(defaultUnit);
    }
    for (const unit of restart){
      step = `restart ${unit}`;
      execFileSync('systemctl', ['restart', unit], { stdio: 'ignore' });
    }
    if (!fresh || restart.size){
      markSetUp(paths.instancesMarkerFile);
    }

    console.log(`thub-client: installed ${UNIT_DEST} (runs as ${user.name}, configs in ${paths.configDir})`);
    if (restart.size){
      console.log(`thub-client: (re)started ${[...restart].join(', ')} (logs: journalctl -u 'thub-client@*')`);
    }
    if (fresh && !restart.has(defaultUnit)){
      console.log(
        `thub-client: set coordinatorUrl/joinKey in ${paths.configPath}, then start it with:\n` +
          `  sudo systemctl enable --now ${defaultUnit}`
      );
    }
  }
  catch (err){
    if (step === 'write'){
      console.warn(`thub-client: could not install ${UNIT_DEST} (${err.message}).`);
    }
    else {
      console.warn(
        `thub-client: installed ${UNIT_DEST} but 'systemctl ${step}' failed (${err.message}).\n` +
          `Finish it yourself: sudo systemctl daemon-reload && sudo systemctl enable --now ${defaultUnit}`
      );
    }
  }
}

main();
