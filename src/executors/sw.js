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
  Docker = require('dockerode');

// §8.3 SW executor: runs the DUT emulator in Docker, per job — isolated
// network, read-only rootfs, resource limits, always removed (§12).
class SwExecutor{
  constructor(config, logShipper){
    this.config = config.sw || {};
    this.logShipper = logShipper;
    this.docker = new Docker();
    this.container = null;
    this.network = null;
    this.hostPort = null;
  }

  async prepare(job, fwDir){
    const image = this.config.image;
    if (!image){
      throw new Error('sw.image is not configured on this Client');
    }

    const ref = await this._resolveImage(image);

    this.network = await this.docker.createNetwork({ Name: `thub-job-${job.id}`, Driver: 'bridge' });

    this.container = await this.docker.createContainer({
      Image: ref,
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
        PortBindings: { '5555/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] }
      }
    });

    await this.container.start();
    this.logShipper.push('emulator', `started container thub-${job.id} from ${ref}`);

    const inspect = await this.container.inspect();
    this.hostPort = inspect.NetworkSettings.Ports['5555/tcp']?.[0]?.HostPort;

    this._streamContainerLogs();
    if (this.hostPort){
      await waitForTcp('127.0.0.1', Number(this.hostPort), 10_000);
    }
  }

  // Finds `sw.image` in order (README §8.3): the local registry
  // (`sw.registry`), then Docker Hub if `sw.allowDockerHub`, else fails.
  // Each source counts if its image is already cached here or pulls now.
  // Returns the image reference to run.
  async _resolveImage(image){
    const sources = imageSources(image, this.config),
      tried = [];
    if (!sources.length){
      throw new Error('No image source for sw.image: set sw.registry (local registry) and/or sw.allowDockerHub: true');
    }
    for (const { label, ref, auth }of sources){
      try {
        if (await this._isCached(ref)){
          this.logShipper.push('emulator', `using cached image ${ref} (${label})`);
          return ref;
        }
        this.logShipper.push('emulator', `pulling ${ref} from ${label}`);
        await this._pull(ref, auth);
        return ref;
      }
      catch (err){
        this.logShipper.push('emulator', `${label}: ${ref} not available (${err.message})`);
        tried.push(`${label}: ${err.message}`);
      }
    }
    if (!this.config.allowDockerHub && this.config.registry){
      tried.push('Docker Hub: disabled (sw.allowDockerHub)');
    }
    throw new Error(`Image ${image} not found — ${tried.join('; ')}`);
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
    return this.hostPort ? { THUB_DUT_HOST: `127.0.0.1:${this.hostPort}` } : {};
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

// Docker Hub's own hostnames; `docker.io/library/ubuntu` is just `ubuntu`.
const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);

// Where to look for `image`, in order. `image` is normally a plain
// repository name (`dut-emulator:2026.08`, `library/ubuntu:24.04`); one
// that names its own registry host is used as-is, from that host only.
function imageSources(image, { registry, allowDockerHub, registryAuth }){
  const [first, ...rest] = image.split('/'),
    hasHost = rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (hasHost && !DOCKER_HUB_HOSTS.has(first)){
    return [{ label: `registry ${first}`, ref: image, auth: first === registry ? registryAuth : null }];
  }
  const name = hasHost ? rest.join('/') : image,
    sources = [];
  if (registry){
    sources.push({ label: `local registry ${registry}`, ref: `${registry}/${name}`, auth: registryAuth });
  }
  if (allowDockerHub){
    sources.push({ label: 'Docker Hub', ref: name, auth: null });
  }
  return sources;
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

module.exports = { SwExecutor, imageSources };
