/**
 * @file        packages/client/src/uart-hub.js
 * @description Shared UART access: one open serial port per device, its data fanned out to every subscriber — a
 *              job's capture and remote sessions (README §5.6) — and reopened whenever it disconnects
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

// How often a UART that's gone (not plugged in yet, or a board that reset
// and re-enumerates its USB serial port) is tried again.
const REOPEN_MS = 500;

// serialport is an optional dependency of thub-client: installed with it
// where its native addon builds or has a prebuilt one. null without it.
function loadSerialPort(){
  try {
    return require('serialport').SerialPort;
  }
  catch {
    return null;
  }
}

// One device: opened while anyone subscribes, closed after the last one
// leaves. serialport locks the device, so a second open of the same path
// would fail — everyone shares this one. A subscriber's `on(event, arg)`:
//   data (Buffer), opened (the port is open: on subscribing too, if it
//   already was), open-failed (Error), closed (Error|null), error (Error).
class SharedUart{
  constructor(uart, { SerialPort, reopenMs }){
    Object.assign(this, { uart, SerialPort, reopenMs });
    this.subs = new Set();
    this.port = null;
    this.timer = null;
  }

  emit(event, arg){
    for (const sub of [...this.subs]){
      sub(event, arg);
    }
  }

  add(sub){
    this.subs.add(sub);
    if (this.port?.isOpen){
      sub('opened');
    }
    else if (!this.port){
      this.start();
    }
  }

  remove(sub){
    this.subs.delete(sub);
    if (!this.subs.size){
      return this.stop();
    }
    return Promise.resolve();
  }

  write(data){
    if (!this.port?.isOpen){
      return false;
    }
    this.port.write(data);
    return true;
  }

  start(){
    if (!this.subs.size){
      return;
    }
    const port = new this.SerialPort({ path: this.uart.path, baudRate: this.uart.baudRate || 115200, autoOpen: false });
    this.port = port;
    // Without an 'error' listener, any serial error would be thrown and end
    // the Client process.
    port.on('error', (err) => this.port === port && this.emit('error', err));
    port.on('data', (buf) => this.port === port && this.emit('data', buf));
    port.on('close', (err) => {
      if (this.port !== port){
        return;
      }
      this.emit('closed', err || null);
      this.retry();
    });
    port.open((err) => {
      if (this.port !== port){
        return port.isOpen && port.close(() => {});
      }
      if (err){
        this.emit('open-failed', err);
        return this.retry();
      }
      this.emit('opened');
    });
  }

  retry(){
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), this.reopenMs);
    this.timer.unref?.();
  }

  stop(){
    clearTimeout(this.timer);
    const port = this.port;
    this.port = null;
    return port?.isOpen ? new Promise((resolve) => port.close(() => resolve())) : Promise.resolve();
  }
}

class UartHub{
  // `SerialPort`: for tests; else the serialport package, if installed.
  constructor({ SerialPort = null, loadSerialPort: load = loadSerialPort, reopenMs = REOPEN_MS } = {}){
    this.SerialPort = SerialPort;
    this.load = load;
    this.reopenMs = reopenMs;
    this.devices = new Map();
  }

  // Whether serial ports can be opened at all on this host.
  get available(){
    this.SerialPort ??= this.load();
    return Boolean(this.SerialPort);
  }

  // Subscribe `on` to `uart` ({ path, baudRate }). Returns { write(data),
  // close() } — close() resolves once the port is closed, if it was the last.
  subscribe(uart, on){
    if (!this.available){
      throw new Error('the \'serialport\' package isn\'t installed on this Client host');
    }
    let dev = this.devices.get(uart.path);
    if (!dev){
      dev = new SharedUart(uart, { SerialPort: this.SerialPort, reopenMs: this.reopenMs });
      this.devices.set(uart.path, dev);
    }
    dev.add(on);
    return {
      write: (data) => dev.write(data),
      close: () => {
        const done = dev.remove(on);
        if (!dev.subs.size && this.devices.get(uart.path) === dev){
          this.devices.delete(uart.path);
        }
        return done;
      }
    };
  }
}

module.exports = { UartHub, loadSerialPort, REOPEN_MS };
