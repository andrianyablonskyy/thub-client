/**
 * @file        scripts/install-udev-rules.js
 * @description npm postinstall: installs udev/99-thub.rules to /etc/udev/rules.d on Linux when
 *              root, so `sudo npm install -g` alone gives HW Clients stable device paths (§8.2/§8.6)
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

  RULES_SRC = path.join(__dirname, '..', 'udev', '99-thub.rules'),
  RULES_DEST = '/etc/udev/rules.d/99-thub.rules',
  MANUAL_HINT = `sudo cp "${RULES_SRC}" ${RULES_DEST} && sudo udevadm control --reload`;

function isRoot(){
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// A postinstall step is a convenience, not a requirement — this must never
// fail (or exit non-zero and) take the whole `npm install` down with it.
// SW-only Clients, non-root local installs, and every non-Linux dev
// machine all just fall back to the manual command README §8.5 documents.
function main(){
  if (process.platform !== 'linux'){
    return;
  }

  if (!isRoot()){
    console.log(
      `\nthub-client: skipping udev rule install (not root). For HW Clients, run:\n  ${MANUAL_HINT}\n`
    );
    return;
  }

  let copied = false;
  try {
    fs.copyFileSync(RULES_SRC, RULES_DEST);
    copied = true;
    execFileSync('udevadm', ['control', '--reload'], { stdio: 'ignore' });
    console.log(`thub-client: installed udev rules to ${RULES_DEST}`);
  }
  catch (err){
    // The rules file itself may already be in place even if reloading
    // udev failed — don't tell the user to redo a step that succeeded.
    if (copied){
      console.warn(
        `thub-client: installed ${RULES_DEST} but 'udevadm control --reload' failed (${err.message}).\n` +
          'Run it yourself (or replug the device) for the rule to take effect: sudo udevadm control --reload'
      );
    }
    else {
      console.warn(`thub-client: could not install udev rules automatically (${err.message}).\nInstall them manually with:\n  ${MANUAL_HINT}`);
    }
  }
}

main();
