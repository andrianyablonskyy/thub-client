/**
 * @file        packages/client/test/hw-uart.test.js
 * @description Tests: UART capture — tags, a UART that isn't there yet, a board's USB serial port that disappears on
 *              reset and comes back, serial errors that must not end the Client (fake serialport)
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
  { HwExecutor, uartTag } = require('../src/executors/hw');

// A serialport stand-in: devices are "plugged in" by path; unplug() is a
// disconnect, as the real one reports it (close with err.disconnected).
function fakeSerial(){
  const present = new Set(),
    ports = [];
  class FakePort extends EventEmitter{
    constructor({ path, baudRate }){
      super();
      Object.assign(this, { path, baudRate, isOpen: false });
      ports.push(this);
    }

    open(cb){
      setImmediate(() => {
        if (!present.has(this.path)){
          return cb(new Error(`Error: No such file or directory, cannot open ${this.path}`));
        }
        this.isOpen = true;
        cb(null);
      });
    }

    close(cb){
      this.isOpen = false;
      setImmediate(() => cb?.());
    }
  }
  const live = (path) => ports.filter((p) => p.path === path && p.isOpen).pop();
  return {
    SerialPort: FakePort,
    plug: (path) => present.add(path),
    unplug(path){
      present.delete(path);
      const port = live(path);
      port.isOpen = false;
      port.emit('close', Object.assign(new Error('disconnected'), { disconnected: true }));
    },
    say: (path, text) => live(path).emit('data', Buffer.from(text)),
    fail: (path, message) => live(path).emit('error', new Error(message)),
    opens: (path) => ports.filter((p) => p.path === path).length
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  shipper = () => {
    const lines = [];
    return { lines, push: (stream, line) => lines.push(`${stream} ${line}`) };
  },
  FIVE = [1, 2, 3, 4, 5].flatMap((n) => [{ path: `/dev/thub/dut${n}-uart` }, { path: `/dev/thub/dut${n}-usb` }]);

test('tags: the label, else the device\'s name; a lone UART untagged', () => {
  assert.equal(uartTag({ path: '/dev/thub/dut2-usb' }, 10), 'dut2-usb');
  assert.equal(uartTag({ path: '/dev/ttyUSB0', label: 'console' }, 10), 'console');
  assert.equal(uartTag({ path: '/dev/ttyUSB0' }, 1), null);
  const plan = new HwExecutor({ hw: { uarts: FIVE } }, null).plan().steps;
  assert.equal(plan.length, 10);
  assert.match(plan[3], /capture UART \/dev\/thub\/dut2-usb at 115200 baud \(uart log stream, lines tagged \[dut2-usb\]; reopened if it disconnects\)/);
});

test('ten UARTs of five boards: each tagged; a USB port that resets is captured again', async () => {
  const serial = fakeSerial(),
    log = shipper();
  FIVE.forEach((u) => serial.plug(u.path));
  const hw = new HwExecutor({ hw: { uarts: FIVE } }, log, { SerialPort: serial.SerialPort, reopenMs: 20 });
  await hw.prepare();
  await wait(10);
  serial.say('/dev/thub/dut1-uart', 'boot ok\r\n');
  serial.say('/dev/thub/dut2-usb', 'usb hello');

  // Flashing DUT 2 resets it: its USB serial port goes, then comes back.
  serial.unplug('/dev/thub/dut2-usb');
  await wait(50);
  serial.plug('/dev/thub/dut2-usb');
  await wait(50);
  serial.say('/dev/thub/dut2-usb', 'after reset');
  await hw.teardown();

  assert.deepEqual(log.lines, [
    'uart [dut1-uart] boot ok',
    'uart [dut2-usb] usb hello',
    'uart [dut2-usb] — /dev/thub/dut2-usb disconnected, capturing again when it\'s back —',
    'uart [dut2-usb] — /dev/thub/dut2-usb reconnected —',
    'uart [dut2-usb] after reset'
  ]);
  assert.ok(serial.opens('/dev/thub/dut2-usb') >= 3); // tried while it was gone
});

test('a UART not there at the start is waited for, said once; serial errors are logged, never thrown', async () => {
  const serial = fakeSerial(),
    log = shipper(),
    hw = new HwExecutor({ hw: { uarts: [{ path: '/dev/thub/dut1-usb' }, { path: '/dev/thub/dut1-uart' }] } }, log,
      { SerialPort: serial.SerialPort, reopenMs: 10 });
  serial.plug('/dev/thub/dut1-uart');
  await hw.prepare();
  await wait(60); // several tries
  serial.plug('/dev/thub/dut1-usb');
  await wait(30);
  serial.fail('/dev/thub/dut1-uart', 'Input/output error'); // no listener would have thrown here
  await hw.teardown();
  assert.deepEqual(log.lines, [
    'uart [dut1-usb] — /dev/thub/dut1-usb isn\'t there yet (No such file or directory, cannot open /dev/thub/dut1-usb), waiting for it —',
    'uart [dut1-usb] — /dev/thub/dut1-usb connected —',
    'uart [dut1-uart] — /dev/thub/dut1-uart: Input/output error —'
  ]);
});

test('teardown stops the retries', async () => {
  const serial = fakeSerial(),
    hw = new HwExecutor({ hw: { uarts: [{ path: '/dev/thub/never' }] } }, shipper(), { SerialPort: serial.SerialPort, reopenMs: 10 });
  await hw.prepare();
  await wait(30);
  await hw.teardown();
  const tries = serial.opens('/dev/thub/never');
  await wait(50);
  assert.equal(serial.opens('/dev/thub/never'), tries);
});
