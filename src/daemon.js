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
  { loadConfig, readCredentials, writeCredentials } = require('./config'),
  { ClientApiClient } = require('./api-client'),
  { createControlSocketServer } = require('./control-socket'),
  { JobRunner } = require('./runner');

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
    this.runner = null;
    this.stopped = false;
    this.controlServer = null;
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
    this.pollAbort = null;
  }

  // Resolves once the daemon has actually shut down (loop exited, control
  // socket closed, pidfile removed) — `thub-client stop`/`restart` (§8.4)
  // send SIGTERM and wait for the process to exit, so this has to be a
  // real, awaited shutdown rather than a fire-and-forget flag flip.
  async start(){
    await this._ensureRegistered();
    this._writePidFile();
    this._startControlSocket();
    this._startHeartbeatTimer();
    await this._workLoop();
    clearInterval(this.heartbeatTimer);
    this._cleanup();
  }

  _writePidFile(){
    fs.mkdirSync(require('node:path').dirname(this.config.pidFile), { recursive: true });
    fs.writeFileSync(this.config.pidFile, String(process.pid));
  }

  _cleanup(){
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
        { resourceId, resourceToken } = await anon.post('/resources/register', {
          clientId: this.config.clientId,
          name: this.config.name,
          type: this.config.type,
          labels: this.config.labels,
          groups: this.config.groups,
          hostInfo: { hostname: os.hostname(), platform: process.platform, addresses: localAddresses() }
        });
      writeCredentials(this.config.tokenFile, { resourceId, resourceToken });
      this.resourceId = resourceId;
      this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: resourceToken });
      console.log(`Registered as resource ${resourceId}`);
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
        await this._reportStatus();
        return { locked: true };
      },
      unlock: async () => {
        this.localLock = { locked: false, reason: null };
        await this._reportStatus();
        return { locked: false };
      },
      status: async () => ({
        resourceId: this.resourceId,
        activeJobId: this.activeJobId,
        localLock: this.localLock
      })
    });
  }

  async _reportStatus(){
    if (!this.resourceId){
      return;
    }
    await this.client.post(`/resources/${this.resourceId}/status`, {
      busy: this.localLock.locked,
      source: 'local',
      reason: this.localLock.reason
    });
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
    this.heartbeatTimer = setInterval(tick, this.config.heartbeatIntervalSec * 1000);
    this.heartbeatTimer.unref?.();
  }

  // Long-polls for work when idle and unlocked, or just runs a job to
  // completion when one comes in. Separate from the heartbeat timer above
  // so a slow/long job never starves heartbeats.
  async _workLoop(){
    while (!this.stopped){
      if (this.localLock.locked){
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
        await sleep(this.config.heartbeatIntervalSec * 1000);
      }
    }
  }

  async _heartbeat(){
    const { commands } = await this.client.post(`/resources/${this.resourceId}/heartbeat`, {
      state: this.activeJobId ? 'busy' : this.localLock.locked ? 'busy' : 'idle',
      activeJobId: this.activeJobId,
      localLock: this.localLock.locked,
      // Re-sent every time so a DHCP renewal or a cable moved to another
      // port shows up without restarting the Client.
      addresses: localAddresses()
    });

    for (const command of commands || []){
      if (command.command === 'cancel-job' && command.jobId === this.activeJobId){
        this.runner?.cancel();
      }
      else if (command.command === 'cancel-job'){
        // Stale job reported after a reconnect (§15) — nothing local to cancel.
      }
    }
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
    this.runner = new JobRunner(this.client, this.config);
    try {
      await this.runner.run(job);
    }
    finally {
      this.activeJobId = null;
      this.runner = null;
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
// which overrides the config file's `name`; the systemd unit passes its
// instance name here, so thub-client@dut1 registers as "dut1". No commander
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
