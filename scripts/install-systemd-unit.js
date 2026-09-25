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
  UNIT_DEST = `/etc/systemd/system/${UNIT_NAME}`,
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
    .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${DAEMON_PATH}`)
    .replace(/^ReadWritePaths=.*$/m, `ReadWritePaths=${writable}`);
}

// Same check the daemon itself makes (config.js, daemon.js
// _ensureRegistered): without these it exits at once, and an enabled
// unit would just crash-loop until systemd's start limit gives up.
function isConfigured(paths){
  const raw = readConfig(paths.configPath);
  if (!raw.coordinatorUrl || !raw.name || !raw.type){
    return false;
  }
  return Boolean(raw.joinKey) || fs.existsSync(raw.tokenFile || path.join(paths.varDir, `${paths.instance}.token`));
}

function activeInstances(){
  const out = execFileSync(
    'systemctl',
    ['list-units', '--type=service', '--state=active', '--plain', '--no-legend', 'thub-client@*'],
    { encoding: 'utf8' }
  );
  return out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
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
    step = 'daemon-reload';
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });

    step = 'list-units';
    const restart = new Set(activeInstances());
    if (isConfigured(paths)){
      step = 'enable';
      execFileSync('systemctl', ['enable', defaultUnit], { stdio: 'ignore' });
      restart.add(defaultUnit);
    }
    for (const unit of restart){
      step = `restart ${unit}`;
      execFileSync('systemctl', ['restart', unit], { stdio: 'ignore' });
    }

    console.log(`thub-client: installed ${UNIT_DEST} (runs as ${user.name}, configs in ${paths.configDir})`);
    if (restart.size){
      console.log(`thub-client: (re)started ${[...restart].join(', ')} (logs: journalctl -u 'thub-client@*')`);
    }
    if (!restart.has(defaultUnit)){
      console.log(
        `thub-client: set coordinatorUrl/name/joinKey in ${paths.configPath}, then start it with:\n` +
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
