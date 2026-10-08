/**
 * @file        packages/client/src/executors/hw.js
 * @description HW executor: captures a physical DUT's UARTs — adapters and boards' own USB serial ports — into the
 *              job log, reopening any that disconnect (README §8.2)
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

const path = require('node:path');

// How often a UART that's gone (not plugged in yet, or a board that reset
// and re-enumerates its USB serial port) is tried again.
const REOPEN_MS = 500;

function loadSerialPort(){
  try {
    return require('serialport').SerialPort;
  }
  catch {
    throw new Error('HW executor needs the \'serialport\' package installed on the Client host (npm install serialport)');
  }
}

// The tag on a UART's lines in the `uart` stream: its `label`, else its
// device's file name (/dev/thub/dut2-usb → dut2-usb). A lone UART without a
// label isn't tagged.
function uartTag(uart, count){
  if (uart.label){
    return uart.label;
  }
  return count > 1 ? path.basename(uart.path) : null;
}

// One UART, captured for the whole job. A board's own USB serial port
// disappears whenever the board resets — flashing it does — and comes back
// as a new device: that's a disconnect, and the port is opened again as soon
// as it's back. A UART not there at the start is waited for the same way.
// Nothing here fails the job or the Client: what happens is in the log.
class UartCapture{
  constructor(uart, tag, { SerialPort, push, reopenMs = REOPEN_MS }){
    Object.assign(this, { uart, SerialPort, push, reopenMs });
    this.prefix = tag ? `[${tag}] ` : '';
    this.port = null;
    this.timer = null;
    this.stopped = false;
    this.waiting = false; // said "waiting" already: once until it's back
    this.connectedOnce = false;
  }

  note(text){
    this.push('uart', `${this.prefix}— ${text} —`);
  }

  start(){
    if (this.stopped){
      return;
    }
    const port = new this.SerialPort({ path: this.uart.path, baudRate: this.uart.baudRate || 115200, autoOpen: false });
    this.port = port;
    // Without an 'error' listener, any serial error would be thrown and end
    // the Client process.
    port.on('error', (err) => {
      if (!this.stopped){
        this.note(`${this.uart.path}: ${err.message}`);
      }
    });
    port.on('data', (buf) => this.push('uart', this.prefix + buf.toString('utf8').trimEnd()));
    port.on('close', (err) => {
      if (this.stopped || this.port !== port){
        return;
      }
      this.note(`${this.uart.path} ${err?.disconnected ? 'disconnected' : 'closed'}, capturing again when it's back`);
      this.waiting = true;
      this.retry();
    });
    port.open((err) => {
      if (this.stopped){
        return port.isOpen && port.close(() => {});
      }
      if (err){
        if (!this.waiting){
          this.note(`${this.uart.path} isn't there yet (${err.message.replace(/^Error: /, '')}), waiting for it`);
          this.waiting = true;
        }
        return this.retry();
      }
      if (this.connectedOnce || this.waiting){
        this.note(`${this.uart.path} ${this.connectedOnce ? 'reconnected' : 'connected'}`);
      }
      this.connectedOnce = true;
      this.waiting = false;
    });
  }

  retry(){
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.reopenMs);
    this.timer.unref?.();
  }

  stop(){
    this.stopped = true;
    clearTimeout(this.timer);
    const port = this.port;
    return port?.isOpen ? new Promise((resolve) => port.close(() => resolve())) : Promise.resolve();
  }
}

// §8.2 HW executor: captures a physical DUT's UARTs into the job log. Stable
// device paths come from the udev rules the Client generates from its own
// hw.* config on start (udev.js, /dev/thub/dut<N>-uart|usb|stlink), so a
// replug doesn't change the config. Nothing about the devices is passed to
// the job: its command uses them by those paths (or st-flash's own probe
// selection) as it sees fit.
class HwExecutor{
  // `SerialPort`, `reopenMs`: for tests.
  constructor(config, logShipper, { SerialPort = null, reopenMs = REOPEN_MS } = {}){
    this.config = config.hw || {};
    this.logShipper = logShipper;
    this.SerialPort = SerialPort;
    this.reopenMs = reopenMs;
    this.captures = [];
  }

  // Nothing is flashed automatically — the job's --command does that.
  // Here: start capturing the UARTs.
  async prepare(){
    this._openUarts();
  }

  // What prepare()/teardown() would run, without running it (a dry run).
  plan(){
    const uarts = this.config.uarts || [],
      steps = uarts.map((u) => {
        const tag = uartTag(u, uarts.length);
        return `capture UART ${u.path} at ${u.baudRate || 115200} baud (uart log stream${tag ? `, lines tagged [${tag}]` : ''}; reopened if it disconnects)`;
      });
    return { steps, teardown: [], env: {} };
  }

  _openUarts(){
    const uarts = this.config.uarts || [];
    if (!uarts.length){
      return;
    }
    const SerialPort = this.SerialPort || loadSerialPort(),
      push = (stream, line) => this.logShipper.push(stream, line);
    for (const uart of uarts){
      const capture = new UartCapture(uart, uartTag(uart, uarts.length), { SerialPort, push, reopenMs: this.reopenMs });
      this.captures.push(capture);
      capture.start();
    }
  }

  // No device variables for the job's command.
  envFor(){
    return {};
  }

  async teardown(){
    await Promise.all(this.captures.map((c) => c.stop()));
    this.captures = [];
  }
}

module.exports = { HwExecutor, uartTag };
