/**
 * @file        packages/client/test/reboot.test.js
 * @description Tests: scheduled host reboot — the Client's scheduler and the root reboot helper (with a fake systemctl)
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net'),
  { spawn } = require('node:child_process'),
  { RebootScheduler } = require('../src/reboot-schedule'),
  { readHold, writeHold } = require('../src/host-hold');

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function scheduler(dir, clock, extra = {}){
  const pathUnit = path.join(dir, 'thub-client-reboot.path');
  fs.writeFileSync(pathUnit, '');
  return new RebootScheduler({
    scheduleFile: path.join(dir, 'dut1', 'reboot-schedule.json'),
    requestFile: path.join(dir, 'reboot-request.json'),
    holdFile: path.join(dir, 'update-hold.json'),
    instance: 'dut1',
    pathUnit,
    now: () => clock.now,
    log: quiet,
    ...extra
  });
}

test('the schedule is applied, persisted across restarts, and cleared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-reboot-')),
    clock = { now: new Date(2026, 8, 29, 12, 0) },
    s = scheduler(dir, clock);
  assert.equal(s.load(), null);
  assert.equal(s.set('30 3 * * sun'), '30 3 * * sun');
  assert.equal(scheduler(dir, clock).load(), '30 3 * * sun'); // a restarted daemon
  assert.equal(s.set('61 * * * *'), '30 3 * * sun'); // invalid: refused, current kept
  assert.equal(s.set(null), null);
  assert.equal(scheduler(dir, clock).load(), null);
});

test('when due it asks for a reboot once per matching minute, not while the host is held', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-reboot-')),
    clock = { now: new Date(2026, 8, 29, 3, 29, 50) }, // local time: cron runs in the host's zone
    s = scheduler(dir, clock),
    request = path.join(dir, 'reboot-request.json');
  s.set('30 3 * * *');
  assert.equal(s.tick(), false);
  clock.now = new Date(2026, 8, 29, 3, 30, 5);
  assert.equal(s.tick(), true);
  assert.equal(JSON.parse(fs.readFileSync(request, 'utf8')).instance, 'dut1');
  clock.now = new Date(2026, 8, 29, 3, 30, 25);
  assert.equal(s.tick(), false); // same minute: once

  fs.rmSync(request);
  writeHold(path.join(dir, 'update-hold.json'), { reason: 'update', version: '9.9.9' });
  clock.now = new Date(2026, 8, 30, 3, 30, 1);
  assert.equal(s.tick(), false); // a self-update holds the host: skip this one
  assert.equal(fs.existsSync(request), false);
});

test('no helper installed: due reboots are only logged; cancel removes the request and a reboot hold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-reboot-')),
    clock = { now: new Date(2026, 8, 29, 3, 30) },
    s = scheduler(dir, clock, { pathUnit: path.join(dir, 'missing.path') });
  s.set('30 3 * * *');
  assert.equal(s.tick(), false);

  const t = scheduler(dir, clock),
    hold = path.join(dir, 'update-hold.json');
  fs.writeFileSync(path.join(dir, 'reboot-request.json'), '{}');
  writeHold(hold, { reason: 'reboot' });
  t.cancel();
  assert.equal(fs.existsSync(path.join(dir, 'reboot-request.json')), false);
  assert.equal(readHold(hold), null);
});

// A stand-in for a Client instance's control socket, answering `status`.
function fakeInstance(runDir, name, state){
  const server = net.createServer((sock) => sock.on('data', () => sock.end(JSON.stringify({ ok: true, ...state.status }) + '\n')));
  return new Promise((resolve) => server.listen(path.join(runDir, `${name}.sock`), () => resolve(server)));
}

function runHelper(dir, env = {}){
  const bin = path.join(dir, 'bin'),
    marker = path.join(dir, 'rebooted');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'reboot-helper.js'), path.join(dir, 'reboot-request.json'), dir], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, THUB_REBOOT_TEST_GRACE_MS: '50', THUB_REBOOT_TEST_POLL_MS: '100', ...env }
    }),
    done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { done, marker };
}

test('reboot helper: holds the host, waits for a busy instance, then reboots', async (t) => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'thub-rh-')), // short: unix socket paths are length-limited
    state = { status: { activeJobId: 'M-00001', localLock: { locked: false } } },
    server = await fakeInstance(dir, 'dut1', state);
  t.after(() => server.close());
  fs.writeFileSync(path.join(dir, 'reboot-request.json'), JSON.stringify({ instance: 'dut1', cron: '30 3 * * *' }));
  const { done, marker } = runHelper(dir);

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(readHold(path.join(dir, 'update-hold.json'))?.reason, 'reboot'); // held while the job runs
  assert.equal(fs.existsSync(marker), false);
  state.status = { activeJobId: null, localLock: { locked: false } }; // job done
  assert.equal(await done, 0);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'reboot');
  assert.equal(fs.existsSync(path.join(dir, 'reboot-request.json')), false);
});

test('reboot helper: a removed hold (cancel from the Coordinator) means no reboot', async (t) => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'thub-rh-')),
    server = await fakeInstance(dir, 'dut1', { status: { activeJobId: 'M-00002' } });
  t.after(() => server.close());
  fs.writeFileSync(path.join(dir, 'reboot-request.json'), '{}');
  const { done, marker } = runHelper(dir);
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(path.join(dir, 'update-hold.json'));
  assert.equal(await done, 0);
  assert.equal(fs.existsSync(marker), false);
});
