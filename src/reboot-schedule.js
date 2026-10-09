/**
 * @file        packages/client/src/reboot-schedule.js
 * @description Scheduled host reboot on the Client: keeps the cron schedule the Coordinator sent, and when it's due
 *              asks the root reboot helper (thub-client-reboot.path) to reboot the host once idle (README §10)
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
  { parseCron, cronMatches } = require('@andrian.yablonskyy/thub-common'),
  { readHold } = require('./host-hold');

// Installed by scripts/install-systemd-unit.js (as root); watches the
// request file and runs scripts/reboot-helper.js.
const REBOOT_PATH_UNIT = '/etc/systemd/system/thub-client-reboot.path',
  CHECK_INTERVAL_MS = 20_000;

// The schedule is this instance's (saved per instance, set on its resource
// card); the reboot is the host's — every instance on it goes down. Cron
// runs in this host's local time zone.
class RebootScheduler{
  constructor({ scheduleFile, requestFile, holdFile, instance, pathUnit = REBOOT_PATH_UNIT, now = () => new Date(), log = console }){
    Object.assign(this, { scheduleFile, requestFile, holdFile, instance, pathUnit, now, log });
    this.cron = null;
    this.parsed = null;
    this.lastFiredMinute = null;
    this.timer = null;
  }

  static supported(pathUnit = REBOOT_PATH_UNIT){
    return fs.existsSync(pathUnit);
  }

  // What was applied before a restart.
  load(){
    try {
      this._apply(JSON.parse(fs.readFileSync(this.scheduleFile, 'utf8')).cron || null);
    }
    catch {
      this._apply(null);
    }
    return this.cron;
  }

  _apply(cron){
    this.parsed = cron ? parseCron(cron) : null;
    this.cron = cron || null;
  }

  // From the Coordinator's set-reboot-schedule command (null clears). An
  // invalid one is refused and the current kept — the Coordinator validates
  // too, so this is only a guard.
  set(cron){
    const next = typeof cron === 'string' && cron.trim() ? cron.trim() : null;
    if (next === this.cron){
      return this.cron;
    }
    try {
      this._apply(next);
    }
    catch (err){
      this.log.error(`reboot schedule "${next}" refused: ${err.message}`);
      return this.cron;
    }
    if (next){
      fs.mkdirSync(path.dirname(this.scheduleFile), { recursive: true });
      fs.writeFileSync(this.scheduleFile, JSON.stringify({ cron: next, savedAt: this.now().toISOString() }) + '\n');
    }
    else {
      fs.rmSync(this.scheduleFile, { force: true });
    }
    this.log.log(next ? `scheduled host reboot: ${next} (host local time)` : 'scheduled host reboot cleared');
    return this.cron;
  }

  // Called every CHECK_INTERVAL_MS: fires once in each matching minute.
  // Returns true when it asked for a reboot.
  tick(){
    if (!this.parsed){
      return false;
    }
    const now = this.now(),
      minute = Math.floor(now.getTime() / 60000);
    if (minute === this.lastFiredMinute || !cronMatches(this.parsed, now)){
      return false;
    }
    this.lastFiredMinute = minute;
    return this._request(now, `scheduled reboot (${this.cron})`, { cron: this.cron, scheduledFor: now.toISOString() });
  }

  // The Coordinator's `reboot` command (resource card "Reboot"): same path
  // as a scheduled one — the root helper reboots once nothing is busy.
  requestNow(reason = 'user reboot request'){
    const now = this.now();
    return this._request(now, `reboot (${reason})`, { reason, requestedAt: now.toISOString() });
  }

  _request(now, what, details){
    const hold = readHold(this.holdFile);
    if (hold){
      this.log.warn(`${what} skipped: the host is already held for a ${hold.reason === 'reboot' ? 'reboot' : 'self-update'}`);
      return false;
    }
    if (!fs.existsSync(this.pathUnit)){
      this.log.warn(
        `${what} requested, but ${this.pathUnit} isn't installed — ` +
          'reinstall the Client as root (sudo npm i -g @andrian.yablonskyy/thub-client) to enable host reboots'
      );
      return false;
    }
    try {
      fs.writeFileSync(this.requestFile, JSON.stringify({ instance: this.instance, ...details }) + '\n');
      this.log.log(`${what}: asked the host to reboot once no instance is busy`);
      return true;
    }
    catch (err){
      this.log.error(`${what} request failed: ${err.message}`);
      return false;
    }
  }

  // Cancel from the Coordinator (resource card, "Holding for scheduled
  // reboot"): the helper checks for its hold until the moment it reboots.
  cancel(){
    fs.rmSync(this.requestFile, { force: true });
    if (readHold(this.holdFile)?.reason === 'reboot'){
      fs.rmSync(this.holdFile, { force: true });
    }
    this.log.log('scheduled reboot canceled from the Coordinator');
  }

  start(){
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(){
    clearInterval(this.timer);
  }
}

module.exports = { RebootScheduler, REBOOT_PATH_UNIT };
