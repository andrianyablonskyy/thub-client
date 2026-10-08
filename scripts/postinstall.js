/**
 * @file        packages/client/scripts/postinstall.js
 * @description npm postinstall: the default config, then the systemd units — skipped while npm only prepares the git
 *              checkout it installs from (README §8.5)
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

const path = require('node:path'),
  { spawnSync } = require('node:child_process');

// `npm i -g git+https://…`: before installing, npm "prepares" the clone with
// a nested `npm install` (pacote), which sets _PACOTE_NO_PREPARE_ and runs
// this script too. The real install follows right after and runs it again:
// set up once, there — not twice, restarting every instance twice.
if (process.env._PACOTE_NO_PREPARE_){
  console.log('thub-client: preparing the git checkout — the setup runs with the install itself');
  process.exit(0);
}

for (const step of ['install-default-config.js', 'install-systemd-unit.js']){
  const { status, error } = spawnSync(process.execPath, [path.join(__dirname, step)], { stdio: 'inherit' });
  if (error || status !== 0){
    console.error(`thub-client: ${step} failed${error ? `: ${error.message}` : ` (exit ${status})`}`);
    process.exit(status || 1);
  }
}
