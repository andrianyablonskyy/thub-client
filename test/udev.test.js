/**
 * @file        packages/client/test/udev.test.js
 * @description Tests: udev rule rendering from the hw-devices config (udev.js)
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

  { loadDeviceConfig } = require('../src/config'),
  { renderRules, rulesFile, syncUdevRules, mayWriteRules } = require('../src/udev');

function deviceConfig(hw, type = 'hw'){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-udev-')),
    file = path.join(dir, 'dut1.json');
  fs.writeFileSync(file, JSON.stringify({ type, 'hw-devices': hw }));
  return loadDeviceConfig(file);
}

function rules(cfg){
  return (renderRules(cfg) || '').split('\n').filter((l) => l && !l.startsWith('#'));
}

test('renders one rule per entry with a devpath, with per-kind defaults', () => {
  const cfg = deviceConfig({
    stlinks: [{ index: 1, devpath: '3.3.4.3.1' }],
    uarts: [{ index: 1, devpath: '3.3.3.2', baudRate: 115200 }],
    usbs: [{ path: '/dev/thub/dut1-usb', devpath: '3.2.4' }]
  });
  assert.equal(cfg.instance, 'dut1');
  assert.equal(rulesFile(), '/etc/udev/rules.d/99-thub-client-hw.rules'); // one per machine, whatever the instance
  assert.deepEqual(rules(cfg), [
    'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3748", ATTR{devpath}=="3.3.4.3.1", SYMLINK+="thub/dut1-stlink"',
    'SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", ATTRS{devpath}=="3.3.3.2", SYMLINK+="thub/dut1-uart"',
    'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", ATTR{devpath}=="3.2.4", SYMLINK+="thub/dut1-usb"'
  ]);
});

test('per-entry vendorId/productId/subsystem override the defaults', () => {
  const cfg = deviceConfig({
    usbs: [{ index: 2, devpath: '1.4', vendorId: '1A86', productId: '7523', subsystem: 'tty' }]
  });
  assert.deepEqual(rules(cfg), [
    'SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", ATTRS{devpath}=="1.4", SYMLINK+="thub/dut2-usb"'
  ]);
});

test('an ST-Link with serial, index and devpath still gets its symlink rule', () => {
  const cfg = deviceConfig({ stlinks: [{ index: 3, serial: 'ABC123', devpath: '2.1' }] });
  assert.equal(cfg.hw.stlinks[0].path, '/dev/thub/dut3-stlink');
  assert.equal(rules(cfg).length, 1);
});

test('no rules for a SW Client, or for entries without a devpath', () => {
  assert.equal(renderRules(deviceConfig({ uarts: [{ index: 1, devpath: '1.1' }] }, 'sw')), null);
  assert.equal(renderRules(deviceConfig({ uarts: [1, '/dev/ttyUSB0'] })), null);
});

test('rejects values that could break out of a udev rule', () => {
  assert.throws(() => renderRules(deviceConfig({ uarts: [{ index: 1, devpath: '1.1", RUN+="/bin/sh' }] })), /devpath/);
  assert.throws(() => renderRules(deviceConfig({ uarts: [{ index: 1, devpath: '1.1', vendorId: 'xyz' }] })), /vendorId/);
  assert.throws(() => renderRules(deviceConfig({ uarts: [{ path: '/tmp/uart', devpath: '1.1' }] })), /\/dev\//);
});

test('a udev filter: its device gets /dev/thub/dut<index>-<kind>; it replaces devpath and ids', () => {
  const cfg = deviceConfig({
    uarts: [{ index: 2, baudRate: 115200, udev: 'SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{serial}=="A9XYZ"' }],
    usbs: [{ index: 1, udev: 'SUBSYSTEM == "tty" , ENV{ID_SERIAL_SHORT}=="0670FF"' }]
  });
  assert.equal(cfg.hw.uarts[0].path, '/dev/thub/dut2-uart');
  assert.deepEqual(rules(cfg), [
    'SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{serial}=="A9XYZ", SYMLINK+="thub/dut2-uart"',
    'SUBSYSTEM=="tty", ENV{ID_SERIAL_SHORT}=="0670FF", SYMLINK+="thub/dut1-usb"'
  ]);
});

test('a filter that could do more than match never reaches the rule file: the Client refuses its config', () => {
  assert.throws(() => deviceConfig({ uarts: [{ index: 1, udev: 'SUBSYSTEM=="tty", RUN+="/bin/sh -c id"' }] }),
    /hw-devices\.uarts\.0\.udev: .*isn't a udev match/);
  assert.throws(() => renderRules({ instance: 'x', type: 'hw', hw: { usbs: [{ index: 1, path: '/dev/thub/dut1-usb', udev: 'PROGRAM=="/bin/true"' }] } }),
    /hw-devices\.usbs\[0\]\.udev: PROGRAM can't be used/);
});

test('storages: a mass storage device (an ST-Link\'s drive) gets /dev/thub/dut<index>-storage', () => {
  const cfg = deviceConfig({
    storages: [{ index: 1, udev: 'SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374e", ATTRS{devpath}=="1.3"' }]
  });
  assert.equal(cfg.hw.storages[0].path, '/dev/thub/dut1-storage');
  assert.deepEqual(rules(cfg), [
    'SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="374e", ATTRS{devpath}=="1.3", SYMLINK+="thub/dut1-storage"'
  ]);
});

test('a filter with its own SYMLINK+="…": the rule makes that link instead, and the Client uses /dev/<link>', () => {
  const cfg = deviceConfig({
    uarts: [{ index: 1, udev: 'SUBSYSTEM=="tty", ATTRS{serial}=="A9XYZ", SYMLINK+="lab/nucleo-console"' }],
    stlinks: [{ index: 1, udev: 'SUBSYSTEM=="usb", ATTRS{idProduct}=="374e"' }]
  });
  assert.deepEqual([cfg.hw.uarts[0].path, cfg.hw.stlinks[0].path], ['/dev/lab/nucleo-console', '/dev/thub/dut1-stlink']);
  assert.deepEqual(rules(cfg), [
    'SUBSYSTEM=="usb", ATTRS{idProduct}=="374e", SYMLINK+="thub/dut1-stlink"',
    'SUBSYSTEM=="tty", ATTRS{serial}=="A9XYZ", SYMLINK+="lab/nucleo-console"'
  ]);
  assert.throws(() => deviceConfig({ uarts: [{ index: 1, udev: 'SUBSYSTEM=="tty", SYMLINK+="../sda"' }] }), /must be a path inside \/dev/);
});

test('a full rule: MODE/GROUP/OWNER/TAG+= reach the rule file, so the service user (plugdev) can open the device', () => {
  const cfg = deviceConfig({
    stlinks: [{
      index: 3,
      udev: 'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3748", ATTR{devpath}=="1.1.2", ' +
        'MODE="0664", GROUP="plugdev", SYMLINK+="thub/f103-stlink"'
    }],
    usbs: [{ index: 1, udev: 'SUBSYSTEM=="usb", ATTR{devpath}=="1.2", TAG+="uaccess"' }]
  });
  assert.equal(cfg.hw.stlinks[0].path, '/dev/thub/f103-stlink');
  assert.deepEqual(rules(cfg), [
    'SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="3748", ATTR{devpath}=="1.1.2", MODE="0664", GROUP="plugdev", SYMLINK+="thub/f103-stlink"',
    'SUBSYSTEM=="usb", ATTR{devpath}=="1.2", TAG+="uaccess", SYMLINK+="thub/dut1-usb"'
  ]);
  assert.throws(() => deviceConfig({ stlinks: [{ index: 1, udev: 'SUBSYSTEM=="usb", MODE="0664", RUN+="/bin/sh"' }] }), /isn't a udev match/);
});

// syncUdevRules against a temp rules directory, as root, udev reload counted.
function sync(cfg, rulesDir, { root = true } = {}){
  const logged = [],
    reloads = { n: 0 },
    log = { log: (l) => logged.push(l), warn: (l) => logged.push(`warn: ${l}`) },
    result = syncUdevRules(cfg, { log, rulesDir, root, reload: () => reloads.n++, platform: 'linux' });
  return { ...result, logged, reloads: reloads.n };
}

test('one rules file for the machine: written from the config, removed when the dashboard empties the device list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-rules-')),
    file = path.join(dir, '99-thub-client-hw.rules'),
    cfg = deviceConfig({ stlinks: [{ index: 1, udev: 'SUBSYSTEM=="usb", ATTR{devpath}=="1.4", MODE="0664", GROUP="plugdev"' }] });
  let r = sync(cfg, dir);
  assert.deepEqual([r.status, r.reloads], ['updated', 1]);
  assert.match(fs.readFileSync(file, 'utf8'), /^# Generated by thub-client for instance "dut1"[\s\S]*SYMLINK\+="thub\/dut1-stlink"/);
  r = sync(cfg, dir);
  assert.deepEqual([r.status, r.reloads], ['unchanged', 0]);

  // Remove all on the dashboard: an empty hw-devices → no file, udev reloaded (the symlinks go).
  r = sync(deviceConfig({ stlinks: [], uarts: [], usbs: [], storages: [] }), dir);
  assert.deepEqual([r.status, r.reloads, fs.existsSync(file)], ['updated', 1, false]);
  assert.equal(sync(deviceConfig({ stlinks: [] }), dir).status, 'unchanged');
});

test('an older Client\'s per-instance rule files go; a hand-written 99-thub rule stays, its clashing symlinks reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-rules-')),
    cfg = deviceConfig({ uarts: [{ index: 1, udev: 'SUBSYSTEM=="tty", ATTRS{serial}=="A9"' }] });
  fs.writeFileSync(path.join(dir, '99-thub-dut1.rules'), '# Generated by thub-client for instance "dut1" from its config\'s hw-devices section.\nX\n');
  fs.writeFileSync(path.join(dir, '99-thub-client.rules'), '# Generated by thub-client for instance "client" from its config\'s hw-devices section.\nY\n');
  fs.writeFileSync(path.join(dir, '99-thub-lab.rules'), 'SUBSYSTEM=="tty", SYMLINK+="thub/dut1-uart"\n');
  const r = sync(cfg, dir);
  assert.equal(r.status, 'updated');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['99-thub-client-hw.rules', '99-thub-lab.rules']);
  assert.ok(r.logged.some((l) => /warn: udev: .*99-thub-lab\.rules also defines \/dev\/thub\/dut1-uart/.test(l)));

  // An older file alone is a change too, even when ours already matches.
  fs.writeFileSync(path.join(dir, '99-thub-dut2.rules'), '# Generated by thub-client for instance "dut2"\n');
  assert.equal(sync(cfg, dir).status, 'updated');
  assert.equal(fs.existsSync(path.join(dir, '99-thub-dut2.rules')), false);
});

test('not root: nothing written, the change reported as needs-root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-rules-')),
    r = sync(deviceConfig({ uarts: [{ index: 1, devpath: '1.1' }] }), dir, { root: false });
  assert.deepEqual([r.status, r.reloads, fs.readdirSync(dir)], ['needs-root', 0, []]);
});

test('only the running HW Client writes the machine\'s rules: not an SW one, not a second HW one', async () => {
  const hw = deviceConfig({ uarts: [] });
  assert.deepEqual(await mayWriteRules(hw, { holder: null }), { ok: true }); // none running: its own start
  assert.deepEqual(await mayWriteRules(hw, { holder: 'dut1' }), { ok: true }); // itself
  assert.match((await mayWriteRules(hw, { holder: 'client' })).reason, /HW Client "client" runs on this machine/);
  assert.match((await mayWriteRules(deviceConfig({}, 'sw'), { holder: null })).reason, /SW Client/);
});
