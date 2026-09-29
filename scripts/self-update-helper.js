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
  { writeHold, waitUntilIdle, canceled, HOLD_GRACE_MS } = require('../src/host-hold'),
  { PACKAGES, isValidVersion, compareVersions, npmInstallGlobal } = require('@andrian.yablonskyy/thub-common'),
  { version: installedVersion } = require('../package.json');

// The self-update restarts *every* running thub-client@ instance on the
// host (npm's postinstall), not just the one that asked — so it waits until
// none has a job running or a local lock (src/host-hold.js).
const MAX_WAIT_MS = 24 * 3600 * 1000;

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

  // Hold the host: from here no instance takes a new job (daemon.js
  // _syncUpdateHold), so "idle" below stays true until the install
  // restarts them. Released however this ends.
  const holdFile = path.join(path.dirname(requestFile), 'update-hold.json');
  writeHold(holdFile, { reason: 'update', version: target });
  // `systemctl stop thub-client-update` mid-wait mustn't leave the hold up.
  for (const signal of ['SIGTERM', 'SIGINT']){
    process.on(signal, () => {
      fs.rmSync(holdFile, { force: true });
      process.exit(1);
    });
  }
  try {
    console.log(`thub-client-update: holding new jobs for v${target}; waiting for running jobs and uploads to finish`);
    await new Promise((resolve) => setTimeout(resolve, HOLD_GRACE_MS));
    const outcome = await waitUntilIdle(runDir, holdFile, { maxWaitMs: MAX_WAIT_MS, what: 'thub-client-update' });
    // Last check right before the point of no return.
    if (outcome === 'canceled' || canceled(holdFile)){
      console.log('thub-client-update: canceled from the Coordinator — not installing');
      return 0;
    }
    if (outcome === 'timeout'){
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
  finally {
    fs.rmSync(holdFile, { force: true });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`thub-client-update: ${err.message}`);
    process.exit(1);
  });
