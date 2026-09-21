'use strict';

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
  }

  async start() {
    await this._ensureRegistered();
    this._startControlSocket();
    this._loop();
  }

  async _ensureRegistered() {
    const creds = readCredentials(this.config.tokenFile);
    if (creds) {
      this.resourceId = creds.resourceId;
      this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: creds.resourceToken });
      return;
    }
    if (!this.config.joinKey) {
      throw new Error('No resource token on disk and no joinKey in config (or THUB_CLIENT_JOIN_KEY)');
    }
    // The join key stands in for a bearer token here — it's what proves
    // this Client is allowed to self-register, not a per-resource secret.
    const anon = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: this.config.joinKey });
    const { resourceId, resourceToken } = await anon.post('/resources/register', {
      name: this.config.name,
      type: this.config.type,
      labels: this.config.labels,
      hostInfo: { hostname: require('node:os').hostname(), platform: process.platform },
    });
    writeCredentials(this.config.tokenFile, { resourceId, resourceToken });
    this.resourceId = resourceId;
    this.client = new ClientApiClient({ baseUrl: this.config.coordinatorUrl, token: resourceToken });
    console.log(`Registered as resource ${resourceId}`);
  }

  _startControlSocket() {
    createControlSocketServer(this.config.socketPath, {
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

  async _loop() {
    while (!this.stopped) {
      try {
        await this._heartbeat();
        if (!this.activeJobId && !this.localLock.locked) {
          await this._pollForJob();
        } else {
          await sleep(this.config.heartbeatIntervalSec * 1000);
        }
      } catch (err) {
        console.error('daemon loop error:', err.message);
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
    const job = await this.client.get(`/resources/${this.resourceId}/jobs/next`, {
      query: { wait: this.config.longPollWaitSec },
    });
    if (!job) return;

    this.activeJobId = job.id;
    this.runner = new JobRunner(this.client, this.config);
    try {
      await this.runner.run(job);
    } finally {
      this.activeJobId = null;
      this.runner = null;
    }
  }

  stop() {
    this.stopped = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  const config = loadConfig();
  const daemon = new Daemon(config);
  daemon.start().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
  process.on('SIGTERM', () => daemon.stop());
  process.on('SIGINT', () => daemon.stop());
}

module.exports = { Daemon };
