/**
 * @file        packages/client/test/stlink-probe.test.js
 * @description Tests: st-info --probe for the Coordinator's probe-stlink command (stlink-probe.js)
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
  { probeStlinks } = require('../src/stlink-probe');

function fake(script){
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-st-info-')), 'st-info');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

test('runs st-info --probe; its stderr (a probe it can\'t open) comes first in the output', async () => {
  const { output, error } = await probeStlinks({
    command: fake('echo "args: $*"\necho "Found 1 stlink programmers"\necho "ERROR usb.c: Could not open USB device 0x0483:0x374e, access error." >&2')
  });
  assert.equal(error, null);
  assert.equal(output, 'ERROR usb.c: Could not open USB device 0x0483:0x374e, access error.\nargs: --probe\nFound 1 stlink programmers');
});

test('reports a missing or failing st-info instead of throwing', async () => {
  assert.match((await probeStlinks({ command: '/nonexistent/st-info' })).error, /isn't installed.*stlink-tools/);
  assert.match((await probeStlinks({ command: fake('echo "libusb gone" >&2\nexit 1') })).error, /st-info --probe failed: libusb gone/);
});
