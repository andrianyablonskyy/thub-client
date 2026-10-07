/**
 * @file        packages/client/src/usb-power.js
 * @description USB port power with uhubctl: switches this Client's hw-devices.usbPower ports on, off or through a
 *              reset (off, wait, on), and reads their state (README §8.7)
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

const { execFile } = require('node:child_process'),
  { DEFAULT_RESET_DELAY_SEC, powerRequestErrors } = require('@andrian.yablonskyy/thub-common');

const TIMEOUT_MS = 15_000,
  INSTALL_HINT = 'on Ubuntu: sudo apt install uhubctl',
  PERMISSION_HINT = ' — check the hub supports per-port power and the Client\'s udev rules are installed (sudo thub-client udev)';

// One process per Client, so a job's own reset and one from `thub-client
// power` or the job's owner never interleave: each request runs to the end
// before the next starts.
class UsbPower{
  constructor(ports, { command = 'uhubctl', sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}){
    this.ports = (ports || []).map((p, i) => ({ number: i + 1, hub: p.hub, port: p.port }));
    this.command = command;
    this.sleep = sleep;
    this.queue = Promise.resolve();
  }

  get configured(){
    return this.ports.length > 0;
  }

  // Checks a request against these ports: throws with a readable reason.
  _select({ action, delaySec, port } = {}, { forStatus = false } = {}){
    if (!this.configured){
      throw new Error('this Client has no USB power ports (hw-devices.usbPower.ports in its config)');
    }
    const errors = forStatus ? powerRequestErrors({ action: 'on', port }) : powerRequestErrors({ action, delaySec, port });
    if (errors.length){
      throw new Error(errors.join('; '));
    }
    if (port && port > this.ports.length){
      throw new Error(`port ${port}: this Client has ${this.ports.length} USB power port(s)`);
    }
    return port ? [this.ports[port - 1]] : this.ports;
  }

  // The uhubctl calls for one action (none: just list the ports' state):
  // one per hub, its ports together.
  _commands(ports, action = null){
    const byHub = new Map();
    for (const p of ports){
      byHub.set(p.hub, [...(byHub.get(p.hub) || []), p.port]);
    }
    return [...byHub].map(([hub, nums]) => ['-l', hub, '-p', nums.join(','), ...(action ? ['-a', action] : [])]);
  }

  // What apply() would run, without running it (a dry run).
  plan(action, { delaySec, port } = {}){
    const ports = this._select({ action, delaySec, port }),
      line = (args) => [this.command, ...args].join(' ');
    if (action !== 'reset'){
      return this._commands(ports, action).map(line);
    }
    return [
      ...this._commands(ports, 'off').map(line),
      `sleep ${delaySec ?? DEFAULT_RESET_DELAY_SEC}`,
      ...this._commands(ports, 'on').map(line)
    ];
  }

  // on | off | reset (off, `delaySec` — 1 s when not given — then on) for
  // every port, or just `port` (1-based, in hw-devices.usbPower.ports).
  // `log(line)` gets what's done. Throws if uhubctl fails.
  apply(action, { delaySec, port, log = () => {} } = {}){
    return this._serialized(async () => {
      const ports = this._select({ action, delaySec, port }),
        what = ports.map((p) => `${p.hub}:${p.port}`).join(', ');
      if (action === 'reset'){
        const delay = delaySec ?? DEFAULT_RESET_DELAY_SEC;
        log(`USB power reset: ${what} (off ${delay} s)`);
        await this._run(this._commands(ports, 'off'));
        await this.sleep(delay * 1000);
        await this._run(this._commands(ports, 'on'));
      }
      else {
        log(`USB power ${action}: ${what}`);
        await this._run(this._commands(ports, action));
      }
    });
  }

  // [{ number, hub, port, power: true | false | null, status }] — `status`
  // is uhubctl's line for the port, null when it didn't list it.
  status({ port } = {}){
    return this._serialized(async () => {
      const ports = this._select({ port }, { forStatus: true }),
        outputs = new Map();
      for (const args of this._commands(ports)){
        outputs.set(args[1], await this._exec(args));
      }
      return ports.map((p) => {
        const line = portStatus(outputs.get(p.hub), p.hub, p.port);
        return { number: p.number, hub: p.hub, port: p.port, power: line ? !/\boff\b/.test(line) : null, status: line };
      });
    });
  }

  _serialized(fn){
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async _run(commands){
    for (const args of commands){
      await this._exec(args);
    }
  }

  _exec(args){
    return new Promise((resolve, reject) => {
      execFile(this.command, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err){
          return resolve(String(stdout || ''));
        }
        const said = String(stderr || stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 500);
        reject(new Error(
          err.code === 'ENOENT'
            ? `${this.command} isn't installed (${INSTALL_HINT})`
            : err.killed
              ? `${this.command} ${args.join(' ')} didn't finish within ${TIMEOUT_MS / 1000} s`
              : `${this.command} ${args.join(' ')} failed: ${said || err.message}` + (/permission|No compatible devices/i.test(said) ? PERMISSION_HINT : '')
        ));
      });
    });
  }
}

// uhubctl's line for `port` of `hub` ("Port 2: 0100 power"), or null.
// Its output can also list the hub's USB3 twin (another location), so only
// the block headed "Current status for hub <hub>" counts.
function portStatus(output, hub, port){
  let inHub = false;
  for (const line of String(output || '').split('\n')){
    const header = /^Current status for hub (\S+)/.exec(line);
    if (header){
      inHub = header[1] === hub;
      continue;
    }
    const m = /^\s*Port (\d+): (.*)$/.exec(line);
    if (inHub && m && Number(m[1]) === port){
      return `Port ${m[1]}: ${m[2].trim()}`;
    }
  }
  return null;
}

module.exports = { UsbPower, portStatus };
