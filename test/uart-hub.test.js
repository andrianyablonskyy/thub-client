/**
 * @file        packages/client/test/uart-hub.test.js
 * @description Tests: one serial port shared by a job's UART capture and a remote session (README §5.6)
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
  { EventEmitter } = require('node:events'),
  { UartHub } = require('../src/uart-hub'),
  { HwExecutor } = require('../src/executors/hw');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a job and a remote session share one open port: both see the board, the session types to it, it closes after the last', async () => {
  const opened = [],
    written = [];
  class FakePort extends EventEmitter{
    constructor({ path }){
      super();
      Object.assign(this, { path, isOpen: false });
      opened.push(this);
    }

    open(cb){
      setImmediate(() => {
        this.isOpen = true;
        cb(null);
      });
    }

    close(cb){
      this.isOpen = false;
      setImmediate(() => cb?.());
    }

    write(d){
      written.push(String(d));
    }
  }
  const hub = new UartHub({ SerialPort: FakePort }),
    uart = { path: '/dev/thub/dut1-uart' },
    remote = [],
    session = hub.subscribe(uart, (event, arg) => event === 'data' && remote.push(String(arg))),
    lines = [],
    hw = new HwExecutor({ hw: { uarts: [uart] } }, { push: (s, l) => lines.push(`${s} ${l}`) }, { uartHub: hub });
  await hw.prepare();
  await wait(10);
  assert.equal(opened.length, 1); // one port for both

  opened[0].emit('data', Buffer.from('boot ok'));
  assert.deepEqual(lines, ['uart boot ok']);
  assert.deepEqual(remote, ['boot ok']);
  assert.equal(session.write('reset\r'), true);
  assert.deepEqual(written, ['reset\r']);

  await hw.teardown(); // the job ends: the session still has it
  assert.equal(opened[0].isOpen, true);
  await session.close();
  assert.equal(opened[0].isOpen, false);
});
