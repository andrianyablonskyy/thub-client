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

  // `reportResult`: true when this is an operator-initiated stop
  // (daemon.js's stop(), via `thub-client stop`) rather than a
  // Coordinator-driven `cancel-job` command — in the latter case the
  // Coordinator already transitioned the job itself (§5.1), so posting a
  // result here would be redundant; in the former, nobody else will ever
  // tell the Coordinator this job stopped, so this runner has to.
  cancel(reportResult = false) {
    this.canceled = true;
    this.reportResult = reportResult;
    if (this.child) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }
  }

  // Mirrors what someone following the job through the Agent CLI or
  // dashboard would see (§7.1) — state transitions and the final verdict —
  // printed locally too, so the terminal running the daemon itself shows
  // what it's doing instead of going silent for the whole job.
  _announce(state) {
    console.log(`-- ${state} on ${this.config.name} --`);
  }

  _announceFinished(state) {
    console.log(`\nJob finished: ${state}`);
  }

  async run(job) {
    const jobDir = path.join(this.config.workDir, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const logShipper = new LogShipper(this.client, job.id, this.config);

    if (job.spec.dryRun) {
      return this._runDryRun(job, jobDir, logShipper);
    }

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
      if (this.canceled) return this._bail(job, executor, logShipper);

      logShipper.push('runner', 'preparing DUT');
      await executor.prepare(job, job.spec.target.type === 'hw' ? fwPath : path.dirname(fwPath));
      if (this.canceled) return this._bail(job, executor, logShipper);

      await this.client.post(`/jobs/${job.id}/state`, { state: JOB_STATES.RUNNING });
      this._announce(JOB_STATES.RUNNING);

      const exitCode = await this._runTests(job, testsDir, executor, logShipper);
      if (this.canceled) return this._bail(job, executor, logShipper);

      const artifactsDir = path.join(testsDir, 'artifacts');
      const resultFiles = collectResultFiles(testsDir, artifactsDir);
      if (resultFiles.length) {
        await this.client.postArtifacts(job.id, resultFiles);
      }

      const summary = summarizeJUnit(resultFiles.filter((f) => f.endsWith('.xml')));
      const state = exitCode === 0 ? JOB_STATES.PASSED : JOB_STATES.FAILED;
      await this.client.post(`/jobs/${job.id}/result`, { state, exitCode, summary });
      this._announce(state);
      this._announceFinished(state);
    } catch (err) {
      logShipper.push('runner', `ERROR: ${err.message}`);
      if (!this.canceled) {
        await this.client
          .post(`/jobs/${job.id}/result`, { state: JOB_STATES.ERROR, exitCode: null, summary: { error: err.message } })
          .catch(() => {});
        this._announce(JOB_STATES.ERROR);
        this._announceFinished(JOB_STATES.ERROR);
      }
    } finally {
      await executor.teardown().catch(() => {});
      await logShipper.stop();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async _bail(job, executor, logShipper) {
    await executor.teardown().catch(() => {});
    await this._reportStoppedIfNeeded(job.id);
    await logShipper.stop();
  }

  async _reportStoppedIfNeeded(jobId) {
    if (!this.reportResult) return;
    this._announce(JOB_STATES.ERROR);
    this._announceFinished(JOB_STATES.ERROR);
    await this.client
      .post(`/jobs/${jobId}/result`, {
        state: JOB_STATES.ERROR,
        exitCode: null,
        summary: { error: 'Client stopped by operator (thub-client stop)' },
      })
      .catch(() => {});
  }

  // Dry run (§7.1): walks the same job lifecycle and API calls as a real
  // job — accept, PREPARING/RUNNING transitions, log lines, an artifact,
  // a result — but never downloads firmware/tests, never touches an
  // executor (no Docker, no ST-Link/serial), and never spawns run-tests.sh.
  // Useful for proving the Coordinator<->Client plumbing end-to-end
  // without needing real hardware, a real emulator image, or a real
  // Artifactory.
  async _runDryRun(job, jobDir, logShipper) {
    try {
      await this.client.post(`/jobs/${job.id}/accept`);
      if (this.canceled) return this._reportStoppedIfNeeded(job.id);

      logShipper.push('runner', '[dry-run] no commands will be executed on this Client');
      logShipper.push(
        'runner',
        `[dry-run] target: ${job.spec.target.type} labels=${(job.spec.target.labels || []).join(',') || '(none)'}`
      );
      logShipper.push(
        'runner',
        `[dry-run] would download firmware ${job.spec.firmware.url}` +
          (job.spec.firmware.sha256 ? ` (sha256 ${job.spec.firmware.sha256})` : '')
      );
      logShipper.push('runner', `[dry-run] would download tests ${job.spec.tests.url}`);
      const suite = job.spec.tests.suite || 'default';
      const args = job.spec.tests.args || [];
      logShipper.push(
        'runner',
        `[dry-run] would run: run-tests.sh --suite ${suite}${args.length ? ' ' + args.join(' ') : ''}`
      );
      for (const [key, value] of Object.entries(metaToEnv(job.spec.meta))) {
        logShipper.push('runner', `[dry-run] ${key}=${value}`);
      }
      if (this.canceled) return this._reportStoppedIfNeeded(job.id);

      await this.client.post(`/jobs/${job.id}/state`, { state: JOB_STATES.RUNNING });
      this._announce(JOB_STATES.RUNNING);
      logShipper.push('runner', '[dry-run] simulating test run...');
      await sleep(500);
      if (this.canceled) return this._reportStoppedIfNeeded(job.id);

      logShipper.push('runner', '[dry-run] done — no real verdict; reporting PASSED');
      const reportPath = path.join(jobDir, 'dry-run-report.txt');
      fs.writeFileSync(reportPath, dryRunReport(job));
      await this.client.postArtifacts(job.id, [reportPath]);

      await this.client.post(`/jobs/${job.id}/result`, {
        state: JOB_STATES.PASSED,
        exitCode: 0,
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, dryRun: true },
      });
      this._announce(JOB_STATES.PASSED);
      this._announceFinished(JOB_STATES.PASSED);
    } catch (err) {
      logShipper.push('runner', `ERROR: ${err.message}`);
      if (!this.canceled) {
        await this.client
          .post(`/jobs/${job.id}/result`, { state: JOB_STATES.ERROR, exitCode: null, summary: { error: err.message } })
          .catch(() => {});
        this._announce(JOB_STATES.ERROR);
        this._announceFinished(JOB_STATES.ERROR);
      }
    } finally {
      await logShipper.stop();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
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

function dryRunReport(job) {
  return (
    `TestHub dry run — no commands were executed on this Client.\n\n` +
    `job:      ${job.id}\n` +
    `target:   ${job.spec.target.type} labels=${(job.spec.target.labels || []).join(',') || '(none)'}\n` +
    `firmware: ${job.spec.firmware.url}\n` +
    `tests:    ${job.spec.tests.url} (suite=${job.spec.tests.suite || 'default'})\n` +
    `meta:     ${JSON.stringify(job.spec.meta || {})}\n`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { JobRunner };
