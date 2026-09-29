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

test('returns lsusb\'s output', async () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-lsusb-')), 'lsusb');
  fs.writeFileSync(fake, '#!/bin/sh\necho "Bus 001 Device 004: ID 0483:3748 STMicroelectronics ST-LINK/V2"\n', { mode: 0o755 });
  assert.deepEqual(await scanUsb({ command: fake }), { output: 'Bus 001 Device 004: ID 0483:3748 STMicroelectronics ST-LINK/V2\n', error: null });
});

test('reports a missing or failing lsusb instead of throwing', async () => {
  assert.match((await scanUsb({ command: '/nonexistent/lsusb' })).error, /isn't installed.*usbutils/);
  const failing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-lsusb-')), 'lsusb');
  fs.writeFileSync(failing, '#!/bin/sh\necho "no usb bus" >&2\nexit 1\n', { mode: 0o755 });
  assert.match((await scanUsb({ command: failing })).error, /failed: no usb bus/);
});
