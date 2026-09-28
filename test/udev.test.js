/**
 * @file        packages/client/test/udev.test.js
 * @description Tests: udev rule rendering from the hw.* config (udev.js)
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
  { renderRules, rulesFile } = require('../src/udev');

function deviceConfig(hw, type = 'hw'){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-udev-')),
    file = path.join(dir, 'dut1.json');
  fs.writeFileSync(file, JSON.stringify({ type, hw }));
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
  assert.equal(rulesFile(cfg.instance), '/etc/udev/rules.d/99-thub-dut1.rules');
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
  assert.throws(() => renderRules(deviceConfig({ uarts: [{ path: '/tmp/uart', devpath: '1.1' }] })), /under \/dev\//);
});
