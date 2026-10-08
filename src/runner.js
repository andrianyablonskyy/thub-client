/**
 * @file        packages/client/src/runner.js
 * @description Executes a single job end-to-end on the Client: download, run, report, cleanup (README §8.1)
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
  { spawn } = require('node:child_process'),
  { JOB_STATES, JOB_ENV_MASK } = require('@andrian.yablonskyy/thub-common'),
  { prepareTask, planTask, shellQuote, shellJoin } = require('./downloader'),
  { LogShipper } = require('./log-shipper'),
  { jobParamsEnv, envKey } = require('./job-params-env'),
  { HwExecutor } = require('./executors/hw'),
  { SwExecutor } = require('./executors/sw'),
  { UsbPower } = require('./usb-power');

const KILL_GRACE_MS = 10_000;

// §8.1 Job execution lifecycle on the Client.
class JobRunner{
  // `usbPower`: the daemon's UsbPower (one per Client, so requests never
  // overlap); a new one from the config when not given.
  constructor(client, config, { usbPower } = {}){
    this.client = client;
    this.config = config;
    this.usbPower = usbPower || new UsbPower(config.hw?.usbPower?.ports);
    this.logShipper = null;
    // Set once the job is accepted: only then does its end switch power.
    this.accepted = false;
    this.endPowerDone = false;
    this.canceled = false;
    this.child = null;
    // Aborts downloads in progress on cancel — without it a cancel only
    // lands between steps, and a hung download server would never let go.
    this.abort = new AbortController();
    this.jobUser = null;
  }

  // `reportResult`: true when this is an operator-initiated stop
  // (daemon.js's stop(), via `thub-client stop`) rather than a
  // Coordinator-driven `cancel-job` command — in the latter case the
  // Coordinator already transitioned the job itself (§5.1), so posting a
  // result here would be redundant; in the former, nobody else will ever
  // tell the Coordinator this job stopped, so this runner has to.
  cancel(reportResult = false){
    this.canceled = true;
    this.reportResult = reportResult;
    this.abort.abort();
    if (this.child){
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed){
          this.child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
    }
  }

  // Mirrors what someone following the job through the Agent CLI or
  // dashboard would see (§7.1) — state transitions and the final verdict —
  // printed locally too, so the terminal running the daemon itself shows
  // what it's doing instead of going silent for the whole job. Includes
  // `spec.user` (`thub run --user`, §7.1) when set — purely a label so
  // whoever's at the bench can tell whose job is running, no different
  // from `busySource`/`busyReason` for a manual lock.
  _announce(state){
    const owner = this.jobUser ? ` (user: ${this.jobUser})` : '';
    console.log(`-- ${state} on ${this.config.name}${owner} --`);
  }

  _announceFinished(state){
    console.log(`\nJob finished: ${state}`);
  }

  async run(job){
    this.jobUser = job.spec.user;
    const jobDir = path.join(this.config.workDir, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const logShipper = new LogShipper(this.client, job.id, this.config);
    this.logShipper = logShipper;

    if (job.spec.dryRun){
      return this._runDryRun(job, jobDir, logShipper);
    }

    const executor =
      job.spec.target.type === 'hw'
        ? new HwExecutor(this.config, logShipper)
        : new SwExecutor(this.config, logShipper);

    try {
      await this.client.post(`/jobs/${job.id}/accept`);
      this.accepted = true;
      // Before downloading anything: a job asking for USB power this
      // Client can't switch fails at once.
      const { onStart, onEnd } = job.spec.power || {};
      if ((onStart || onEnd) && !this.usbPower.configured){
        throw new Error('the job sets --power-on-start/--power-on-end, but this Client has no USB power ports (hw-devices.usbPower.ports)');
      }

      // The task's inputs first: its downloaded files (README §8.1). A git
      // checkout or a container is the command's own business.
      const task = await prepareTask(job.spec, jobDir, {
        signal: this.abort.signal,
        log: (line) => logShipper.push('runner', line)
      });
      this.task = task;
      if (this.canceled){
        return this._bail(job, executor, logShipper);
      }

      if (onStart){
        await this._power(onStart, job.spec.power, 'job start');
      }
      if (this.canceled){
        return this._bail(job, executor, logShipper);
      }

      logShipper.push('runner', 'preparing DUT');
      await executor.prepare(job, task.downloads.length ? task.downloadsDir : null);
      if (this.canceled){
        return this._bail(job, executor, logShipper);
      }

      await this.client.post(`/jobs/${job.id}/state`, { state: JOB_STATES.RUNNING });
      this._announce(JOB_STATES.RUNNING);

      const exitCode = await this._runCommand(job, task, executor, logShipper);
      if (this.canceled){
        return this._bail(job, executor, logShipper);
      }
      await this._endPower(job);

      // Nothing is uploaded (README §8.1): the job's files stay in its
      // workspace, deleted when it ends. The JUnit counts are read here and
      // reported with the result; the verdict is still the exit code.
      const summary = summarizeJUnit(junitFiles(task.workDir)),
        artifacts = readArtifactsList(artifactsFile(task), (line) => logShipper.push('runner', line)),
        state = exitCode === 0 ? JOB_STATES.PASSED : JOB_STATES.FAILED;
      await logShipper.drain().catch(() => {}); // all output in before the stream ends
      await this.client.post(`/jobs/${job.id}/result`, { state, exitCode, summary, ...(artifacts ? { artifacts } : {}) });
      this._announce(state);
      this._announceFinished(state);
    }
    catch (err){
      logShipper.push('runner', this.canceled ? 'job canceled' : `ERROR: ${err.message}`);
      await this._endPower(job);
      if (!this.canceled){
        await logShipper.drain().catch(() => {});
        await this.client
          .post(`/jobs/${job.id}/result`, { state: JOB_STATES.ERROR, exitCode: null, summary: { error: err.message } })
          .catch(() => {});
        this._announce(JOB_STATES.ERROR);
        this._announceFinished(JOB_STATES.ERROR);
      }
    }
    finally {
      await executor.teardown().catch(() => {});
      await this._endPower(job);
      await logShipper.stop();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async _bail(job, executor, logShipper){
    await executor.teardown().catch(() => {});
    await this._endPower(job);
    await this._reportStoppedIfNeeded(job.id);
    await logShipper.stop();
  }

  async _reportStoppedIfNeeded(jobId){
    if (!this.reportResult){
      return;
    }
    this._announce(JOB_STATES.ERROR);
    this._announceFinished(JOB_STATES.ERROR);
    await this.client
      .post(`/jobs/${jobId}/result`, {
        state: JOB_STATES.ERROR,
        exitCode: null,
        summary: { error: 'Client stopped by operator (thub-client stop)' }
      })
      .catch(() => {});
  }

  // A job's --power-on-start/--power-on-end action. Throws (the job ends
  // in ERROR) when it fails at the start.
  async _power(action, { resetDelaySec } = {}, when){
    this.logShipper.push('runner', `${when}: USB power ${action}`);
    await this.usbPower.apply(action, { delaySec: action === 'reset' ? resetDelaySec : undefined, log: (l) => this.logShipper.push('runner', l) });
  }

  // --power-on-end, once, whatever the verdict (canceled and failed jobs
  // included) — before the result is reported where there is one, so it's
  // in the job's log. A failure here is logged; it doesn't change the verdict.
  async _endPower(job){
    const action = job.spec.power?.onEnd;
    if (!action || !this.accepted || this.endPowerDone || !this.usbPower.configured){
      return;
    }
    this.endPowerDone = true;
    await this._power(action, job.spec.power, 'job end')
      .catch((err) => this.logShipper.push('runner', `job end: USB power ${action} failed: ${err.message}`));
  }

  // Switches USB power while the job runs — asked by its owner (`thub
  // power`, through the Coordinator) or on this host (`thub-client power`).
  // `from`: who asked, for the job's log. Throws with why it failed.
  async powerNow(action, { delaySec, port, from } = {}){
    const log = (line) => this.logShipper?.push('runner', line);
    log(`USB power ${action}${port ? ` (port ${port})` : ''} requested${from ? ` by ${from}` : ''}`);
    try {
      await this.usbPower.apply(action, { delaySec, port, log });
    }
    catch (err){
      log(`USB power ${action} failed: ${err.message}`);
      throw err;
    }
  }

  // Dry run (§7.1): walks the same job lifecycle and API calls as a real
  // job — accept, PREPARING/RUNNING transitions, log lines, a result —
  // but never downloads anything, never touches an executor (no
  // ST-Link/serial), and never runs the command. Instead it logs every step
  // the real job would take on this Client (the downloads, the HW
  // executor's, the job's command with its working directory and
  // environment), plus what this Client's config would refuse. Useful for
  // proving the Coordinator<->Client plumbing end-to-end, and checking a
  // job, without real hardware or reachable download servers.
  async _runDryRun(job, jobDir, logShipper){
    try {
      await this.client.post(`/jobs/${job.id}/accept`);
      if (this.canceled){
        return this._reportStoppedIfNeeded(job.id);
      }

      const plan = dryRunPlan(job, jobDir, this.config);
      for (const line of plan){
        logShipper.push('runner', `[dry-run] ${line}`);
      }
      if (this.canceled){
        return this._reportStoppedIfNeeded(job.id);
      }

      await this.client.post(`/jobs/${job.id}/state`, { state: JOB_STATES.RUNNING });
      this._announce(JOB_STATES.RUNNING);
      logShipper.push('runner', '[dry-run] simulating test run...');
      await sleep(500);
      if (this.canceled){
        return this._reportStoppedIfNeeded(job.id);
      }

      logShipper.push('runner', '[dry-run] done — no real verdict; reporting PASSED');

      await this.client.post(`/jobs/${job.id}/result`, {
        state: JOB_STATES.PASSED,
        exitCode: 0,
        summary: { total: 0, passed: 0, failed: 0, skipped: 0, dryRun: true }
      });
      this._announce(JOB_STATES.PASSED);
      this._announceFinished(JOB_STATES.PASSED);
    }
    catch (err){
      logShipper.push('runner', `ERROR: ${err.message}`);
      if (!this.canceled){
        await this.client
          .post(`/jobs/${job.id}/result`, { state: JOB_STATES.ERROR, exitCode: null, summary: { error: err.message } })
          .catch(() => {});
        this._announce(JOB_STATES.ERROR);
        this._announceFinished(JOB_STATES.ERROR);
      }
    }
    finally {
      await logShipper.stop();
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  // The task's entry point: `sh -c <command>` in the work directory, --arg
  // values as "$@", with the job's environment — its --env, its parameters
  // (JOB_*), its downloads (THUB_DOWNLOADS_DIR, THUB_DOWNLOAD_<n>,
  // THUB_DOWNLOADS) and --meta values.
  _runCommand(job, task, executor, logShipper){
    return new Promise((resolve, reject) => {
      logShipper.push('runner', `running: ${describeCommand(job.spec)}`);
      this.child = spawn('sh', commandArgs(job.spec), {
        cwd: task.workDir,
        env: { ...process.env, ...jobEnv(job, task, executor.envFor(), this.config.name) }
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

// `sh -c <command> thub-job <args...>`: the job's --command, with its --arg
// values as "$@".
function commandArgs(spec){
  return ['-c', spec.command, 'thub-job', ...(spec.args || [])];
}

// What the job's command gets on top of the Client's own environment: a
// DOCKER_CONFIG in the job directory (its --env may set its own), its --env
// as given (no name means anything to the Client), its parameters as JOB_*
// (job-params-env.js), then the Client's own THUB_* (the job spec refuses
// both prefixes in --env).
function jobEnv(job, task, executorEnv, clientName){
  return {
    DOCKER_CONFIG: dockerConfigDir(task),
    ...job.spec.env,
    ...jobParamsEnv(job.spec, { clientName }),
    ...executorEnv,
    ...metaToEnv(job.spec.meta),
    ...downloadsEnv(task),
    THUB_JOB_ID: job.id,
    THUB_WORK_DIR: task.workDir,
    THUB_ARTIFACTS_FILE: artifactsFile(task)
  };
}

// The dry run's log: every step the real job would take on this Client, in
// order, with full commands.
function dryRunPlan(job, jobDir, config){
  const { spec } = job,
    usbPower = new UsbPower(config.hw?.usbPower?.ports),
    powerProblems = [],
    powerPlan = (action) => {
      if (!action){
        return [];
      }
      try {
        return usbPower.plan(action, { delaySec: action === 'reset' ? spec.power.resetDelaySec : undefined });
      }
      catch (err){
        powerProblems.push(`USB power ${action}: ${err.message}`);
        return [];
      }
    },
    executor = spec.target.type === 'hw' ? new HwExecutor(config, null) : new SwExecutor(config, null),
    { task, steps: inputs } = planTask(spec, jobDir),
    dut = executor.plan(job, task.downloads.length ? task.downloadsDir : null),
    env = jobEnv(job, task, dut.env, config.name),
    jobEnvNames = Object.keys(spec.env || {}),
    section = (title, lines) => (lines.length ? [`${title}:`, ...lines.map((l) => `  ${l}`)] : []);
  return [
    'nothing below is executed on this Client — these are the commands the real job would run',
    `target: ${spec.target.type} labels=${(spec.target.labels || []).join(',') || '(none)'}`,
    // --env values are treated as secrets whatever their names: never logged.
    ...section('job environment (--env, values hidden), for every command below', jobEnvNames.map((k) => `${k}=${JOB_ENV_MASK}`)),
    ...section('task inputs', inputs),
    ...section('USB power at job start', powerPlan(spec.power?.onStart)),
    ...section('DUT (HW executor)', dut.steps),
    ...section('command', [
      `cd ${shellQuote(task.workDir)}`,
      ...Object.entries(env).filter(([k]) => !jobEnvNames.includes(k)).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
      shellJoin(['sh', ...commandArgs(spec)])
    ]),
    ...section('then, whatever the result', [...dut.teardown, ...powerPlan(spec.power?.onEnd)]),
    ...[...new Set(powerProblems)].map((p) => `WOULD FAIL: ${p}`),
    ...(dut.problems || []).map((p) => `WOULD FAIL: ${p}`)
  ];
}

function describeCommand(spec){
  const args = spec.args || [];
  return `sh -c ${JSON.stringify(spec.command)}${args.length ? ` (args: ${args.join(' ')})` : ''}`;
}

// THUB_DOWNLOAD_<n> (1-based, the job's order), THUB_DOWNLOADS (all of them,
// one per line) and THUB_DOWNLOADS_DIR.
function downloadsEnv(task){
  if (!task.downloads.length){
    return {};
  }
  return {
    THUB_DOWNLOADS_DIR: task.downloadsDir,
    THUB_DOWNLOADS: task.downloads.join('\n'),
    ...Object.fromEntries(task.downloads.map((p, i) => [`THUB_DOWNLOAD_${i + 1}`, p]))
  };
}

// Exposes `--meta key=value` from the Agent (§7.1 — CI job id, git repo/
// branch/sha/tag, etc.) to the command as THUB_META_<KEY> env vars, e.g.
// `--meta ciJobId=123` -> THUB_META_CI_JOB_ID=123.
function metaToEnv(meta){
  const env = {};
  for (const [key, value]of Object.entries(meta || {})){
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'){
      continue;
    }
    env[`THUB_META_${envKey(key)}`] = String(value);
  }
  return env;
}

// Where the command may list the artifacts it published elsewhere (README
// §7.3): a JSON array of {name, size, link, timestamp}, in the work
// directory, beside (not in) whatever the command clones there.
function artifactsFile(task){
  return path.join(task.workDir, 'artifacts.json');
}

// The job's own Docker config ($DOCKER_CONFIG, unless --env sets one): a
// `docker login` in the command lands in the job directory, deleted with
// it — never in the service user's ~/.docker for every later job. Kept
// outside what examples mount into containers (`src/`).
function dockerConfigDir(task){
  return path.join(task.workDir, '.docker');
}

const ARTIFACTS_FILE_MAX_BYTES = 1024 * 1024;

// The list, as the command wrote it, for the result — the Coordinator checks
// each entry. A missing file is no list; a broken one is said so in the
// job's log and doesn't change the verdict.
function readArtifactsList(file, log){
  let text;
  try {
    if (fs.statSync(file).size > ARTIFACTS_FILE_MAX_BYTES){
      log(`THUB_ARTIFACTS_FILE ignored: larger than ${ARTIFACTS_FILE_MAX_BYTES / 1024} KB`);
      return undefined;
    }
    text = fs.readFileSync(file, 'utf8');
  }
  catch {
    return undefined; // the job reported none
  }
  let list;
  try {
    list = JSON.parse(text);
  }
  catch (err){
    log(`THUB_ARTIFACTS_FILE ignored: not valid JSON (${err.message})`);
    return undefined;
  }
  if (!Array.isArray(list)){
    log('THUB_ARTIFACTS_FILE ignored: it must hold a JSON array of {"name", "size", "link", "timestamp"}');
    return undefined;
  }
  log(`reported ${list.length} artifact(s)`);
  return list;
}

// JUnit XML the tests left in results/ or artifacts/ of the work directory.
// JUnit XML under `results/` or `artifacts/`, in the work directory or in a
// folder the command made there (`src/results/`, after a clone into src).
const NOT_SCANNED = new Set(['downloads', '.docker']);
function junitFiles(workDir){
  const bases = [workDir];
  try {
    bases.push(...fs.readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NOT_SCANNED.has(e.name) && !['results', 'artifacts'].includes(e.name))
      .map((e) => path.join(workDir, e.name)));
  }
  catch {
    // no work directory: nothing to read
  }
  return bases.flatMap((base) => ['results', 'artifacts'].flatMap((name) => {
    const dir = path.join(base, name);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.xml')).map((f) => path.join(dir, f)) : [];
  }));
}

function summarizeJUnit(xmlFiles){
  let total = 0,
    failed = 0,
    skipped = 0;
  for (const file of xmlFiles){
    const xml = fs.readFileSync(file, 'utf8');
    for (const match of xml.matchAll(/<testsuite\b[^>]*>/g)){
      const attr = (name) => Number(new RegExp(`${name}="(\\d+)"`).exec(match[0])?.[1] || 0);
      total += attr('tests');
      failed += attr('failures') + attr('errors');
      // GoogleTest and CTest count tests that never ran (DISABLED_) apart.
      skipped += attr('skipped') + attr('disabled');
    }
  }
  return { total, passed: Math.max(total - failed - skipped, 0), failed, skipped };
}

function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { JobRunner, dryRunPlan, readArtifactsList, jobEnv, junitFiles, summarizeJUnit };
