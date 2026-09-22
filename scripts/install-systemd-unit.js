/**
 * @file        scripts/install-systemd-unit.js
 * @description npm postinstall: installs systemd/thub-client@.service to /etc/systemd/system on
 *              Linux when root, with ExecStart rewritten to this exact install's real node/daemon.js
 *              paths — the checked-in file's hardcoded /usr/lib/node_modules/... only ever matches
 *              npm's traditional Debian/Ubuntu global prefix, not e.g. an nvm-managed Node (§8.5)
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

  UNIT_SRC = path.join(__dirname, '..', 'systemd', 'thub-client@.service'),
  DAEMON_PATH = path.join(__dirname, '..', 'src', 'daemon.js'),
  UNIT_DEST = '/etc/systemd/system/thub-client@.service',
  MANUAL_HINT = `sudo cp "${UNIT_SRC}" ${UNIT_DEST} && sudo systemctl daemon-reload`;

function isRoot(){
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// npm only sets this for an actual `npm install -g` — see the matching
// check in install-udev-rules.js for why this matters: without it, a
// *local* `npm install` run as root (the norm in most Linux Docker images
// and CI runners) would still install a real unit into /etc/systemd/system
// on a box that was never meant to run as a Client at all.
function isGlobalInstall(){
  return process.env.npm_config_global === 'true';
}

// Same philosophy as install-udev-rules.js: best-effort, never fails the
// `npm install` itself. Doesn't enable/start anything — that needs a real
// /etc/thub/<instance>.json in place first (§8.6), which this can't know
// exists yet, so `sudo systemctl enable --now thub-client@dut0` stays a
// deliberate, separate manual step (§8.5).
function main(){
  if (process.platform !== 'linux' || !isGlobalInstall()){
    return;
  }

  if (!isRoot()){
    console.log(
      `\nthub-client: skipping systemd unit install (not root). For a systemd-managed Client, run:\n  ${MANUAL_HINT}\n`
    );
    return;
  }

  let copied = false;
  try {
    // The checked-in ExecStart only matches npm's traditional global
    // prefix (/usr/lib/node_modules) — replace it with wherever *this*
    // install's node and daemon.js actually are, so the unit works
    // regardless of npm prefix or an nvm-managed Node.
    const rendered = fs
      .readFileSync(UNIT_SRC, 'utf8')
      .replace(/^ExecStart=.*$/m, `ExecStart=${process.execPath} ${DAEMON_PATH}`);
    fs.writeFileSync(UNIT_DEST, rendered);
    copied = true;
    execFileSync('systemctl', ['daemon-reload'], { stdio: 'ignore' });
    console.log(`thub-client: installed systemd unit to ${UNIT_DEST}`);
  }
  catch (err){
    if (copied){
      console.warn(
        `thub-client: installed ${UNIT_DEST} but 'systemctl daemon-reload' failed (${err.message}).\n` +
          'Run it yourself before enabling the service: sudo systemctl daemon-reload'
      );
    }
    else {
      console.warn(`thub-client: could not install the systemd unit automatically (${err.message}).\nInstall it manually with:\n  ${MANUAL_HINT}`);
    }
  }
}

main();
