/**
 * @file        packages/client/src/executors/sw.js
 * @description SW executor: runs a job's DUT emulator in a per-job Docker container (README §8.3)
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

const net = require('node:net'),
  Docker = require('dockerode'),
  { shellJoin } = require('../downloader'),
  { registryHost } = require('../docker-login');

// §8.3 SW executor: runs a job's DUT image (--docker-image) in Docker, per
// job — isolated network, read-only rootfs, fixed resource limits, always
// removed (§12). An SW Client has no settings of its own.
const DUT_CPUS = 2,
  DUT_MEMORY = '2g';

class SwExecutor{
  constructor(config, logShipper){
    this.logShipper = logShipper;
    this.docker = new Docker();
    this.container = null;
    this.network = null;
    this.hostPort = null;
    this.containerName = null;
  }

  // The DUT container: the job's own Docker image (--docker-image), run with
  // its default command, the job's downloads mounted read-only at
  // /downloads. Without one there's no container: the command runs on its
  // own. `login`: the job's registry login (docker-login.js), used to pull
  // from that registry.
  async prepare(job, downloadsDir, { login = null } = {}){
    const image = job.spec.image || null;
    if (!image){
      this.logShipper.push('emulator', 'no --docker-image — running the command without a DUT container');
      return;
    }

    const ref = await this._pullIfMissing(image, login);
    this.containerName = `thub-${job.id}`;

    this.network = await this.docker.createNetwork({ Name: `thub-job-${job.id}`, Driver: 'bridge' });

    this.container = await this.docker.createContainer({
      Image: ref,
      name: this.containerName,
      ExposedPorts: { '5555/tcp': {} },
      HostConfig: {
        AutoRemove: false,
        NetworkMode: this.network.id,
        Memory: parseSize(DUT_MEMORY),
        NanoCpus: DUT_CPUS * 1e9,
        ReadonlyRootfs: true,
        ...(downloadsDir ? { Binds: [`${downloadsDir}:/downloads:ro`] } : {}),
        PortBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] }
      }
    });

    await this.container.start();
    this.logShipper.push('emulator', `started container ${this.containerName} from ${ref}`);

    const inspect = await this.container.inspect();
    this.hostPort = inspect.NetworkSettings.Ports['5555/tcp']?.[0]?.HostPort;

    this._streamContainerLogs();
    if (this.hostPort){
      try {
        await waitForTcp('127.0.0.1', Number(this.hostPort), 10_000);
      }
      catch {
        // Not every image serves on 5555; the command can still reach the
        // container via THUB_DUT_CONTAINER (docker exec / logs).
        this.logShipper.push('emulator', `nothing listening on port 5555 in ${ref} — the command can use THUB_DUT_CONTAINER=${this.containerName}`);
      }
    }
  }

  // What prepare()/teardown() would do, as the equivalent docker CLI
  // commands (the Client uses the Docker API), without doing it (a dry run):
  // { steps, teardown, env, problems }.
  plan(job, downloadsDir, { login = null } = {}){
    const image = job.spec.image || null;
    if (!image){
      return { steps: ['no --docker-image — the command runs without a DUT container'], teardown: [], env: {}, problems: [] };
    }
    const { label, ref, auth } = imageSource(image, login),
      container = `thub-${job.id}`,
      network = `thub-job-${job.id}`;
    return {
      steps: [
        `docker pull ${ref}   # ${label}${auth ? ` as ${auth.username}` : ''}, unless already cached`,
        `docker network create --driver bridge ${network}`,
        shellJoin([
          'docker', 'run', '-d', '--name', container, '--network', network,
          '--memory', DUT_MEMORY, '--cpus', String(DUT_CPUS), '--read-only',
          ...(downloadsDir ? ['-v', `${downloadsDir}:/downloads:ro`] : []),
          '-p', '127.0.0.1::5555', ref
        ]),
        'wait up to 10 s for 127.0.0.1:<host port> (container port 5555)'
      ],
      teardown: [`docker stop -t 5 ${container}`, `docker rm -f ${container}`, `docker network rm ${network}`],
      env: { THUB_DUT_HOST: '127.0.0.1:<host port>', THUB_DUT_CONTAINER: container },
      problems: []
    };
  }

  // The image as referenced, pulled unless it's already cached here.
  async _pullIfMissing(image, login){
    const { label, ref, auth } = imageSource(image, login);
    if (await this._isCached(ref)){
      this.logShipper.push('emulator', `using cached image ${ref}`);
      return ref;
    }
    this.logShipper.push('emulator', `pulling ${ref} from ${label}${auth ? ` as ${auth.username}` : ''}`);
    try {
      await this._pull(ref, auth);
    }
    catch (err){
      throw new Error(`Image ${ref} not available from ${label}: ${err.message}`);
    }
    return ref;
  }

  async _isCached(ref){
    const images = await this.docker.listImages({ filters: { reference: [ref] } });
    return images.length > 0;
  }

  _pull(ref, auth){
    return new Promise((resolve, reject) => {
      this.docker.pull(ref, auth ? { authconfig: auth } : {}, (err, stream) => {
        if (err){
          return reject(err);
        }
        this.docker.modem.followProgress(stream, (err2) => (err2 ? reject(err2) : resolve()));
      });
    });
  }

  _streamContainerLogs(){
    this.container
      .logs({ follow: true, stdout: true, stderr: true })
      .then((stream) => {
        stream.on('data', (buf) => this.logShipper.push('emulator', buf.toString('utf8').replace(/^.{8}/, '').trimEnd()));
      })
      .catch(() => {});
  }

  envFor(){
    return {
      ...(this.hostPort ? { THUB_DUT_HOST: `127.0.0.1:${this.hostPort}` } : {}),
      // For `docker exec`/`docker logs` from the job's command.
      ...(this.containerName ? { THUB_DUT_CONTAINER: this.containerName } : {})
    };
  }

  async teardown(){
    if (this.container){
      await this.container.stop({ t: 5 }).catch(() => {});
      await this.container.remove({ force: true }).catch(() => {});
      this.container = null;
    }
    if (this.network){
      await this.network.remove().catch(() => {});
      this.network = null;
    }
  }
}

// Where `image` comes from: the registry host it names (`registry.lab:5000/
// emu:1`), else Docker Hub (`alpine`, `library/ubuntu:24.04`). The job's
// registry login (`login`, docker-login.js) is used for the registry it
// names. Returns { label, ref, auth }.
function imageSource(image, login = null){
  const [first, ...rest] = image.split('/'),
    host = rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : null,
    label = host ? `registry ${host}` : 'Docker Hub',
    auth = login && registryHost(login.registry) === registryHost(host || 'docker.io')
      ? { username: login.username, password: login.password, serveraddress: registryHost(login.registry) }
      : null;
  return { label, ref: image, auth };
}

function parseSize(s){
  const m = /^(\d+)([kmg])?$/i.exec(String(s));
  if (!m){
    return undefined;
  }
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]?.toLowerCase()] || 1;
  return Number(m[1]) * mult;
}

function waitForTcp(host, port, timeoutMs){
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt(){
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline){
          return reject(new Error(`Timed out waiting for ${host}:${port}`));
        }
        setTimeout(attempt, 250);
      });
    })();
  });
}

module.exports = { SwExecutor, imageSource };
