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

// §8.2 HW executor: captures a physical DUT's UARTs into the job log. Stable
// device paths come from the udev rules the Client generates from its own
// hw.* config on start (udev.js, /dev/thub/dut<N>-uart|usb|stlink), so a
// replug doesn't change the config. Nothing about the devices is passed to
// the job: its command uses them by those paths (or st-flash's own probe
// selection) as it sees fit.
class HwExecutor{
  constructor(config, logShipper){
    this.config = config.hw || {};
    this.logShipper = logShipper;
    this.serialPorts = [];
  }

  // Nothing is flashed automatically — the job's --command does that.
  // Here: start capturing the UARTs.
  async prepare(){
    await this._openUarts();
  }

  // What prepare()/teardown() would run, without running it (a dry run).
  plan(){
    const steps = (this.config.uarts || []).map((u) => `capture UART ${u.path} at ${u.baudRate || 115200} baud (uart log stream)`);
    return { steps, teardown: [], env: {} };
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

  // No device variables for the job's command.
  envFor(){
    return {};
  }

  async teardown(){
    await Promise.all(this.serialPorts.filter((p) => p.isOpen).map(
      (p) => new Promise((resolve) => p.close(resolve))
    ));
    this.serialPorts = [];
  }
}

module.exports = { HwExecutor };
