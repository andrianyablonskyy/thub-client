/**
 * @file        scripts/install-default-config.js
 * @description npm postinstall: creates ~/.config/thub/client.json on a real global install, if it
 *              doesn't already exist, so `npm install -g` leaves a real, editable config file at
 *              the path this package actually reads from — not just an in-package fallback (README §8)
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

  CONFIG_PATH = path.join(os.homedir(), '.config', 'thub', 'client.json'),

  // Deliberately not a copy of the bundled config.json (which has a working
  // localhost coordinatorUrl, a placeholder joinKey and a specific hw
  // example for zero-setup `npm run client` in the monorepo). A real
  // install instead gets empty required fields so config.js's own
  // validation fails loudly ("Client config not found...") until you set
  // coordinatorUrl/name/joinKey for real, rather than silently registering
  // as an instance nobody meant to create with a shared placeholder joinKey.
  DEFAULT_CONTENT = {
    coordinatorUrl: '',
    name: '',
    type: 'hw',
    labels: [],
    groups: [],
    joinKey: '',
    heartbeatIntervalSec: 10,
    longPollWaitSec: 30
  };

// npm only sets this for an actual `npm install -g` — absent for a plain
// local/workspace install (e.g. this monorepo's own `npm install`).
function isGlobalInstall(){
  return process.env.npm_config_global === 'true';
}

// Best-effort and never fails the `npm install` itself. Never overwrites
// an existing file — a re-install/upgrade must not clobber whatever the
// user already configured.
function main(){
  if (!isGlobalInstall() || fs.existsSync(CONFIG_PATH)){
    return;
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONTENT, null, 2) + '\n', { mode: 0o600 });
    console.log(`thub-client: created ${CONFIG_PATH} — set coordinatorUrl/name/joinKey before starting thub-client-daemon`);
  }
  catch (err){
    console.warn(`thub-client: could not create ${CONFIG_PATH} automatically (${err.message}).`);
  }
}

main();
