/**
 * @file        packages/client/src/executors/hw.js
 * @description HW executor: flashes/runs a job against a physical DUT via UART/ST-Link (README §8.2)
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

const { spawn } = require('node:child_process');

// §8.2 HW executor: flashes a physical DUT over ST-Link and exposes its
// UARTs/USB devices. Stable device paths come from the udev rules the Client
// generates from its own hw.* config on start (udev.js,
// /dev/thub/dut<N>-uart|usb|stlink), so a replug doesn't change the config. config.js has already resolved every hw.* list.
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
// /dev/thub/dut<N>-stlink symlink is resolved to its probe's USB serial via udev.
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

  // Nothing is flashed automatically: the job's --command does that (e.g.
  // `st-flash --serial "$THUB_DUT_STLINK" --reset write "$THUB_DOWNLOAD_1"
  // 0x08000000`). Here: resolve every ST-Link's serial so envFor() (sync)
  // has them, and start capturing the UARTs.
  async prepare(){
    for (const stlink of this.config.stlinks || []){
      await this._stlinkSerial(stlink).catch(
        (err) => this.logShipper.push('runner', `ST-Link serial lookup failed for ${stlink.path}: ${err.message}`)
      );
    }
    await this._openUarts();
  }

  // What prepare()/teardown() would run, without running it (a dry run):
  // { steps, teardown, env } — env with the ST-Link serials still unknown.
  plan(){
    const cfg = this.config,
      steps = [
        ...(cfg.stlinks || []).filter((s) => !s.serial)
          .map((s) => `udevadm info --query=property --name=${s.path}   # ST-Link serial (ID_SERIAL_SHORT)`),
        ...(cfg.uarts || []).map((u) => `capture UART ${u.path} at ${u.baudRate || 115200} baud (uart log stream)`)
      ],
      env = this.envFor();
    for (const [i, s]of (cfg.stlinks || []).entries()){
      if (!s.serial){
        const unknown = `<serial of ${s.path}>`;
        env[`THUB_DUT_STLINK_${i + 1}`] = unknown;
        if (i === 0){
          env.THUB_DUT_STLINK = unknown;
        }
      }
    }
    return { steps, teardown: [], env };
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
    await Promise.all(this.serialPorts.filter((p) => p.isOpen).map(
      (p) => new Promise((resolve) => p.close(resolve))
    ));
    this.serialPorts = [];
  }
}

module.exports = { HwExecutor };
