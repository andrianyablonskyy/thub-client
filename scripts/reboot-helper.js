/**
 * @file        scripts/reboot-helper.js
 * @description Root side of a scheduled Client host reboot (README §10): run by thub-client-reboot.service when a
 *              Client writes its reboot request; holds the host, waits for running jobs, then reboots it
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
  { readHold, writeHold, waitUntilIdle, canceled, HOLD_GRACE_MS } = require('../src/host-hold');

// Below the hold's max age (host-hold.js, 2 h), so the Clients keep
// refusing new jobs for the whole wait. Busy longer than this: skip this
// reboot rather than kill a job — the schedule fires again next time.
const MAX_WAIT_MS = 100 * 60 * 1000;

// argv: <request file> <runDir>. The request is written by the (unprivileged)
// Client, so nothing in it is executed or trusted beyond logging.
async function main(){
  const [requestFile, runDir = path.dirname(requestFile || '.')] = process.argv.slice(2);
  if (!requestFile){
    console.error('usage: reboot-helper.js <request file> [runDir]');
    return 2;
  }

  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  }
  catch (err){
    // Deleted by a previous run or canceled (PathModified= fires on removal too).
    if (err.code === 'ENOENT'){
      return 0;
    }
    request = {};
  }
  fs.rmSync(requestFile, { force: true });

  const holdFile = path.join(path.dirname(requestFile), 'update-hold.json'),
    from = `${request.instance || 'a Client'} (${request.cron || 'schedule'})`;
  if (readHold(holdFile)){
    console.log(`thub-client-reboot: host already held (self-update or reboot in progress) — skipping the reboot asked by ${from}`);
    return 0;
  }

  // Hold the host: from here no instance takes a new job. The hold carries
  // this boot's id, so it's void once the host is back up.
  writeHold(holdFile, { reason: 'reboot', instance: request.instance || null, scheduledFor: request.scheduledFor || null });
  const release = () => fs.rmSync(holdFile, { force: true });
  for (const signal of ['SIGTERM', 'SIGINT']){
    process.on(signal, () => {
      release();
      process.exit(1);
    });
  }

  console.log(`thub-client-reboot: reboot asked by ${from}; holding new jobs, waiting for running ones to finish`);
  // THUB_REBOOT_TEST_*: shorter waits for the test suite only (only root
  // sets this service's environment).
  const graceMs = Number(process.env.THUB_REBOOT_TEST_GRACE_MS) || HOLD_GRACE_MS,
    pollMs = Number(process.env.THUB_REBOOT_TEST_POLL_MS) || undefined;
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  const outcome = await waitUntilIdle(runDir, holdFile, { maxWaitMs: MAX_WAIT_MS, what: 'thub-client-reboot', sleepMs: pollMs });
  if (outcome === 'canceled' || canceled(holdFile)){
    console.log('thub-client-reboot: canceled from the Coordinator — not rebooting');
    return 0;
  }
  if (outcome === 'timeout'){
    release();
    console.error(`thub-client-reboot: instances stayed busy for ${MAX_WAIT_MS / 60000} min — skipping this reboot`);
    return 0;
  }

  console.log('thub-client-reboot: host idle — rebooting now');
  try {
    execFileSync('systemctl', ['reboot'], { stdio: 'inherit' });
    return 0;
  }
  catch (err){
    release();
    console.error(`thub-client-reboot: systemctl reboot failed: ${err.message}`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`thub-client-reboot: ${err.message}`);
    process.exit(1);
  });
