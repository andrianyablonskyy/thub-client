/**
 * @file        packages/client/test/hw-lock.test.js
 * @description Tests: one HW Client per machine (hw-lock.js)
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
  { acquireHwLock, hwLockHolder } = require('../src/hw-lock');

// Not the machine's real lock: a test's own address.
function address(){
  return process.platform === 'linux'
    ? `\0thub-client-hw-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-lock-')), 'hw.sock');
}

test('the first HW Client takes the lock; a second is refused, told which instance holds it', async () => {
  const where = address(),
    first = await acquireHwLock('client', { address: where });
  assert.equal(await hwLockHolder({ address: where }), 'client');
  await assert.rejects(acquireHwLock('dut1', { address: where }), (err) =>
    err.code === 'EHWLOCKED' && err.holder === 'client' && /another HW Client already runs on this machine \(instance "client"\)/.test(err.message));

  first.release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await hwLockHolder({ address: where }), null);
  const second = await acquireHwLock('dut1', { address: where });
  assert.equal(await hwLockHolder({ address: where }), 'dut1');
  second.release();
});

const ABSTRACT = process.platform === 'linux' && 'abstract sockets leave nothing behind';

test('a lock left by a crashed Client (a socket file nobody answers on) is taken over', { skip: ABSTRACT }, async () => {
  const where = address();
  fs.writeFileSync(where, '');
  const lock = await acquireHwLock('client', { address: where });
  assert.equal(await hwLockHolder({ address: where }), 'client');
  lock.release();
});
