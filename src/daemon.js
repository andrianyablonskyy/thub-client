'use strict';

const fs = require('node:fs');
const { loadConfig, readCredentials, writeCredentials } = require('./config');
const { ClientApiClient } = require('./api-client');
const { createControlSocketServer } = require('./control-socket');
const { JobRunner } = require('./runner');

// §3.3 / §8: the Client daemon core — registration, heartbeat, long-poll,
// log shipping and upload — dispatching to whichever executor the job
// needs. One process per DUT slot (systemd template unit, §8.5).
class Daemon {
  constructor(config) {
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
  async start() {
    await this._ensureRegistered();
    this._writePidFile();
    this._startControlSocket();
    this._startHeartbeatTimer();
    await this._workLoop();
    clearInterval(this.heartbeatTimer);
    this._cleanup();
  }

  _writePidFile() {
    fs.mkdirSync(require('node:path').dirname(this.config.pidFile), { recursive: true });
    fs.writeFileSync(this.config.pidFile, String(process.pid));
  }

  _cleanup() {
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
  async _ensureRegistered() {
    if (this.config.joinKey) {
      const anon = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: this.config.joinKey });
      const { resourceId, resourceToken } = await anon.post('/resources/register', {
        clientId: this.config.clientId,
        name: this.config.name,
        type: this.config.type,
        labels: this.config.labels,
        hostInfo: { hostname: require('node:os').hostname(), platform: process.platform },
      });
      writeCredentials(this.config.tokenFile, { resourceId, resourceToken });
      this.resourceId = resourceId;
      this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: resourceToken });
      console.log(`Registered as resource ${resourceId}`);
      return;
    }

    const creds = readCredentials(this.config.tokenFile);
    if (!creds) {
      throw new Error('No resource token on disk and no joinKey in config (or THUB_CLIENT_JOIN_KEY)');
    }
    this.resourceId = creds.resourceId;
    this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: creds.resourceToken });
  }

  _startControlSocket() {
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
        localLock: this.localLock,
      }),
    });
  }

  async _reportStatus() {
    if (!this.resourceId) return;
    await this.client.post(`/resources/${this.resourceId}/status`, {
      busy: this.localLock.locked,
      source: 'local',
      reason: this.localLock.reason,
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
  _startHeartbeatTimer() {
    const tick = () => {
      if (this.heartbeatInFlight) return; // don't pile up if one's slow
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
  async _workLoop() {
    while (!this.stopped) {
      if (this.localLock.locked) {
        await sleep(1000);
        continue;
      }
      try {
        await this._pollForJob();
      } catch (err) {
        if (this.stopped) break; // aborted on purpose by stop()
        console.error('poll error:', err.message);
        await sleep(this.config.heartbeatIntervalSec * 1000);
      }
    }
  }

  async _heartbeat() {
    const { commands } = await this.client.post(`/resources/${this.resourceId}/heartbeat`, {
      state: this.activeJobId ? 'busy' : this.localLock.locked ? 'busy' : 'idle',
      activeJobId: this.activeJobId,
      localLock: this.localLock.locked,
    });

    for (const command of commands || []) {
      if (command.command === 'cancel-job' && command.jobId === this.activeJobId) {
        this.runner?.cancel();
      } else if (command.command === 'cancel-job') {
        // Stale job reported after a reconnect (§15) — nothing local to cancel.
      }
    }
  }

  async _pollForJob() {
    this.pollAbort = new AbortController();
    let job;
    try {
      job = await this.client.get(`/resources/${this.resourceId}/jobs/next`, {
        query: { wait: this.config.longPollWaitSec },
        signal: this.pollAbort.signal,
      });
    } finally {
      this.pollAbort = null;
    }
    if (!job) return;

    console.log(`Job ${job.id} queued`);
    this.activeJobId = job.id;
    this.runner = new JobRunner(this.client, this.config);
    try {
      await this.runner.run(job);
    } finally {
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
  stop() {
    this.stopped = true;
    this.pollAbort?.abort();
    this.runner?.cancel(true);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const config = loadConfig();
  const daemon = new Daemon(config);
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
