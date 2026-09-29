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

function executor(sw){
  const ex = new SwExecutor({ sw: { allowDockerHub: true, ...sw } }, { push: () => {} }),
    docker = fakeDocker();
  ex.docker = docker;
  return { ex, docker };
}

const job = (image) => ({ id: 'M-00001', spec: { target: { type: 'sw' }, command: 'x', ...(image ? { image } : {}) } });

test('no job image: the Client\'s own sw.image, with sw.cmd and the downloads mounted read-only', async () => {
  const { ex, docker } = executor({ image: 'dut-emulator:1', cmd: ['--firmware', '/downloads/app.bin'] });
  await ex.prepare(job(), '/job/downloads');
  assert.equal(docker.calls.created.Image, 'dut-emulator:1');
  assert.deepEqual(docker.calls.created.Cmd, ['--firmware', '/downloads/app.bin']);
  assert.deepEqual(docker.calls.created.HostConfig.Binds, ['/job/downloads:/downloads:ro']);
  assert.equal(docker.calls.created.HostConfig.ReadonlyRootfs, true);
  assert.equal(ex.envFor().THUB_DUT_CONTAINER, 'thub-M-00001');
});

test('a job image runs as-is (its own command), same sandbox, when allowed', async () => {
  const { ex, docker } = executor({ image: 'dut-emulator:1', cmd: ['--x'], allowJobImages: true });
  await ex.prepare(job('alpine'), null);
  assert.equal(docker.calls.created.Image, 'alpine');
  assert.equal(docker.calls.created.Cmd, undefined);
  assert.equal(docker.calls.created.HostConfig.Binds, undefined);
  assert.equal(docker.calls.created.HostConfig.ReadonlyRootfs, true);
  assert.equal(docker.calls.created.HostConfig.NetworkMode, 'net1');
});

test('a job image is refused unless sw.allowJobImages; no image at all means no container', async () => {
  const refused = executor({ image: 'dut-emulator:1' });
  await assert.rejects(refused.ex.prepare(job('alpine'), null), /allowJobImages/);
  assert.equal(refused.docker.calls.created, null);

  const none = executor({});
  await none.ex.prepare(job(), null);
  assert.equal(none.docker.calls.created, null);
  assert.deepEqual(none.ex.envFor(), {});
});
