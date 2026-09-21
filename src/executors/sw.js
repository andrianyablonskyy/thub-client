'use strict';

const net = require('node:net');
const Docker = require('dockerode');

// §8.3 SW executor: runs the DUT emulator in Docker, per job — isolated
// network, read-only rootfs, resource limits, always removed (§12).
class SwExecutor {
  constructor(config, logShipper) {
    this.config = config.sw || {};
    this.logShipper = logShipper;
    this.docker = new Docker();
    this.container = null;
    this.network = null;
    this.hostPort = null;
  }

  async prepare(job, fwDir) {
    const image = this.config.image;
    if (!image) throw new Error('sw.image is not configured on this Client');

    await this._pullIfMissing(image);

    this.network = await this.docker.createNetwork({ Name: `thub-job-${job.id}`, Driver: 'bridge' });

    this.container = await this.docker.createContainer({
      Image: image,
      name: `thub-${job.id}`,
      Cmd: ['--firmware', '/fw/app.bin'],
      ExposedPorts: { '5555/tcp': {} },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: this.network.id,
        Memory: parseSize(this.config.memory || '2g'),
        NanoCpus: (this.config.cpus || 2) * 1e9,
        ReadonlyRootfs: true,
        Binds: [`${fwDir}:/fw:ro`],
        PortBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
      },
    });

    await this.container.start();
    this.logShipper.push('emulator', `started container thub-${job.id} from ${image}`);

    const inspect = await this.container.inspect();
    this.hostPort = inspect.NetworkSettings.Ports['5555/tcp']?.[0]?.HostPort;

    this._streamContainerLogs();
    if (this.hostPort) await waitForTcp('127.0.0.1', Number(this.hostPort), 10_000);
  }

  async _pullIfMissing(image) {
    const images = await this.docker.listImages({ filters: { reference: [image] } });
    if (images.length > 0) return;
    await new Promise((resolve, reject) => {
      this.docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  _streamContainerLogs() {
    this.container
      .logs({ follow: true, stdout: true, stderr: true })
      .then((stream) => {
        stream.on('data', (buf) => this.logShipper.push('emulator', buf.toString('utf8').replace(/^.{8}/, '').trimEnd()));
      })
      .catch(() => {});
  }

  envFor() {
    return this.hostPort ? { THUB_DUT_HOST: `127.0.0.1:${this.hostPort}` } : {};
  }

  async teardown() {
    if (this.container) {
      await this.container.stop({ t: 5 }).catch(() => {});
      await this.container.remove({ force: true }).catch(() => {});
      this.container = null;
    }
    if (this.network) {
      await this.network.remove().catch(() => {});
      this.network = null;
    }
  }
}

function parseSize(s) {
  const m = /^(\d+)([kmg])?$/i.exec(String(s));
  if (!m) return undefined;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]?.toLowerCase()] || 1;
  return Number(m[1]) * mult;
}

function waitForTcp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${host}:${port}`));
        setTimeout(attempt, 250);
      });
    })();
  });
}

module.exports = { SwExecutor };
