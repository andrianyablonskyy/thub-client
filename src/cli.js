#!/usr/bin/env node

/**
 * @file        packages/client/src/cli.js
 * @description thub-client control CLI: lock/unlock/status/stop/restart against the local daemon, and
 *              register/deregister of Client instances on this host (README §8.4)
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
  { spawn, spawnSync } = require('node:child_process'),
  { Command } = require('commander'),
  { loadConfig } = require('./config'),
  { sendCommand } = require('./control-socket'),
  { register, deregister } = require('./instances'),
  { PACKAGES, fetchLatestVersion, isNewer, isValidVersion, npmBin } = require('@andrian.yablonskyy/thub-common'),
  { version } = require('../package.json');

const DAEMON_ENTRY = path.join(__dirname, 'daemon.js'),
  // Bounded by runner.js's KILL_GRACE_MS (10s) for an active job's SIGTERM
  // -> SIGKILL, plus teardown overhead — see daemon.js's stop().
  STOP_TIMEOUT_MS = 20_000,

  // §8.4: "sudo thub-client lock --reason ... / sudo thub-client unlock"
  program = new Command();
program
  .name('thub-client')
  .description('Control the local thub-client daemon')
  .option(
    '-c, --config <path>',
    'Path to this Client\'s config file (overrides THUB_CLIENT_CONFIG). Required to target a ' +
      'specific instance when running several Clients on one host (§8.6) — must come before the ' +
      'subcommand, e.g. `thub-client --config /etc/thub/dut1.json stop`.'
  );

// Every subcommand loads its own config fresh (rather than once at startup)
// so `--config`/THUB_CLIENT_CONFIG is re-read per invocation — the same
// instance a `thub-client --config dut1.json stop` targets is the one whose
// pidFile/socketPath get used, never a stale default from process start.
function config(){
  return loadConfig(program.opts().config);
}

function socketPath(){
  return config().socketPath;
}

function readPid(pidFile){
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  catch {
    return null;
  }
}

function isAlive(pid){
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs, intervalMs = 200){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    if (await predicate()){
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

// Stops the daemon by pidfile + SIGTERM rather than over the control
// socket, so it still works even if the socket itself is wedged. SIGTERM
// triggers the same graceful shutdown as Ctrl-C: finish any active job,
// then exit (daemon.js's stop()/start()).
async function stopDaemon(config){
  const pid = readPid(config.pidFile);
  if (!pid || !isAlive(pid)){
    console.log('Not running.');
    return true;
  }
  process.kill(pid, 'SIGTERM');
  const exited = await waitUntil(() => !isAlive(pid), STOP_TIMEOUT_MS);
  if (!exited){
    console.error(`Timed out waiting for pid ${pid} to stop (still running after ${STOP_TIMEOUT_MS / 1000}s).`);
    return false;
  }
  console.log(`Stopped (pid ${pid}).`);
  return true;
}

function startDaemon(config){
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, THUB_CLIENT_CONFIG: config.configPath }
  });
  child.unref();
  return child.pid;
}

program
  .command('lock')
  .description('Take the bench for manual work (-> BUSY, source=local)')
  .requiredOption('--reason <reason>')
  .action(async (opts) => {
    const res = await sendCommand(socketPath(), { cmd: 'lock', reason: opts.reason });
    console.log(res.ok ? 'Locked.' : `Error: ${res.error}`);
    process.exit(res.ok ? 0 : 1);
  });

program
  .command('unlock')
  .description('Release the bench (-> IDLE)')
  .action(async () => {
    const res = await sendCommand(socketPath(), { cmd: 'unlock' });
    console.log(res.ok ? 'Unlocked.' : `Error: ${res.error}`);
    process.exit(res.ok ? 0 : 1);
  });

program
  .command('status')
  .description('Show the daemon\'s current state')
  .action(async () => {
    const res = await sendCommand(socketPath(), { cmd: 'status' });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  });

program
  .command('stop')
  .description('Gracefully stop the daemon (finishes an active job first, then exits)')
  .action(async () => {
    const ok = await stopDaemon(config());
    process.exit(ok ? 0 : 1);
  });

program
  .command('restart')
  .description('Stop the daemon (if running) and start a new one with the same config')
  .action(async () => {
    const cfg = config(),
      stopped = await stopDaemon(cfg);
    if (!stopped){
      process.exit(1);
    }

    const pid = startDaemon(cfg);
    // Give it a moment to crash on a startup error (bad config, port in
    // use, etc.) before declaring victory — spawn() returning doesn't mean
    // the new process is actually going to stay up.
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (!isAlive(pid)){
      console.error(`New process (pid ${pid}) exited immediately — check its logs.`);
      process.exit(1);
    }
    console.log(`Restarted (pid ${pid}).`);
  });

// Instance management (README "Several DUT slots on one host"): the
// instance's config file plus its thub-client@<name> systemd unit.
function runOrExit(fn){
  try {
    fn();
  }
  catch (err){
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

program
  .command('register')
  .description('Create (or update) the ~/.config/thub/<name>.json instance and enable/start thub-client@<name>')
  .option('-n, --name <name>', 'Instance name — also the Client\'s resource name', 'client')
  .option('-t, --type <type>', 'Client type: hw or sw', 'hw')
  .action((opts) => runOrExit(() => register(opts.name, opts.type)));

program
  .command('deregister')
  .description('Stop/disable thub-client@<name> and remove its config (client.json itself is kept)')
  .option('-n, --name <name>', 'Instance name', 'client')
  .action((opts) => runOrExit(() => deregister(opts.name)));

// Manual update (README §10.2); the Coordinator-initiated one goes
// through thub-client-update.service instead.
program
  .command('check-update')
  .description('Compare this Client with the latest published version')
  .action(async () => {
    try {
      const latest = await fetchLatestVersion(PACKAGES.client);
      console.log(`Installed: v${version}  Latest: v${latest}`);
      console.log(isNewer(latest, version) ? 'Update available: thub-client self-update' : 'Up to date.');
    }
    catch (err){
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('self-update')
  .description('Update this Client with sudo npm i -g (restarts every running instance)')
  .option('--to <x.y.z>', 'Install this version instead of the latest')
  .action(async (opts) => {
    try {
      const target = opts.to || await fetchLatestVersion(PACKAGES.client);
      if (!isValidVersion(target)){
        throw new Error(`Invalid version "${target}"`);
      }
      if (!opts.to && !isNewer(target, version)){
        console.log(`Already on v${version}.`);
        return;
      }
      const npmArgs = ['i', '-g', `${PACKAGES.client}@${target}`],
        [bin, argv] = process.getuid?.() === 0 ? [npmBin(), npmArgs] : ['sudo', [npmBin(), ...npmArgs]];
      console.log(`Updating v${version} -> v${target}: ${[bin, ...argv].join(' ')}`);
      process.exit(spawnSync(bin, argv, { stdio: 'inherit' }).status ?? 1);
    }
    catch (err){
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
