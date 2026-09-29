/**
 * @file        packages/client/test/dry-run.test.js
 * @description Tests: a dry run logs the full commands the real job would run on the Client
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
  { dryRunPlan } = require('../src/runner'),
  { gitSteps, shellQuote } = require('../src/downloader');

const JOB_DIR = '/var/lib/thub/j-1',
  WORK = `${JOB_DIR}/work`,
  job = (spec) => ({ id: 'j-1', spec: { target: { type: 'sw', labels: [] }, command: './run-tests.sh', ...spec } }),
  config = { hw: { stlinks: [{ path: '/dev/thub/dut1-stlink' }] } };

test('shellQuote: bare when safe, single-quoted otherwise', () => {
  assert.equal(shellQuote('/a/b-c.sh'), '/a/b-c.sh');
  assert.equal(shellQuote('a b'), '\'a b\'');
  assert.equal(shellQuote('it\'s'), '\'it\'\\\'\'s\'');
});

test('dry run: git commands in full, --git-options included, same as the real clone', () => {
  const git = { url: 'git@bitbucket.org:team/tests.git', ref: 'main', depth: 1, options: '-c core.sshCommand="ssh -i /k -p 2222"' },
    plan = dryRunPlan(job({ git }), JOB_DIR, config),
    steps = gitSteps(git, WORK);
  assert.deepEqual(steps.fetch[0], ['-c', 'core.sshCommand=ssh -i /k -p 2222', '-C', WORK, 'fetch', '-q', '--depth', '1', 'origin', 'main']);
  assert.ok(plan.includes(`  git -c 'core.sshCommand=ssh -i /k -p 2222' -C ${WORK} fetch -q --depth 1 origin main`), plan.join('\n'));
  assert.ok(plan.includes('  export THUB_GIT_COMMIT=\'<checked-out commit>\''));
  assert.ok(!plan.some((l) => l.startsWith('WOULD FAIL')));
});

test('dry run: downloads, the SW container, the command with its cwd and env, teardown', () => {
  const plan = dryRunPlan(job({
    args: ['a b'], suite: 'smoke', image: 'registry.lab:5000/dut-emulator:1', downloads: [{ url: 'https://art.lab/fw/app.bin' }]
  }), JOB_DIR, config);
  assert.ok(plan.includes(`  GET https://art.lab/fw/app.bin -> ${JOB_DIR}/downloads/app.bin`));
  assert.ok(plan.includes('  docker pull registry.lab:5000/dut-emulator:1   # registry registry.lab:5000, unless already cached'));
  assert.ok(plan.some((l) => l.includes('docker run -d --name thub-j-1') && l.includes('--memory 2g --cpus 2') &&
    l.includes(`-v ${JOB_DIR}/downloads:/downloads:ro`)));
  assert.ok(plan.includes(`  cd ${WORK}`));
  assert.ok(plan.includes('  export THUB_SUITE=smoke'));
  assert.ok(plan.includes(`  export THUB_DOWNLOAD_1=${JOB_DIR}/downloads/app.bin`));
  assert.ok(plan.includes('  sh -c ./run-tests.sh thub-job \'a b\''));
  assert.ok(plan.includes('  docker rm -f thub-j-1'));
});

test('dry run: HW steps; downloads from anywhere; SW without an image: no container', () => {
  const plan = dryRunPlan(job({ target: { type: 'hw', labels: [] }, downloads: [{ url: 'https://elsewhere.example/x.bin' }] }), JOB_DIR, config);
  assert.ok(plan.some((l) => l.startsWith('  udevadm info --query=property --name=/dev/thub/dut1-stlink')));
  assert.ok(plan.includes(`  GET https://elsewhere.example/x.bin -> ${JOB_DIR}/downloads/x.bin`));
  assert.ok(!plan.some((l) => l.startsWith('WOULD FAIL')));

  const noImage = dryRunPlan(job({}), JOB_DIR, config);
  assert.ok(noImage.includes('  no --docker-image — the command runs without a DUT container'));
  assert.ok(!noImage.some((l) => l.startsWith('WOULD FAIL')));
});
