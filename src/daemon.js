#!/usr/bin/env node

/**
 * @file        packages/client/src/daemon.js
 * @description Client daemon core: registration, heartbeat, long-poll, job dispatch and log shipping (README §3.3, §8)
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
  {
    loadConfig, readCredentials, writeCredentials, readEditableConfig, readShareableConfigFile, applyEditableConfig, readAppliedConfigRevision,
    writeAppliedConfigRevision
  } = require('./config'),
  { ClientApiClient } = require('./api-client'),
  { createControlSocketServer } = require('./control-socket'),
  { JobRunner } = require('./runner'),
  { describeCapabilities } = require('./capabilities'),
  { syncUdevRules } = require('./udev'),
  { RebootScheduler } = require('./reboot-schedule'),
  { scanUsb } = require('./usb-scan'),
  { readHold } = require('./host-hold'),
  { PACKAGES, isNewer } = require('@andrian.yablonskyy/thub-common'),
  { version } = require('../package.json');

// Installed by scripts/install-systemd-unit.js; runs the actual `npm i -g`
// as root when this daemon writes its update request (README §10.2).
const UPDATE_PATH_UNIT = '/etc/systemd/system/thub-client-update.path',
  HOLD_REASONS = { update: 'self-update in progress', reboot: 'scheduled host reboot pending' };

// Every address on this host's network interfaces except loopback, for
// the dashboard's resource card. The external address isn't known here —
// the Coordinator records the one each request arrives from.
function localAddresses(){
  return Object.entries(os.networkInterfaces()).flatMap(([iface, addrs]) =>
    (addrs || [])
      .filter((a) => !a.internal)
      .map((a) => ({ iface, address: a.address, family: typeof a.family === 'number' ? `IPv${a.family}` : a.family }))
  );
}

// §3.3 / §8: the Client daemon core — registration, heartbeat, long-poll,
// log shipping and upload — dispatching to whichever executor the job
// needs. One process per DUT slot (systemd template unit, §8.5).
class Daemon{
  constructor(config){
    this.config = config;
    this.resourceId = null;
    this.client = null;
    this.localLock = { locked: false, reason: null };
    this.activeJobId = null;
    // What this instance is doing and since when (monotonic clock), for
    // the dashboard's "Task / status" duration — see _touchActivity().
    this.activity = { key: 'idle', state: 'idle', jobId: null, since: performance.now() };
    this.runner = null;
    this.stopped = false;
    this.controlServer = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
    this.pollAbort = null;
    // Host-wide hold by a root helper: null, 'update' or 'reboot'.
    this.holdReason = null;
    // Dashboard config edits (Config tab): the revision applied, and a
    // restart owed once idle so the new capabilities take effect.
    this.configState = readAppliedConfigRevision(config.configRevisionFile);
    this.restartForConfig = false;
    this.reboot = new RebootScheduler({
      scheduleFile: config.rebootScheduleFile,
      requestFile: config.rebootRequestFile,
      holdFile: config.updateHoldFile,
      instance: config.name
    });
  }

  // Kept for the control socket's status and older callers.
  get updateHold(){
    return Boolean(this.holdReason);
  }

  // Resolves once the daemon has actually shut down (loop exited, control
  // socket closed, pidfile removed) — `thub-client stop`/`restart` (§8.4)
  // send SIGTERM and wait for the process to exit, so this has to be a
  // real, awaited shutdown rather than a fire-and-forget flag flip.
  async start(){
    this._syncUdevRules();
    this.reboot.load();
    await this._ensureRegistered();
    this.reboot.start();
    this._writePidFile();
    this._startControlSocket();
    this._startHeartbeatTimer();
    await this._workLoop();
    clearInterval(this.heartbeatTimer);
    this._cleanup();
  }

  // Under systemd the unit's ExecStartPre=+ has already done this as root
  // (so this finds it unchanged); run by hand as root, this is what does
  // it. Before registering, so capabilities see the fresh symlinks. Never
  // fatal: a wrong rule just shows up as missing devices on the dashboard.
  _syncUdevRules(){
    try {
      const { status, file } = syncUdevRules(this.config);
      if (status === 'needs-root'){
        console.warn(`udev: ${file} does not match this config; apply it with: sudo thub-client --config ${this.config.configPath} udev`);
      }
    }
    catch (err){
      console.warn(`udev: ${err.message}`);
    }
  }

  _writePidFile(){
    fs.mkdirSync(require('node:path').dirname(this.config.pidFile), { recursive: true });
    fs.writeFileSync(this.config.pidFile, String(process.pid));
  }

  _cleanup(){
    this.reboot.stop();
    this.controlServer?.close();
    fs.rmSync(this.config.pidFile, { force: true });
    fs.rmSync(this.config.socketPath, { force: true });
  }

  // Re-registers on every start/restart whenever a joinKey is configured
  // (the default — the bundled config ships one), so the Coordinator picks
  // up this Client's current name/type/labels/status each time, not just
  // the first time ever (registry.registerAuto does the actual update).
  // Falls back to a previously-stored token only when joinKey has been
  // deliberately stripped out of the config after initial setup.
  async _ensureRegistered(){
    if (this.config.joinKey){
      const anon = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: this.config.joinKey }),
        { resourceId, resourceToken, heartbeatIntervalSec } = await anon.post('/resources/register', {
          clientId: this.config.clientId,
          name: this.config.name,
          type: this.config.type,
          labels: this.config.labels,
          groups: this.config.groups,
          // timeZone: a scheduled reboot's cron runs in it (README §10).
          hostInfo: {
            hostname: os.hostname(),
            platform: process.platform,
            addresses: localAddresses(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
          },
          capabilities: { ...describeCapabilities(this.config), rebootSupported: RebootScheduler.supported() },
          // Editable from the dashboard's Config tab (secrets left out),
          // and the whole file for its Export.
          config: this._editableConfig(),
          configFile: this._shareableConfigFile()
        });
      writeCredentials(this.config.tokenFile, { resourceId, resourceToken });
      this.resourceId = resourceId;
      this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: resourceToken });
      console.log(`Registered as resource ${resourceId}`);
      this._adoptHeartbeatInterval(heartbeatIntervalSec);
      return;
    }

    const creds = readCredentials(this.config.tokenFile);
    if (!creds){
      throw new Error('No resource token on disk and no joinKey in config (or THUB_CLIENT_JOIN_KEY)');
    }
    this.resourceId = creds.resourceId;
    this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: creds.resourceToken });
  }

  _startControlSocket(){
    this.controlServer = createControlSocketServer(this.config.socketPath, {
      lock: async ({ reason }) => {
        this.localLock = { locked: true, reason: reason || null };
        this._touchActivity();
        await this._reportStatus();
        return { locked: true };
      },
      unlock: async () => {
        this.localLock = { locked: false, reason: null };
        this._touchActivity();
        await this._reportStatus();
        return { locked: false };
      },
      status: async () => ({
        resourceId: this.resourceId,
        activeJobId: this.activeJobId,
        localLock: this.localLock,
        updateHold: this.updateHold
      })
    });
  }

  async _reportStatus(){
    if (!this.resourceId){
      return;
    }
    await this.client.post(`/resources/${this.resourceId}/status`, {
      busy: this.localLock.locked || this.updateHold,
      source: 'local',
      reason: this.localLock.locked ? this.localLock.reason : this.holdReason ? HOLD_REASONS[this.holdReason] : null
    });
  }

  // While a root helper holds the host — a self-update (README §10.2) or a
  // scheduled reboot (§10) — take no new jobs and show as busy on the
  // Coordinator so none is scheduled here. A job already running finishes
  // (uploads included) first; the helper waits for that before acting.
  async _syncUpdateHold(){
    const reason = readHold(this.config.updateHoldFile)?.reason || null;
    if (reason === this.holdReason){
      return;
    }
    this.holdReason = reason;
    this._touchActivity();
    console.log(reason ? `${HOLD_REASONS[reason]}: not taking new jobs` : 'host hold released');
    await this._reportStatus().catch((err) => console.error('status report failed:', err.message));
  }

  // Heartbeats run on their own timer, independent of whatever the work
  // loop below is doing. They used to be interleaved with it (heartbeat,
  // then poll-or-run-job, repeat), which meant a job that ran longer than
  // `missedLimit * heartbeatIntervalSec` (§5.1) got no heartbeats sent
  // for its whole duration — the Coordinator's sweeper would eventually
  // and incorrectly mark the resource OUT_OF_SERVICE and the job LOST,
  // and a `cancel-job` command could never reach an in-progress job
  // either, since heartbeat responses are the only way commands arrive.
  _startHeartbeatTimer(){
    const tick = () => {
      if (this.heartbeatInFlight){
        return;
      } // don't pile up if one's slow
      this.heartbeatInFlight = true;
      this._heartbeat()
        .catch((err) => console.error('heartbeat error:', err.message))
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    };
    tick(); // fire immediately — setInterval alone would leave a freshly
    // (re)started daemon looking OUT_OF_SERVICE/stale for up to a full
    // heartbeatIntervalSec before its first heartbeat.
    this.heartbeatTick = tick;
    this.heartbeatTimer = setInterval(tick, this._heartbeatMs());
    this.heartbeatTimer.unref?.();
  }

  // The Coordinator decides the heartbeat interval (its heartbeat.intervalSec,
  // changeable from its dashboard, README §13.2): it sends it at
  // registration and in every heartbeat reply, and this Client follows it
  // from then on. Its own heartbeatIntervalSec is only the starting value,
  // and what an older Coordinator that sends none gets.
  _heartbeatMs(){
    return (this.heartbeatIntervalSec || this.config.heartbeatIntervalSec) * 1000;
  }

  _adoptHeartbeatInterval(sec){
    const n = Number(sec);
    if (!Number.isInteger(n) || n < 1 || n > 3600 || n === (this.heartbeatIntervalSec || this.config.heartbeatIntervalSec)){
      return;
    }
    this.heartbeatIntervalSec = n;
    console.log(`Heartbeat interval: ${n}s (from the Coordinator)`);
    if (this.heartbeatTimer){
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(this.heartbeatTick, this._heartbeatMs());
      this.heartbeatTimer.unref?.();
    }
  }

  // Long-polls for work when idle and unlocked, or just runs a job to
  // completion when one comes in. Separate from the heartbeat timer above
  // so a slow/long job never starves heartbeats.
  async _workLoop(){
    while (!this.stopped){
      await this._syncUpdateHold();
      if (this.localLock.locked || this.updateHold){
        await sleep(1000);
        continue;
      }
      try {
        await this._pollForJob();
      }
      catch (err){
        if (this.stopped){
          break;
        } // aborted on purpose by stop()
        console.error('poll error:', err.message);
        await sleep(this._heartbeatMs());
      }
    }
  }

  // Current activity: running a job (until it's fully finished, uploads
  // included), manually locked, held for a self-update, or idle. Called on
  // every transition, so `since` is exact rather than heartbeat-granular.
  _touchActivity(){
    const [state, jobId] = this.activeJobId
        ? ['job', this.activeJobId]
        : this.localLock.locked
          ? ['locked', null]
          : this.holdReason ? [this.holdReason === 'reboot' ? 'reboot-hold' : 'update-hold', null] : ['idle', null],
      key = `${state}:${jobId || ''}`;
    if (key !== this.activity.key){
      this.activity = { key, state, jobId, since: performance.now() };
    }
  }

  async _heartbeat(){
    const { commands, heartbeatIntervalSec } = await this.client.post(`/resources/${this.resourceId}/heartbeat`, {
      state: this.activeJobId || this.localLock.locked || this.updateHold ? 'busy' : 'idle',
      activeJobId: this.activeJobId,
      localLock: this.localLock.locked || this.updateHold,
      // Re-sent every time so a DHCP renewal or a cable moved to another
      // port shows up without restarting the Client.
      addresses: localAddresses(),
      // Relative, not timestamps, so the Coordinator can place them on its
      // own clock regardless of this host's clock (README §10).
      hostUptimeSec: Math.round(os.uptime()),
      activity: {
        state: this.activity.state,
        jobId: this.activity.jobId,
        durationSec: Math.round((performance.now() - this.activity.since) / 1000)
      },
      // The reboot schedule this Client applies — the Coordinator resends
      // set-reboot-schedule until it matches what was saved.
      rebootSchedule: this.reboot.cron,
      // Likewise the dashboard config revision (set-config), and why the
      // last one was refused, if it was.
      configRevision: this.configState.revision,
      configError: this.configState.error
    });

    this._adoptHeartbeatInterval(heartbeatIntervalSec);

    for (const command of commands || []){
      if (command.command === 'cancel-job' && command.jobId === this.activeJobId){
        this.runner?.cancel();
      }
      else if (command.command === 'cancel-job'){
        // Stale job reported after a reconnect (§15) — nothing local to cancel.
      }
      else if (command.command === 'self-update'){
        this._requestSelfUpdate(command.version);
      }
      // Cancel from the Coordinator's resource card (README §10).
      else if (command.command === 'unlock' && this.localLock.locked){
        console.log('local lock released from the Coordinator');
        this.localLock = { locked: false, reason: null };
        this._touchActivity();
        await this._reportStatus().catch((err) => console.error('status report failed:', err.message));
      }
      else if (command.command === 'cancel-update'){
        this._cancelSelfUpdate();
      }
      else if (command.command === 'set-reboot-schedule'){
        this.reboot.set(command.cron);
      }
      else if (command.command === 'cancel-reboot'){
        this.reboot.cancel();
      }
      // "Reboot" on the Coordinator's resource card. The job it was running
      // got its cancel-job just before this, in the same reply.
      else if (command.command === 'reboot'){
        this.reboot.requestNow(command.reason || 'user reboot request');
      }
      else if (command.command === 'set-config'){
        this._applyConfig(command);
      }
      // "Connected USB devices" Refresh on the resource card: lsusb, answered
      // right away rather than with the next heartbeat.
      else if (command.command === 'scan-usb'){
        this._scanUsb(command.requestId);
      }
    }
    await this._restartForConfigIfIdle();
  }

  async _scanUsb(requestId){
    const { output, error } = await scanUsb();
    try {
      await this.client.post(`/resources/${this.resourceId}/usb-scan`, { requestId, output, error });
      console.log(`USB scan sent${error ? ` (${error})` : ''}`);
    }
    catch (err){
      console.error(`USB scan: couldn't send the result: ${err.message}`);
    }
  }

  _shareableConfigFile(){
    try {
      return this.config.configPath ? readShareableConfigFile(this.config.configPath) : null;
    }
    catch (err){
      console.warn(`config: can't report the config file: ${err.message}`);
      return null;
    }
  }

  _editableConfig(){
    try {
      return this.config.configPath ? readEditableConfig(this.config.configPath, this.config.type) : null;
    }
    catch (err){
      console.warn(`config: can't report the editable config: ${err.message}`);
      return null;
    }
  }

  // set-config (dashboard Config tab): write the new hw/sw section into
  // this Client's config file, then restart once idle for it to take
  // effect. Repeated by the Coordinator until the revision is reported, so
  // an older or already-applied one is ignored; a refused one is reported
  // (configError) rather than retried.
  // `file`: an Import's other top-level fields, written along with it.
  _applyConfig({ revision, type, config, file }){
    if (!Number.isInteger(revision) || revision <= this.configState.revision){
      return;
    }
    try {
      if (type !== this.config.type){
        throw new Error(`it's a ${type} config, but this is a ${this.config.type} Client`);
      }
      applyEditableConfig(this.config.configPath, type, config, file || null, this._identity());
      this.configState = { revision, error: null };
      this.restartForConfig = true;
      console.log(`config revision ${revision} from the Coordinator written to ${this.config.configPath}; restarting once idle`);
    }
    catch (err){
      this.configState = { revision, error: `Config revision ${revision} refused: ${err.message}` };
      console.error(this.configState.error);
    }
    writeAppliedConfigRevision(this.config.configRevisionFile, this.configState.revision, this.configState.error);
  }

  // What this Client runs as — pinned in its config file whenever a config
  // is applied, so however it's restarted (systemd, reload in place, a
  // reboot) it comes back with the same Coordinator, name, type and join
  // key. A join key from THUB_CLIENT_JOIN_KEY stays in the environment,
  // where the restarted process gets it again.
  _identity(){
    const { coordinatorUrl, name, type, joinKey } = this.config;
    return { coordinatorUrl, name, type, ...(process.env.THUB_CLIENT_JOIN_KEY ? {} : { joinKey }) };
  }

  // Under systemd (INVOCATION_ID) exit and let Restart= bring the Client
  // back — ExecStartPre regenerates the udev rules as root, and the new
  // registration reports the new capabilities. Run by hand, reload in place.
  async _restartForConfigIfIdle(){
    if (!this.restartForConfig || this.activeJobId || this.localLock.locked || this.holdReason){
      return;
    }
    this.restartForConfig = false;
    if (process.env.INVOCATION_ID){
      console.log('restarting to apply the new config');
      this.stop();
      return;
    }
    try {
      this.config = loadConfig(this.config.configPath, { name: this.config.name });
      this._syncUdevRules();
      await this._ensureRegistered();
      console.log('new config applied (reloaded in place)');
    }
    catch (err){
      console.error(`applying the new config failed: ${err.message}`);
    }
  }

  // The Coordinator repeats `self-update` on every heartbeat until this
  // Client reports the new version, so act once per version per process:
  // write the request the root thub-client-update.path unit picks up. Its
  // postinstall restarts this instance onto the new version, so wait for
  // an idle, unlocked moment (a later heartbeat) rather than lose a job or
  // a manual lock; the helper also waits for every other instance.
  _requestSelfUpdate(target){
    if (target === this.requestedUpdate || !isNewer(target, version) || this.activeJobId || this.localLock.locked){
      return;
    }
    this.requestedUpdate = target;
    if (!fs.existsSync(UPDATE_PATH_UNIT)){
      console.warn(
        `self-update to v${target} requested, but ${UPDATE_PATH_UNIT} isn't installed — ` +
          `update by hand: sudo npm i -g ${PACKAGES.client}@${target}`
      );
      return;
    }
    try {
      fs.writeFileSync(
        this.config.updateRequestFile,
        JSON.stringify({ version: target, instance: this.config.name, requestedAt: new Date().toISOString() }) + '\n'
      );
      console.log(`self-update v${version} -> v${target} requested (${this.config.updateRequestFile})`);
    }
    catch (err){
      console.error(`self-update request failed: ${err.message}`);
    }
  }

  // Removing the hold (and any not-yet-picked-up request) is the cancel
  // signal for the root update helper, which checks for it until the very
  // moment it would install. The hold is host-wide, so this cancels the
  // update for every instance on the host.
  _cancelSelfUpdate(){
    // Not a reboot's hold — that one is canceled with cancel-reboot.
    const files = [this.config.updateRequestFile, ...(readHold(this.config.updateHoldFile)?.reason === 'reboot' ? [] : [this.config.updateHoldFile])];
    for (const file of files){
      try {
        fs.rmSync(file, { force: true });
      }
      catch (err){
        console.error(`cancel self-update: ${err.message}`);
      }
    }
    this.requestedUpdate = null; // a later request for the same version works again
    console.log('self-update canceled from the Coordinator');
  }

  async _pollForJob(){
    this.pollAbort = new AbortController();
    let job;
    try {
      job = await this.client.get(`/resources/${this.resourceId}/jobs/next`, {
        query: { wait: this.config.longPollWaitSec },
        signal: this.pollAbort.signal
      });
    }
    finally {
      this.pollAbort = null;
    }
    if (!job){
      return;
    }

    console.log(`Job ${job.id} queued`);
    this.activeJobId = job.id;
    this._touchActivity();
    this.runner = new JobRunner(this.client, this.config);
    try {
      await this.runner.run(job);
    }
    finally {
      this.activeJobId = null;
      this.runner = null;
      this._touchActivity();
    }
  }

  // Bounded, "stop means stop" shutdown (matching `docker stop` / systemd's
  // TimeoutStopSec, not "wait however long the job takes"): abort the
  // in-flight long-poll if idle, or if a job is running, tell the runner
  // to cancel it AND report it ERROR (runner.js's cancel(true)/_bail) —
  // properly awaited as part of runner.run(), which _pollForJob() and
  // therefore start() await, so the result POST actually completes before
  // process.exit(0) runs instead of racing it. Note this ends up posting
  // /jobs/:id/result, not /jobs/:id/cancel — cancel is an agent/admin
  // action (§12); a resource token isn't authorized to call it.
  stop(){
    this.stopped = true;
    this.pollAbort?.abort();
    this.runner?.cancel(true);
  }
}

function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Accepts --config/-c <path> (or --config=<path>) so a specific instance can
// be started without exporting THUB_CLIENT_CONFIG first — the same escape
// hatch `thub-client --config <path> ...` has, for running several Client
// instances on one host (§8.6) — and --name/-n <name> (or --name=<name>),
// which overrides the config file's `name` for a Client started by hand
// (the systemd unit passes only --config: the file's `name`, else its
// instance name). A config applied from the dashboard pins the name it runs
// under into the file (_identity), so --name only matters until then. No commander
// dependency here since these are the only flags the daemon entry point takes.
function optionFromArgv(argv, long, short){
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === long || arg === short){
      return argv[i + 1];
    }
    if (arg.startsWith(`${long}=`)){
      return arg.slice(long.length + 1);
    }
  }
  return undefined;
}

if (require.main === module){
  const argv = process.argv.slice(2),
    config = loadConfig(optionFromArgv(argv, '--config', '-c'), { name: optionFromArgv(argv, '--name', '-n') }),
    daemon = new Daemon(config);
  daemon
    .start()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(1);
    });
  process.on('SIGTERM', () => daemon.stop());
  process.on('SIGINT', () => daemon.stop());
}

module.exports = { Daemon };
