/**
 * @file        scripts/self-update-helper.js
 * @description Root side of the Client's self-update (README §10.2): run by thub-client-update.service when a
 *              Client writes its update request, installs the requested thub-client version with npm i -g
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
  { sendCommand } = require('../src/control-socket'),
  { PACKAGES, isValidVersion, compareVersions, npmInstallGlobal } = require('@andrian.yablonskyy/thub-common'),
  { version: installedVersion } = require('../package.json');

const POLL_MS = 30_000,
  MAX_WAIT_MS = 24 * 3600 * 1000;

// npm's postinstall restarts *every* running thub-client@ instance on the
// host, not just the one that asked — so wait until none of them has a job
// running or a local lock (both would be lost), asking each over its
// control socket in runDir. A socket nobody answers on is a stopped one.
async function busyInstances(runDir){
  let sockets = [];
  try {
    sockets = fs.readdirSync(runDir).filter((f) => f.endsWith('.sock')).map((f) => path.join(runDir, f));
  }
  catch {
    return [];
  }
  const busy = [];
  for (const socket of sockets){
    try {
      const s = await sendCommand(socket, { cmd: 'status' });
      if (s.activeJobId || s.localLock?.locked){
        busy.push(path.basename(socket, '.sock'));
      }
    }
    catch {
      // not running
    }
  }
  return busy;
}

async function waitUntilIdle(runDir){
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;){
    const busy = await busyInstances(runDir);
    if (!busy.length){
      return true;
    }
    if (Date.now() > deadline){
      return false;
    }
    console.log(`thub-client-update: waiting for ${busy.join(', ')} to finish (job running or locally locked)`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// argv: <request file> <user the Client runs as> <runDir>. The request file
// is written by the (unprivileged) Client, so only its `version` is used,
// and only if it's a plain semver — the package is fixed.
async function main(){
  const [requestFile, user, runDir = path.dirname(requestFile || '.')] = process.argv.slice(2);
  if (!requestFile || !user){
    console.error('usage: self-update-helper.js <request file> <user> [runDir]');
    return 2;
  }

  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  }
  catch (err){
    // Deleted by a previous run (PathModified= also fires on removal).
    if (err.code === 'ENOENT'){
      return 0;
    }
    console.error(`thub-client-update: unreadable request ${requestFile}: ${err.message}`);
    fs.rmSync(requestFile, { force: true });
    return 1;
  }
  fs.rmSync(requestFile, { force: true });

  const target = request?.version;
  if (!isValidVersion(target)){
    console.error('thub-client-update: ignoring request with an invalid version');
    return 1;
  }
  // Several instances on one host all ask for the same version — only
  // the first request actually installs.
  if (compareVersions(installedVersion, target) >= 0){
    console.log(`thub-client-update: already on v${installedVersion} (requested v${target})`);
    return 0;
  }

  if (!await waitUntilIdle(runDir)){
    console.error('thub-client-update: instances stayed busy for 24h — giving up; restart a Client to ask again');
    return 1;
  }
  console.log(`thub-client-update: v${installedVersion} -> v${target} (requested by ${request.instance || 'a Client'})`);
  // SUDO_USER makes the postinstall scripts target the Client's user, as
  // a `sudo npm i -g` by that user would (install-target.js).
  const status = npmInstallGlobal(PACKAGES.client, target, { env: { ...process.env, SUDO_USER: user } });
  if (status !== 0){
    console.error(`thub-client-update: npm i -g failed (exit ${status})`);
  }
  return status;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`thub-client-update: ${err.message}`);
    process.exit(1);
  });
