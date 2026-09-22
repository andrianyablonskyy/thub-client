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
  { RelayClient } = require('../relay-client'),
  { assertSlotIndex } = require('../config');

// §8.2 HW executor: flashes a physical DUT over ST-Link and exposes its
// UART. Stable device paths come from udev rules (udev/99-thub.rules),
// so a replug doesn't change the config.
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

class HwExecutor{
  constructor(config, logShipper){
    this.config = config.hw || {};
    this.logShipper = logShipper;
    this.serialPort = null;
  }

  async prepare(job, firmwarePath){
    const { flashAddress } = job.spec.firmware,
      addr = flashAddress || '0x08000000',
      serial = this.config.stlinkSerial,
      args = serial
        ? ['--serial', serial, '--reset', 'write', firmwarePath, addr]
        : ['--reset', 'write', firmwarePath, addr];

    this.logShipper.push('flash', `st-flash ${args.join(' ')}`);
    const output = await run('st-flash', args);
    this.logShipper.push('flash', output);
    await this._openUart();
  }

  async _openUart(){
    const uartCfg = this.config.uart;
    if (!uartCfg){
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
    this.serialPort = new SerialPort({ path: uartCfg.path, baudRate: uartCfg.baudRate || 115200 });
    this.serialPort.on('data', (buf) => this.logShipper.push('uart', buf.toString('utf8').trimEnd()));
  }

  envFor(){
    const uartCfg = this.config.uart;
    return uartCfg ? { THUB_DUT_UART: uartCfg.path } : {};
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
    if (this.serialPort?.isOpen){
      await new Promise((resolve) => this.serialPort.close(resolve));
    }
    this.serialPort = null;
  }

  // STUB power control via a relay board's REST API — see relay-client.js.
  async _relayCycle(){
    const { relayIndex, baseUrl } = this.config.power;
    assertSlotIndex('hw.power.relayIndex', relayIndex);
    const relay = new RelayClient(baseUrl);
    this.logShipper.push('flash', `relay: power-cycling channel ${relayIndex} via ${relay.baseUrl}`);
    await relay.setRelay(relayIndex, false);
    await sleep(500);
    await relay.setRelay(relayIndex, true);
  }
}

function sleep(ms){
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { HwExecutor };
