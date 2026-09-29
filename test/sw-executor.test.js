/**
 * @file        packages/client/test/sw-executor.test.js
 * @description Tests: SW executor container setup — the Client's own image vs a job-supplied one, downloads mount
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  { SwExecutor } = require('../src/executors/sw');

// Records what the executor asks Docker for; images count as cached, and
// nothing listens on the container's port.
function fakeDocker(){
  const calls = { created: null };
  return {
    calls,
    listImages: async () => [{}],
    createNetwork: async () => ({ id: 'net1', remove: async () => {} }),
    createContainer: async (opts) => {
      calls.created = opts;
      return {
        start: async () => {},
        inspect: async () => ({ NetworkSettings: { Ports: {} } }),
        logs: async () => ({ on: () => {} }),
        stop: async () => {},
        remove: async () => {}
      };
    }
  };
}

function executor(){
  const ex = new SwExecutor({}, { push: () => {} }),
    docker = fakeDocker();
  ex.docker = docker;
  return { ex, docker };
}

const job = (image) => ({ id: 'M-00001', spec: { target: { type: 'sw' }, command: 'x', ...(image ? { image } : {}) } });

test('a job image runs as-is (its own command), sandboxed, fixed limits, the downloads mounted read-only', async () => {
  const { ex, docker } = executor();
  await ex.prepare(job('alpine'), '/job/downloads');
  const created = docker.calls.created;
  assert.equal(created.Image, 'alpine');
  assert.equal(created.Cmd, undefined);
  assert.deepEqual(created.HostConfig.Binds, ['/job/downloads:/downloads:ro']);
  assert.deepEqual([created.HostConfig.ReadonlyRootfs, created.HostConfig.NetworkMode], [true, 'net1']);
  assert.deepEqual([created.HostConfig.NanoCpus, created.HostConfig.Memory], [2e9, 2 * 1024 ** 3]);
  assert.equal(ex.envFor().THUB_DUT_CONTAINER, 'thub-M-00001');
});

test('no job image means no container', async () => {
  const { ex, docker } = executor();
  await ex.prepare(job(), null);
  assert.equal(docker.calls.created, null);
  assert.deepEqual(ex.envFor(), {});
});
