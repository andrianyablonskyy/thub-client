'use strict';

const { spawn } = require('node:child_process');

// §8.2 HW executor: flashes a physical DUT over ST-Link and exposes its
// UART. Stable device paths come from udev rules (udev/99-thub.rules),
// so a replug doesn't change the config.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${out}`))));
  });
}

class HwExecutor {
  constructor(config, logShipper) {
    this.config = config.hw || {};
    this.logShipper = logShipper;
    this.serialPort = null;
  }

  async prepare(job, firmwarePath) {
    const { flashAddress } = job.spec.firmware;
    const addr = flashAddress || '0x08000000';
    const serial = this.config.stlinkSerial;
    const args = serial
      ? ['--serial', serial, '--reset', 'write', firmwarePath, addr]
      : ['--reset', 'write', firmwarePath, addr];

    this.logShipper.push('flash', `st-flash ${args.join(' ')}`);
    const output = await run('st-flash', args);
    this.logShipper.push('flash', output);
    await this._openUart();
  }

  async _openUart() {
    const uartCfg = this.config.uart;
    if (!uartCfg) return;
    let SerialPort;
    try {
      ({ SerialPort } = require('serialport'));
    } catch {
      throw new Error(
        "HW executor needs the 'serialport' package installed on the Client host (npm install serialport)"
      );
    }
    this.serialPort = new SerialPort({ path: uartCfg.path, baudRate: uartCfg.baudRate || 115200 });
    this.serialPort.on('data', (buf) => this.logShipper.push('uart', buf.toString('utf8').trimEnd()));
  }

  envFor() {
    const uartCfg = this.config.uart;
    return uartCfg ? { THUB_DUT_UART: uartCfg.path } : {};
  }

  async teardown() {
    if (this.config.power?.method === 'uhubctl' && this.config.power.hub) {
      await run('uhubctl', ['-l', this.config.power.hub, '-p', String(this.config.power.port), '-a', 'cycle']).catch(
        () => {}
      );
    }
    if (this.serialPort?.isOpen) {
      await new Promise((resolve) => this.serialPort.close(resolve));
    }
    this.serialPort = null;
  }
}

module.exports = { HwExecutor };
