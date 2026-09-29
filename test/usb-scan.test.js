/**
 * @file        packages/client/test/usb-scan.test.js
 * @description Tests: running lsusb for the Coordinator's scan-usb command
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
  { scanUsb } = require('../src/usb-scan');

test('runs lsusb -tvv and returns its output', async () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-lsusb-')), 'lsusb');
  fs.writeFileSync(fake, '#!/bin/sh\necho "args: $*"\necho "/:  Bus 001.Port 001: Dev 001, Class=root_hub, Driver=xhci_hcd/12p, 480M"\n', { mode: 0o755 });
  const { output, error } = await scanUsb({ command: fake });
  assert.equal(error, null);
  assert.match(output, /^args: -tvv\n\/: {2}Bus 001\.Port 001/);
});

test('reports a missing or failing lsusb instead of throwing', async () => {
  assert.match((await scanUsb({ command: '/nonexistent/lsusb' })).error, /isn't installed.*usbutils/);
  const failing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-lsusb-')), 'lsusb');
  fs.writeFileSync(failing, '#!/bin/sh\necho "no usb bus" >&2\nexit 1\n', { mode: 0o755 });
  assert.match((await scanUsb({ command: failing })).error, /lsusb -tvv failed: no usb bus/);
});
