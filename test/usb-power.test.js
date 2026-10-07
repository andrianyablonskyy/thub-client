/**
 * @file        packages/client/test/usb-power.test.js
 * @description Tests: USB port power with uhubctl — on/off/reset per hub, the reset delay, port state, job start/end
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
  { UsbPower, portStatus } = require('../src/usb-power'),
  { JobRunner, dryRunPlan } = require('../src/runner'),
  { renderRules, HUB_POWER_RULE } = require('../src/udev');

const PORTS = [{ hub: '1-1.4', port: 2 }, { hub: '1-1.4', port: 3 }, { hub: '2-1', port: 1 }],
  STATUS = [
    'Current status for hub 2-1.4 [2109:0817 VIA Labs, Inc. USB3.0 Hub, USB 3.00, 4 ports, ppps]',
    '  Port 2: 02a0 off',
    'Current status for hub 1-1.4 [2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps]',
    '  Port 2: 0503 power highspeed enable connect [0483:3748 STMicroelectronics STM32 STLink]',
    '  Port 3: 0000 off',
    'Current status for hub 2-1 [05e3:0608 USB2.0 Hub, USB 2.00, 4 ports, ppps]',
    '  Port 1: 0100 power'
  ].join('\n');

// A fake uhubctl: logs each call's arguments, prints STATUS, exits with $FAIL.
function fakeUhubctl(t, { fail = 0 } = {}){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-uhubctl-')),
    bin = path.join(dir, 'uhubctl'),
    calls = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'status'), STATUS + '\n');
  const failure = fail ? 'echo "No compatible devices detected!" >&2\n' : '';
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> ${calls}\ncat ${dir}/status\n${failure}exit ${fail}\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { bin, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []) };
}

test('on/off: one uhubctl call per hub, its ports together; --port picks one', async (t) => {
  const uhubctl = fakeUhubctl(t),
    power = new UsbPower(PORTS, { command: uhubctl.bin }),
    log = [];
  await power.apply('off', { log: (l) => log.push(l) });
  await power.apply('on', { port: 3 });
  assert.deepEqual(uhubctl.calls(), ['-l 1-1.4 -p 2,3 -a off', '-l 2-1 -p 1 -a off', '-l 2-1 -p 1 -a on']);
  assert.deepEqual(log, ['USB power off: 1-1.4:2, 1-1.4:3, 2-1:1']);
});

test('reset: every port off, the delay (1 s by default), then on', async (t) => {
  const uhubctl = fakeUhubctl(t),
    slept = [],
    power = new UsbPower(PORTS.slice(0, 1), { command: uhubctl.bin, sleep: async (ms) => slept.push(ms) });
  await power.apply('reset');
  await power.apply('reset', { delaySec: 2.5 });
  assert.deepEqual(slept, [1000, 2500]);
  assert.deepEqual(uhubctl.calls(), ['-l 1-1.4 -p 2 -a off', '-l 1-1.4 -p 2 -a on', '-l 1-1.4 -p 2 -a off', '-l 1-1.4 -p 2 -a on']);
  assert.deepEqual(power.plan('reset', { delaySec: 3 }), [`${uhubctl.bin} -l 1-1.4 -p 2 -a off`, 'sleep 3', `${uhubctl.bin} -l 1-1.4 -p 2 -a on`]);
});

test('requests run one at a time, in order', async (t) => {
  const uhubctl = fakeUhubctl(t),
    power = new UsbPower(PORTS.slice(2), { command: uhubctl.bin, sleep: (ms) => new Promise((r) => setTimeout(r, ms / 10)) });
  await Promise.all([power.apply('reset', { delaySec: 0.5 }), power.apply('off')]);
  assert.deepEqual(uhubctl.calls(), ['-l 2-1 -p 1 -a off', '-l 2-1 -p 1 -a on', '-l 2-1 -p 1 -a off']);
});

test('status: each port\'s line from its own hub\'s block (not the USB3 twin\'s)', async (t) => {
  const uhubctl = fakeUhubctl(t),
    ports = await new UsbPower(PORTS, { command: uhubctl.bin }).status();
  assert.deepEqual(ports.map((p) => [p.number, p.power]), [[1, true], [2, false], [3, true]]);
  assert.match(ports[0].status, /^Port 2: 0503 power highspeed/);
  assert.deepEqual(uhubctl.calls(), ['-l 1-1.4 -p 2,3', '-l 2-1 -p 1']);
  assert.equal(portStatus(STATUS, '1-1.4', 4), null);
});

test('refused or failing requests say why', async (t) => {
  const failing = fakeUhubctl(t, { fail: 1 });
  await assert.rejects(new UsbPower([]).apply('on'), /no USB power ports \(hw-devices\.usbPower\.ports/);
  await assert.rejects(new UsbPower(PORTS).apply('on', { port: 4 }), /port 4: this Client has 3 USB power port/);
  await assert.rejects(new UsbPower(PORTS).apply('on', { delaySec: 2 }), /applies to reset only/);
  await assert.rejects(new UsbPower(PORTS, { command: '/nonexistent/uhubctl' }).apply('on'), /isn't installed \(on Ubuntu: sudo apt install uhubctl\)/);
  await assert.rejects(new UsbPower(PORTS, { command: failing.bin }).apply('off'), /-a off failed: No compatible devices detected!.*udev rules/);
});

test('udev: a Client with USB power ports lets plugdev switch hub ports', () => {
  assert.ok(renderRules({ instance: 'dut1', type: 'hw', hw: { usbPower: { ports: PORTS } } }).includes(HUB_POWER_RULE));
  assert.equal(renderRules({ instance: 'dut1', type: 'hw', hw: { usbPower: { ports: [] } } }), null);
});

// ---- in a job -------------------------------------------------------------

function runnerFor(t, ports, { fail = 0 } = {}){
  const uhubctl = fakeUhubctl(t, { fail }),
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-job-')),
    posts = [],
    client = { post: async (url, body) => posts.push([url, body]) },
    runner = new JobRunner(client, { name: 'lab-hw-01', workDir, hw: {} }, { usbPower: new UsbPower(ports, { command: uhubctl.bin, sleep: async () => {} }) });
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  const logLines = () => posts.filter(([url]) => url.endsWith('/logs')).flatMap(([, b]) => (Array.isArray(b) ? b : b.lines)).map((l) => l.line),
    result = () => posts.find(([url]) => url.endsWith('/result'))?.[1];
  return { runner, uhubctl, logLines, result };
}

const hwJob = (power, command = 'true') => ({ id: 'M-00001', spec: { target: { type: 'hw', labels: [] }, command, args: [], power } });

test('job: power at its start, before the command, and at its end, before the result', async (t) => {
  const { runner, uhubctl, logLines, result } = runnerFor(t, PORTS.slice(0, 1));
  await runner.run(hwJob({ onStart: 'reset', onEnd: 'off', resetDelaySec: 2 }, 'exit 1'));
  assert.deepEqual(uhubctl.calls(), ['-l 1-1.4 -p 2 -a off', '-l 1-1.4 -p 2 -a on', '-l 1-1.4 -p 2 -a off']);
  assert.equal(result().state, 'FAILED'); // the end action runs whatever the verdict
  const lines = logLines();
  assert.ok(lines.indexOf('job start: USB power reset') < lines.indexOf('USB power reset: 1-1.4:2 (off 2 s)'));
  assert.ok(lines.includes('job end: USB power off'), lines.join('\n'));
});

test('job: a Client without USB power ports fails a job that asks for it, before downloading anything', async (t) => {
  const { runner, uhubctl, result } = runnerFor(t, []);
  await runner.run(hwJob({ onEnd: 'off' }));
  assert.equal(result().state, 'ERROR');
  assert.match(result().summary.error, /no USB power ports/);
  assert.deepEqual(uhubctl.calls(), []);
});

test('job: a failed start action fails the job; the end action still runs', async (t) => {
  const { runner, uhubctl, logLines, result } = runnerFor(t, PORTS.slice(0, 1), { fail: 1 });
  await runner.run(hwJob({ onStart: 'on', onEnd: 'off' }));
  assert.equal(result().state, 'ERROR');
  assert.deepEqual(uhubctl.calls(), ['-l 1-1.4 -p 2 -a on', '-l 1-1.4 -p 2 -a off']);
  assert.ok(logLines().some((l) => /^job end: USB power off failed: /.test(l)));
});

test('job: its owner\'s power request while it runs is logged in the job', async (t) => {
  const { runner, uhubctl, logLines } = runnerFor(t, PORTS),
    running = runner.run(hwJob(undefined, 'sleep 0.3'));
  await new Promise((r) => setTimeout(r, 100));
  await runner.powerNow('reset', { port: 3, from: 'alice (thub power)' });
  await running;
  assert.deepEqual(uhubctl.calls(), ['-l 2-1 -p 1 -a off', '-l 2-1 -p 1 -a on']);
  assert.ok(logLines().includes('USB power reset (port 3) requested by alice (thub power)'));
});

test('dry run: the power commands at start and end, or why they would fail', () => {
  const config = { hw: { usbPower: { ports: PORTS.slice(0, 1) } } },
    plan = dryRunPlan(hwJob({ onStart: 'reset', onEnd: 'off' }), '/var/lib/thub/j-1', config);
  assert.ok(plan.includes('USB power at job start:'), plan.join('\n'));
  assert.ok(plan.includes('  uhubctl -l 1-1.4 -p 2 -a off') && plan.includes('  sleep 1') && plan.includes('  uhubctl -l 1-1.4 -p 2 -a on'));
  assert.deepEqual(dryRunPlan(hwJob({ onEnd: 'off' }), '/var/lib/thub/j-1', { hw: {} }).filter((l) => l.startsWith('WOULD FAIL')),
    ['WOULD FAIL: USB power off: this Client has no USB power ports (hw-devices.usbPower.ports in its config)']);
});
