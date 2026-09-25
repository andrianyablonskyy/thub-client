/**
 * @file        scripts/install-default-config.js
 * @description npm postinstall: on a real global install, creates the Client's directory layout
 *              (~/.config/thub, ~/var/lib/thub/client and its work subdir) and, if it doesn't already
 *              exist, ~/.config/thub/client.json — for the user who ran `sudo npm i -g`, not root
 *              (README §8.5, §13)
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
  { isGlobalInstall, isRoot, resolveTargetUser, targetPaths } = require('./install-target');

// Deliberately not a copy of the bundled config.json (which has a working
// coordinatorUrl, a placeholder joinKey and a specific hw example for
// zero-setup `npm run client` in the monorepo). A real install instead gets
// empty required fields so config.js's own validation fails loudly until
// you set coordinatorUrl/name/joinKey for real, rather than silently
// registering as an instance nobody meant to create with a shared
// placeholder joinKey. varDir is home-anchored, not cwd-relative (config.js
// defaults it to <cwd>/.data), so the daemon, the control CLI and the
// systemd unit all agree on where tokens, sockets and pidfiles live.
function defaultContent(paths){
  return {
    coordinatorUrl: '',
    name: '',
    type: 'hw',
    labels: [],
    groups: [],
    joinKey: '',
    varDir: paths.defaultVarDir,
    heartbeatIntervalSec: 10,
    longPollWaitSec: 30
  };
}

// Under `sudo npm i -g` everything is created by root in another user's
// home — hand it over, or the Client (running as that user, see
// install-systemd-unit.js) couldn't read its config or write its state.
function chownToUser(p, user){
  if (isRoot() && user.uid !== 0){
    fs.chownSync(p, user.uid, user.gid);
  }
}

// Creates `dir` and chowns every directory this call created along the
// way (e.g. ~/.config, ~/var, ~/var/lib when they didn't exist yet),
// plus `dir` itself.
function mkdirOwned(dir, user){
  const firstCreated = fs.mkdirSync(dir, { recursive: true });
  if (firstCreated){
    const rel = path.relative(firstCreated, dir).split(path.sep).filter(Boolean);
    let current = firstCreated;
    chownToUser(current, user);
    for (const part of rel){
      current = path.join(current, part);
      chownToUser(current, user);
    }
  }
  else {
    chownToUser(dir, user);
  }
}

// Best-effort and never fails the `npm install` itself. Never overwrites
// an existing config file — a re-install/upgrade must not clobber whatever
// the user already configured.
function main(){
  if (!isGlobalInstall()){
    return;
  }
  const user = resolveTargetUser(),
    paths = targetPaths(user);
  try {
    for (const dir of [paths.configDir, paths.varDir, paths.workDir, paths.runDir]){
      mkdirOwned(dir, user);
    }
    if (!fs.existsSync(paths.configPath)){
      fs.writeFileSync(paths.configPath, JSON.stringify(defaultContent(paths), null, 2) + '\n', { mode: 0o600 });
      chownToUser(paths.configPath, user);
      console.log(`thub-client: created ${paths.configPath} — set coordinatorUrl/name/joinKey before starting the Client`);
    }
    console.log(`thub-client: state directory is ${paths.varDir}`);
  }
  catch (err){
    console.warn(`thub-client: could not create ${paths.configPath} / ${paths.varDir} automatically (${err.message}).`);
  }
}

main();
