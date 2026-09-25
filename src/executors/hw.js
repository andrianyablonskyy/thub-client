/**
 * @file        packages/client/src/executors/hw.js
 * @description HW executor: flashes/runs a job against a physical DUT via UART/ST-Link/relay power (README §8.2)
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

const { spawn } = require('node:child_process'),
  { RelayClient } = require('../relay-client');

// §8.2 HW executor: flashes a physical DUT over ST-Link and exposes its
// UARTs/USB devices. Stable device paths come from udev rules
// (udev/99-thub.rules, /dev/dut<N>-uart|usb|stlink), so a replug doesn't
// change the config. config.js has already resolved every hw.* list.
function run(cmd, args){
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${out}`))));
  });
}

// st-flash selects a probe by serial, not by device node — so a
// /dev/dut<N>-stlink symlink is resolved to its probe's USB serial via udev.
async function stlinkSerialFromPath(devPath){
  const out = await run('udevadm', ['info', '--query=property', `--name=${devPath}`]),
    match = out.match(/^ID_SERIAL_SHORT=(.+)$/m);
  if (!match){
    throw new Error(`no ID_SERIAL_SHORT for ST-Link ${devPath}`);
  }
  return match[1].trim();
}

class HwExecutor{
  constructor(config, logShipper){
    this.config = config.hw || {};
    this.logShipper = logShipper;
    this.serialPorts = [];
  }

  // The job's single firmware image goes to the first ST-Link (hw.stlinks[0]);
  // every probe is still exposed to the test runner via envFor().
  async prepare(job, firmwarePath){
    const { flashAddress } = job.spec.firmware,
      addr = flashAddress || '0x08000000',
      stlinks = this.config.stlinks || [],
      serial = stlinks.length ? await this._stlinkSerial(stlinks[0]) : null,
      args = serial
        ? ['--serial', serial, '--reset', 'write', firmwarePath, addr]
        : ['--reset', 'write', firmwarePath, addr];

    this.logShipper.push('flash', `st-flash ${args.join(' ')}`);
    const output = await run('st-flash', args);
    this.logShipper.push('flash', output);
    // Resolve the remaining probes' serials now so envFor() (sync) has them.
    for (const stlink of stlinks.slice(1)){
      await this._stlinkSerial(stlink).catch(
        (err) => this.logShipper.push('flash', `ST-Link serial lookup failed: ${err.message}`)
      );
    }
    await this._openUarts();
  }

  async _stlinkSerial(stlink){
    if (!stlink.serial){
      stlink.serial = await stlinkSerialFromPath(stlink.path);
    }
    return stlink.serial;
  }

  async _openUarts(){
    const uarts = this.config.uarts || [];
    if (!uarts.length){
      return;
    }
    let SerialPort;
    try {
      ({ SerialPort } = require('serialport'));
    }
    catch {
      throw new Error(
        'HW executor needs the \'serialport\' package installed on the Client host (npm install serialport)'
      );
    }
    // All UARTs share the `uart` log stream; with more than one, each line
    // is tagged with its 1-based position in hw.uarts.
    for (const [i, uartCfg]of uarts.entries()){
      const port = new SerialPort({ path: uartCfg.path, baudRate: uartCfg.baudRate || 115200 }),
        tag = uarts.length > 1 ? `[uart${i + 1}] ` : '';
      port.on('data', (buf) => this.logShipper.push('uart', tag + buf.toString('utf8').trimEnd()));
      this.serialPorts.push(port);
    }
  }

  // THUB_DUT_UART/USB/STLINK name the first device of each kind (as before);
  // THUB_DUT_<KIND>_<n> (1-based, n = position in the list) name every one.
  // An ST-Link is given by serial, or by its udev path if the lookup failed.
  envFor(){
    const env = {},
      add = (kind, values) => values.forEach((value, i) => {
        if (i === 0){
          env[`THUB_DUT_${kind}`] = value;
        }
        env[`THUB_DUT_${kind}_${i + 1}`] = value;
      });

    add('UART', (this.config.uarts || []).map((u) => u.path));
    add('USB', (this.config.usbs || []).map((u) => u.path));
    add('STLINK', (this.config.stlinks || []).map((s) => s.serial || s.path));
    return env;
  }

  async teardown(){
    if (this.config.power?.method === 'uhubctl' && this.config.power.hub){
      await run('uhubctl', ['-l', this.config.power.hub, '-p', String(this.config.power.port), '-a', 'cycle']).catch(
        () => {}
      );
    }
    else if (this.config.power?.method === 'relay'){
      await this._relayCycle().catch((err) => this.logShipper.push('flash', `relay cycle failed: ${err.message}`));
    }
    await Promise.all(this.serialPorts.filter((p) => p.isOpen).map(
      (p) => new Promise((resolve) => p.close(resolve))
    ));
    this.serialPorts = [];
  }

  // STUB power control via a relay board's REST API — see relay-client.js.
  // Cycles every channel in hw.relays together: all off, wait, all on.
  async _relayCycle(){
    const relays = (this.config.relays || []).map((r) => ({ ...r, client: new RelayClient(r.baseUrl) }));
    if (!relays.length){
      throw new Error('hw.power.method is "relay" but hw.relays is empty');
    }
    for (const r of relays){
      this.logShipper.push('flash', `relay: power-cycling channel ${r.channel} via ${r.client.baseUrl}`);
      await r.client.setRelay(r.channel, false);
    }
    await sleep(500);
    for (const r of relays){
      await r.client.setRelay(r.channel, true);
    }
  }
}

function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { HwExecutor };
