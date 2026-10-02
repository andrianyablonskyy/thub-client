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
  { shellQuote } = require('../src/downloader');

const JOB_DIR = '/var/lib/thub/j-1',
  WORK = `${JOB_DIR}/work`,
  job = (spec) => ({ id: 'j-1', spec: { target: { type: 'sw', labels: [] }, command: './run-tests.sh', ...spec } }),
  config = { hw: { stlinks: [{ path: '/dev/thub/dut1-stlink' }] } };

test('shellQuote: bare when safe, single-quoted otherwise', () => {
  assert.equal(shellQuote('/a/b-c.sh'), '/a/b-c.sh');
  assert.equal(shellQuote('a b'), '\'a b\'');
  assert.equal(shellQuote('it\'s'), '\'it\'\\\'\'s\'');
});

test('dry run: downloads, the command with its cwd and env; an SW job has nothing before or after it', () => {
  const plan = dryRunPlan(job({ args: ['a b'], suite: 'smoke', downloads: [{ url: 'https://art.lab/fw/app.bin' }] }), JOB_DIR, config);
  assert.ok(plan.includes(`  GET https://art.lab/fw/app.bin -> ${JOB_DIR}/downloads/app.bin`));
  assert.ok(!plan.some((l) => /docker|git /.test(l)), plan.join('\n')); // the Client never runs either itself
  assert.ok(plan.includes(`  cd ${WORK}`));
  assert.ok(plan.includes('  export THUB_SUITE=smoke'));
  assert.ok(plan.includes(`  export THUB_DOWNLOAD_1=${JOB_DIR}/downloads/app.bin`));
  assert.ok(plan.includes('  sh -c ./run-tests.sh thub-job \'a b\''));
  assert.ok(!plan.some((l) => l.startsWith('WOULD FAIL')));
});

test('dry run: HW steps; downloads from anywhere', () => {
  const plan = dryRunPlan(job({ target: { type: 'hw', labels: [] }, downloads: [{ url: 'https://elsewhere.example/x.bin' }] }), JOB_DIR, config);
  assert.ok(plan.some((l) => l.startsWith('  udevadm info --query=property --name=/dev/thub/dut1-stlink')));
  assert.ok(plan.includes(`  GET https://elsewhere.example/x.bin -> ${JOB_DIR}/downloads/x.bin`));
  assert.ok(!plan.some((l) => l.startsWith('WOULD FAIL')));
});
