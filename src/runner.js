'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { JOB_STATES } = require('@thub/shared');
const { downloadFirmware, downloadAndExtractTests } = require('./downloader');
const { LogShipper } = require('./log-shipper');
const { HwExecutor } = require('./executors/hw');
const { SwExecutor } = require('./executors/sw');

const KILL_GRACE_MS = 10_000;

// §8.1 Job execution lifecycle on the Client.
class JobRunner {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.canceled = false;
    this.child = null;
  }

  cancel() {
    this.canceled = true;
    if (this.child) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }
  }

  async run(job) {
    const jobDir = path.join(this.config.workDir, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const logShipper = new LogShipper(this.client, job.id, this.config);
    const executor =
      job.spec.target.type === 'hw'
        ? new HwExecutor(this.config, logShipper)
        : new SwExecutor(this.config, logShipper);

    try {
      await this.client.post(`/jobs/${job.id}/accept`);

      logShipper.push('runner', `downloading firmware ${job.spec.firmware.url}`);
      const fwPath = await downloadFirmware(job.spec, jobDir, this.config.artifactory);
      logShipper.push('runner', `downloading tests ${job.spec.tests.url}`);
      const testsDir = await downloadAndExtractTests(job.spec, jobDir, this.config.artifactory);
      if (this.canceled) return this._bail(executor, logShipper);

      logShipper.push('runner', 'preparing DUT');
      await executor.prepare(job, job.spec.target.type === 'hw' ? fwPath : path.dirname(fwPath));
      if (this.canceled) return this._bail(executor, logShipper);

      await this.client.post(`/jobs/${job.id}/state`, { state: JOB_STATES.RUNNING });

      const exitCode = await this._runTests(job, testsDir, executor, logShipper);
      if (this.canceled) return this._bail(executor, logShipper);

      const artifactsDir = path.join(testsDir, 'artifacts');
      const resultFiles = collectResultFiles(testsDir, artifactsDir);
      if (resultFiles.length) {
        await this.client.postArtifacts(job.id, resultFiles);
      }

      const summary = summarizeJUnit(resultFiles.filter((f) => f.endsWith('.xml')));
      const state = exitCode === 0 ? JOB_STATES.PASSED : JOB_STATES.FAILED;
      await this.client.post(`/jobs/${job.id}/result`, { state, exitCode, summary });
    } catch (err) {
      logShipper.push('runner', `ERROR: ${err.message}`);
      if (!this.canceled) {
        await this.client
          .post(`/jobs/${job.id}/result`, { state: JOB_STATES.ERROR, exitCode: null, summary: { error: err.message } })
          .catch(() => {});
      }
    } finally {
      await executor.teardown().catch(() => {});
      await logShipper.stop();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async _bail(executor, logShipper) {
    await executor.teardown().catch(() => {});
    await logShipper.stop();
  }

  _runTests(job, testsDir, executor, logShipper) {
    return new Promise((resolve, reject) => {
      const entry = path.join(testsDir, 'run-tests.sh');
      const args = ['--suite', job.spec.tests.suite || 'default', ...(job.spec.tests.args || [])];
      this.child = spawn(entry, args, {
        cwd: testsDir,
        env: { ...process.env, ...executor.envFor(), ...metaToEnv(job.spec.meta) },
      });
      this.child.stdout.on('data', (d) => logShipper.push('runner', d.toString('utf8').trimEnd()));
      this.child.stderr.on('data', (d) => logShipper.push('runner', d.toString('utf8').trimEnd()));
      this.child.on('error', reject);
      this.child.on('exit', (code) => {
        this.child = null;
        resolve(code ?? 1);
      });
    });
  }
}

// Exposes `--meta key=value` from the Agent (§7.1 — CI job id, git repo/
// branch/sha/tag, etc.) to run-tests.sh as THUB_META_<KEY> env vars, e.g.
// `--meta ciJobId=123` -> THUB_META_CI_JOB_ID=123.
function metaToEnv(meta) {
  const env = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const envKey = key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .toUpperCase();
    env[`THUB_META_${envKey}`] = String(value);
  }
  return env;
}

function collectResultFiles(testsDir, artifactsDir) {
  const files = [];
  for (const name of ['flash.log', 'console.log']) {
    const p = path.join(testsDir, name);
    if (fs.existsSync(p)) files.push(p);
  }
  const results = path.join(testsDir, 'results');
  for (const dir of [results, artifactsDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) files.push(path.join(dir, f));
  }
  return files;
}

function summarizeJUnit(xmlFiles) {
  let total = 0,
    failed = 0,
    skipped = 0;
  for (const file of xmlFiles) {
    const xml = fs.readFileSync(file, 'utf8');
    for (const match of xml.matchAll(/<testsuite\b[^>]*>/g)) {
      const attr = (name) => Number(new RegExp(`${name}="(\\d+)"`).exec(match[0])?.[1] || 0);
      total += attr('tests');
      failed += attr('failures') + attr('errors');
      skipped += attr('skipped');
    }
  }
  return { total, passed: Math.max(total - failed - skipped, 0), failed, skipped };
}

module.exports = { JobRunner };
