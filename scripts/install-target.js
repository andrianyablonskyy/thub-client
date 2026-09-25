/**
 * @file        scripts/install-target.js
 * @description Shared by the npm postinstall scripts: resolves which user a global install is for
 *              (the one who ran `sudo npm i -g`, not root) and the paths it gets (README §8.5)
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
  { execFileSync } = require('node:child_process'),

  // The default config is client.json, so its systemd instance (and the
  // basename every per-instance path default is derived from) is "client".
  DEFAULT_INSTANCE = 'client';

// npm only sets this for an actual `npm install -g` — absent for a plain
// local/workspace install (e.g. this monorepo's own `npm install`, or a
// local `npm install` as root inside a CI/Docker image).
function isGlobalInstall(){
  return process.env.npm_config_global === 'true';
}

function isRoot(){
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Under `sudo npm i -g`, npm runs postinstall as root with HOME=/root, but
// "~" means the person who ran sudo — SUDO_USER. Their home comes from the
// passwd database, since HOME has already been reset.
function lookupUser(name){
  const entry = execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim().split(':');
  return { name: entry[0], uid: Number(entry[2]), gid: Number(entry[3]), home: entry[5] };
}

function resolveTargetUser(){
  const sudoUser = process.env.SUDO_USER;
  if (isRoot() && sudoUser && sudoUser !== 'root' && process.platform === 'linux'){
    try {
      return lookupUser(sudoUser);
    }
    catch {
      // fall through to the current user
    }
  }
  const info = os.userInfo();
  return { name: info.username, uid: info.uid, gid: info.gid, home: os.homedir() };
}

// Default layout (README §8.5): configs under ~/.config/thub (client.json
// plus any dutN.json), runtime state (tokens, client ids, job workspaces,
// control sockets, pidfiles) under ~/var/lib/thub/client — its own subdir,
// so it never mixes with a Coordinator's ~/var/lib/thub on the same host.
// An existing client.json's own varDir/runDir win over the default, so a
// re-install prepares (and the systemd unit allows writes to) the
// directories the Client will really use.
function targetPaths(user){
  const configDir = path.join(user.home, '.config', 'thub'),
    configPath = path.join(configDir, `${DEFAULT_INSTANCE}.json`),
    defaultVarDir = path.join(user.home, '.thub', 'client'),
    raw = readConfig(configPath),
    varDir = absolute(raw.varDir) || defaultVarDir,
    runDir = absolute(raw.runDir) || varDir;
  return {
    configDir,
    configPath,
    defaultVarDir,
    varDir,
    runDir,
    workDir: path.join(varDir, 'work'),
    // Host-wide (not per instance): written by a Client asked to
    // self-update, watched by thub-client-update.path (README §10.2).
    updateRequestFile: path.join(varDir, 'update-request.json'),
    instance: DEFAULT_INSTANCE
  };
}

function readConfig(configPath){
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  }
  catch {
    return {};
  }
}

function absolute(p){
  return typeof p === 'string' && path.isAbsolute(p) ? p : null;
}

module.exports = { isGlobalInstall, isRoot, resolveTargetUser, targetPaths, readConfig };
