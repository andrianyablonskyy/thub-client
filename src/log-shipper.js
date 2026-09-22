/**
 * @file        packages/client/src/log-shipper.js
 * @description Batches and ships a job's log lines to the Coordinator at a fixed interval
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

const fs = require('node:fs');
const path = require('node:path');

const BATCH_INTERVAL_MS = 250;

// §3.1 / §8: "Log shipper (buffer, batch 250 ms, retry, disk spill)."
// Buffers lines in memory, flushes every 250ms; anything that fails to
// send is spilled to disk so a network blip during a job doesn't lose
// output (§15: "Log shipper buffers to disk and retries").
class LogShipper {
  constructor(client, jobId, { workDir }) {
    this.client = client;
    this.jobId = jobId;
    this.queue = [];
    this.spoolPath = path.join(workDir, jobId, 'logs.spool.jsonl');
    this.sending = false;
    this.stopped = false;
    this.timer = setInterval(() => this._flush(), BATCH_INTERVAL_MS);
  }

  // Every line also echoes to the daemon's own stdout, immediately — not
  // just shipped to the Coordinator. Otherwise the terminal running
  // `thub-client`/`npm run client` shows nothing at all while it's
  // actually doing a job, and you'd have to go check the dashboard or the
  // Agent CLI elsewhere just to see what your own machine is doing.
  push(stream, line) {
    for (const l of String(line).split('\n')) {
      if (l.length === 0) continue;
      console.log(`[${stream}] ${l}`);
      this.queue.push({ ts: new Date().toISOString(), stream, line: l });
    }
  }

  async _flush() {
    if (this.sending) return;
    const spooled = this._readSpool();
    const batch = [...spooled, ...this.queue];
    if (batch.length === 0) return;

    this.sending = true;
    const sentCount = this.queue.length;
    this.queue = [];
    try {
      await this.client.post(`/jobs/${this.jobId}/logs`, batch);
      this._clearSpool();
    } catch {
      this._writeSpool(batch);
      // sentCount lines were already folded into the spool file above.
      void sentCount;
    } finally {
      this.sending = false;
    }
  }

  _readSpool() {
    try {
      const text = fs.readFileSync(this.spoolPath, 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    } finally {
      this._clearSpool();
    }
  }

  _writeSpool(batch) {
    fs.mkdirSync(path.dirname(this.spoolPath), { recursive: true });
    fs.writeFileSync(this.spoolPath, batch.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  _clearSpool() {
    fs.rmSync(this.spoolPath, { force: true });
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    // Best-effort final flush, retried once so a job's last lines aren't lost.
    await this._flush();
    if (fs.existsSync(this.spoolPath)) await this._flush();
  }
}

module.exports = { LogShipper };
