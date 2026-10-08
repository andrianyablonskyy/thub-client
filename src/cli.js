#!/usr/bin/env node

/**
 * @file        packages/client/src/cli.js
 * @description thub-client control CLI: lock/unlock/status/stop/restart/power against the local daemon, and
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
  { loadConfig, loadDeviceConfig } = require('./config'),
  { renderRules, syncUdevRules } = require('./udev'),
  { sendCommand } = require('./control-socket'),
  { register, deregister } = require('./instances'),
  {
    PACKAGES, NPM_INSTALL_ARGS, fetchLatestVersion, installSpec, isNewer, isValidVersion, npmBin, POWER_ACTIONS, DEFAULT_RESET_DELAY_SEC,
    powerRequestErrors
  } = require('@andrian.yablonskyy/thub-common'),
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

// §8.7: USB port power through the daemon (it runs uhubctl), so it's
// serialized with a job's own power actions and shows in its log.
program
  .command('power')
  .description('Switch this Client\'s USB power ports (hw-devices.usbPower) with uhubctl, or show their state')
  .argument('<action>', 'on | off | reset | status')
  .option('--port <n>', 'Only this port: its 1-based position in hw-devices.usbPower.ports (default: all of them)', (v) => Number(v))
  .option('--delay <sec>', `reset: seconds between off and on (default ${DEFAULT_RESET_DELAY_SEC})`, (v) => Number(v))
  .action(async (action, opts) => {
    const errors = action === 'status'
      ? powerRequestErrors({ action: 'on', port: opts.port })
      : powerRequestErrors({ action, delaySec: opts.delay, port: opts.port });
    if (errors.length){
      console.error(`Error: ${action === 'status' || POWER_ACTIONS.includes(action) ? errors.join('; ') : 'the action must be on, off, reset or status'}`);
      process.exit(1);
    }
    const res = await sendCommand(socketPath(), { cmd: 'power', action, delaySec: opts.delay, port: opts.port });
    if (!res.ok){
      console.error(`Error: ${res.error}`);
      process.exit(1);
    }
    if (action !== 'status'){
      console.log(`USB power ${action}: done.`);
    }
    for (const p of res.ports || []){
      console.log(`  ${p.number}. hub ${p.hub} port ${p.port}: ${p.power === null ? 'unknown' : p.power ? 'on' : 'off'}${p.status ? `  (${p.status})` : ''}`);
    }
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

// The daemon does this on every start (README §8.2); this is for applying
// a config change without a restart, or previewing the generated rules.
program
  .command('udev')
  .description('Install this instance\'s udev rules from its hw.* config (needs root), or print them')
  .option('--print', 'Only print the rules the config would generate', false)
  .action((opts) => runOrExit(() => {
    const cfg = loadDeviceConfig(program.opts().config);
    if (opts.print){
      process.stdout.write(renderRules(cfg) || '# no hw.* entries with a devpath — no rules\n');
      return;
    }
    const { status, file } = syncUdevRules(cfg);
    if (status === 'needs-root'){
      throw new Error(`${file} needs updating — run this as root (sudo)`);
    }
    console.log(status === 'skipped' ? 'udev: not Linux — nothing to do' : `udev: ${file} ${status}`);
  }));

// Manual update (README §10.2); the Coordinator-initiated one goes
// through thub-client-update.service instead.
program
  .command('check-update')
  .description('Compare this Client with the latest release (its repository\'s newest vX.Y.Z tag)')
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
  .description('Update this Client from its git repository with sudo npm i -g (restarts every running instance)')
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
      const npmArgs = [...NPM_INSTALL_ARGS, installSpec(PACKAGES.client, target)],
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
