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

const path = require('node:path'),
  { UartHub, loadSerialPort, REOPEN_MS } = require('../uart-hub');

// Said in the job's log when there's no serialport: the job runs anyway,
// only its UARTs aren't captured.
const NO_SERIALPORT = 'UART capture off: the \'serialport\' package isn\'t installed on this Client host, so this job runs ' +
  'without the uart log stream. Reinstall the Client (sudo npm i -g @andrian.yablonskyy/thub-client), or add it: ' +
  'cd "$(npm root -g)/@andrian.yablonskyy/thub-client" && sudo npm install serialport, then restart the Client.';

// The tag on a UART's lines in the `uart` stream: its `label`, else its
// device's file name (/dev/thub/dut2-usb → dut2-usb). A lone UART without a
// label isn't tagged.
function uartTag(uart, count){
  if (uart.label){
    return uart.label;
  }
  return count > 1 ? path.basename(uart.path) : null;
}

// One UART, captured for the whole job, through the Client's UartHub (a
// remote session on the reserved board may share it, README §5.6). A
// board's own USB serial port disappears whenever the board resets —
// flashing it does — and comes back as a new device: that's a disconnect,
// and the hub opens it again as soon as it's back. A UART not there at the
// start is waited for the same way. Nothing here fails the job or the
// Client: what happens is in the log.
class UartCapture{
  constructor(uart, tag, { hub, push }){
    Object.assign(this, { uart, hub, push });
    this.prefix = tag ? `[${tag}] ` : '';
    this.sub = null;
    this.waiting = false; // said "waiting" already: once until it's back
    this.connectedOnce = false;
  }

  note(text){
    this.push('uart', `${this.prefix}— ${text} —`);
  }

  start(){
    this.sub = this.hub.subscribe(this.uart, (event, arg) => this.on(event, arg));
  }

  on(event, arg){
    const where = this.uart.path;
    if (event === 'data'){
      this.push('uart', this.prefix + arg.toString('utf8').trimEnd());
    }
    else if (event === 'error'){
      this.note(`${where}: ${arg.message}`);
    }
    else if (event === 'closed'){
      this.note(`${where} ${arg?.disconnected ? 'disconnected' : 'closed'}, capturing again when it's back`);
      this.waiting = true;
    }
    else if (event === 'open-failed'){
      if (!this.waiting){
        this.note(`${where} isn't there yet (${arg.message.replace(/^Error: /, '')}), waiting for it`);
        this.waiting = true;
      }
    }
    else if (event === 'opened'){
      if (this.connectedOnce || this.waiting){
        this.note(`${where} ${this.connectedOnce ? 'reconnected' : 'connected'}`);
      }
      this.connectedOnce = true;
      this.waiting = false;
    }
  }

  stop(){
    const sub = this.sub;
    this.sub = null;
    return sub ? sub.close() : Promise.resolve();
  }
}

// §8.2 HW executor: captures a physical DUT's UARTs into the job log. Stable
// device paths come from the udev rules the Client generates from its own
// hw.* config on start (udev.js, /dev/thub/dut<N>-uart|usb|stlink), so a
// replug doesn't change the config. Nothing about the devices is passed to
// the job: its command uses them by those paths (or st-flash's own probe
// selection) as it sees fit.
class HwExecutor{
  // `uartHub`: the daemon's, shared with remote sessions (README §5.6);
  // without one, the executor's own. `SerialPort`, `loadSerialPort`,
  // `reopenMs`: for tests.
  constructor(config, logShipper, { uartHub = null, SerialPort = null, loadSerialPort: load = loadSerialPort, reopenMs = REOPEN_MS } = {}){
    this.config = config.hw || {};
    this.logShipper = logShipper;
    this.hub = uartHub || new UartHub({ SerialPort, loadSerialPort: load, reopenMs });
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
    const push = (stream, line) => this.logShipper.push(stream, line);
    if (!this.hub.available){
      push('runner', NO_SERIALPORT);
      return;
    }
    for (const uart of uarts){
      const capture = new UartCapture(uart, uartTag(uart, uarts.length), { hub: this.hub, push });
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
