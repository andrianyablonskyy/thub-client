/**
 * @file        packages/client/src/host-hold.js
 * @description The host-wide hold the root helpers put up before disrupting every Client instance on a host (a
 *              self-update or a scheduled reboot): reading/writing it, and waiting until no instance is busy
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
  { sendCommand } = require('./control-socket');

const POLL_MS = 30_000,
  // Longer than a Client's job long-poll (longPollWaitSec, default 30 s):
  // a poll already in flight when the hold goes up may still hand its
  // instance a job, which must then show up as busy before we look.
  HOLD_GRACE_MS = 45_000,
  // A hold older than this is left over from a crashed helper — ignored.
  HOLD_MAX_AGE_MS = 2 * 3600 * 1000,
  BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';

// This boot's id (Linux), so a hold written just before a reboot doesn't
// outlive it; null elsewhere.
function currentBootId(){
  try {
    return fs.readFileSync(BOOT_ID_FILE, 'utf8').trim() || null;
  }
  catch {
    return null;
  }
}

// { reason: 'update' | 'reboot', ... } while the host is held, else null:
// no file, too old, or from a previous boot. A hold without a reason is a
// self-update's (the only kind there used to be).
function readHold(holdFile){
  let stat,
    data;
  try {
    stat = fs.statSync(holdFile);
    data = JSON.parse(fs.readFileSync(holdFile, 'utf8') || '{}');
  }
  catch (err){
    return err.code === 'ENOENT' ? null : { reason: 'update' }; // unreadable: still a hold
  }
  if (Date.now() - stat.mtimeMs >= HOLD_MAX_AGE_MS){
    return null;
  }
  if (data.bootId && data.bootId !== currentBootId()){
    return null;
  }
  return { ...data, reason: data.reason === 'reboot' ? 'reboot' : 'update' };
}

function writeHold(holdFile, data){
  fs.writeFileSync(holdFile, JSON.stringify({ ...data, since: new Date().toISOString(), bootId: currentBootId() }) + '\n');
}

// Instances with a job running or a local lock (both would be lost), asked
// over their control sockets in runDir. A socket nobody answers is a
// stopped instance.
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

// Removing the hold is the cancel signal (a Client does it when an admin
// cancels from the Coordinator).
function canceled(holdFile){
  return !fs.existsSync(holdFile);
}

// 'idle' | 'canceled' | 'timeout'. `what` names the wait in the log.
async function waitUntilIdle(runDir, holdFile, { maxWaitMs, what, sleepMs = POLL_MS } = {}){
  const deadline = Date.now() + maxWaitMs;
  for (;;){
    if (canceled(holdFile)){
      return 'canceled';
    }
    const busy = await busyInstances(runDir);
    if (!busy.length){
      return 'idle';
    }
    if (Date.now() > deadline){
      return 'timeout';
    }
    console.log(`${what}: waiting for ${busy.join(', ')} to finish (job running or locally locked)`);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

module.exports = { readHold, writeHold, busyInstances, waitUntilIdle, canceled, currentBootId, HOLD_GRACE_MS, HOLD_MAX_AGE_MS };
