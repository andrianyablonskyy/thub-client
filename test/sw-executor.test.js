/**
 * @file        packages/client/test/sw-executor.test.js
 * @description Tests: SW executor container setup for a firmware file vs a job-supplied Docker image
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

const job = (firmware) => ({ id: 'M-00001', spec: { target: { type: 'sw' }, firmware } });

test('a firmware file runs in the Client\'s own emulator image with the file mounted', async () => {
  const { ex, docker } = executor({ image: 'dut-emulator:1' });
  await ex.prepare(job({ url: 'https://x/app.bin' }), '/work/fw');
  assert.equal(docker.calls.created.Image, 'dut-emulator:1');
  assert.deepEqual(docker.calls.created.Cmd, ['--firmware', '/fw/app.bin']);
  assert.deepEqual(docker.calls.created.HostConfig.Binds, ['/work/fw:/fw:ro']);
  assert.equal(docker.calls.created.HostConfig.ReadonlyRootfs, true);
  assert.equal(ex.envFor().THUB_DUT_CONTAINER, 'thub-M-00001');
});

test('a job image runs as-is (its own command, no mount), same sandbox, when allowed', async () => {
  const { ex, docker } = executor({ image: 'dut-emulator:1', allowJobImages: true });
  await ex.prepare(job({ image: 'alpine' }), null);
  assert.equal(docker.calls.created.Image, 'alpine');
  assert.equal(docker.calls.created.Cmd, undefined);
  assert.equal(docker.calls.created.HostConfig.Binds, undefined);
  assert.equal(docker.calls.created.HostConfig.ReadonlyRootfs, true);
  assert.equal(docker.calls.created.HostConfig.NetworkMode, 'net1');
});

test('a job image is refused unless sw.allowJobImages', async () => {
  const { ex, docker } = executor({ image: 'dut-emulator:1' });
  await assert.rejects(ex.prepare(job({ image: 'alpine' }), null), /allowJobImages/);
  assert.equal(docker.calls.created, null);
});
