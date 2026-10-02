/**
 * @file        packages/client/test/job-params-env.test.js
 * @description Tests: the job's `thub run` parameters reach its command as JOB_<NAME> environment variables
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
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { validateJobSpec } = require('@andrian.yablonskyy/thub-common'),
  { jobParamsEnv } = require('../src/job-params-env'),
  { JobRunner, dryRunPlan } = require('../src/runner');

// A spec as the Coordinator hands it over (validated, defaults filled in).
const spec = (extra) => validateJobSpec({ command: './run.sh', ...extra }).spec;

test('every parameter that reaches the Client, as JOB_<NAME>', () => {
  const env = jobParamsEnv(spec({
    target: { type: 'sw', labels: ['board:nucleo-f401re', 'uart'], group: 'g-1', client: 'res_1' },
    user: 'Alice', args: ['--junit', 'fast'], suite: 'smoke', timeoutSec: 600, priority: 70,
    downloads: [{ url: 'https://art/app.bin' }, { url: 'https://art/tests.tgz' }],
    meta: { ciJobId: 42, repo: 'team/fw', nested: { x: 1 } },
    env: { SECRET: 'x' }
  }), { clientName: 'HIL-4' });
  assert.deepEqual(env, {
    JOB_TYPE: 'sw',
    JOB_LABEL: 'board:nucleo-f401re,uart', JOB_LABEL_1: 'board:nucleo-f401re', JOB_LABEL_2: 'uart',
    JOB_GROUP: 'g-1',
    JOB_CLIENT: 'HIL-4',
    JOB_USER: 'Alice',
    JOB_COMMAND: './run.sh',
    JOB_DOWNLOAD_FILE: 'https://art/app.bin\nhttps://art/tests.tgz', JOB_DOWNLOAD_FILE_1: 'https://art/app.bin', JOB_DOWNLOAD_FILE_2: 'https://art/tests.tgz',
    JOB_SUITE: 'smoke',
    JOB_ARG: '--junit fast', JOB_ARG_1: '--junit', JOB_ARG_2: 'fast',
    JOB_TIMEOUT: '600',
    JOB_PRIORITY: '70',
    JOB_META_CI_JOB_ID: '42', JOB_META_REPO: 'team/fw'
  });
});

test('parameters not given leave their variables unset', () => {
  const env = jobParamsEnv(spec({ target: { type: 'hw' } }));
  assert.deepEqual(Object.keys(env).sort(), ['JOB_COMMAND', 'JOB_PRIORITY', 'JOB_SUITE', 'JOB_TIMEOUT', 'JOB_TYPE']);
});

test('the command sees them', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-jp-')),
    task = { workDir: path.join(jobDir, 'work'), downloadsDir: path.join(jobDir, 'downloads'), downloads: [] },
    lines = [],
    job = { id: 'M-1', spec: spec({ target: { type: 'hw', labels: ['uart'] }, suite: 'smoke', command: 'echo "suite=$JOB_SUITE labels=$JOB_LABEL"' }) };
  fs.mkdirSync(task.workDir);
  await new JobRunner(null, { name: 'HIL-4' })._runCommand(job, task, { envFor: () => ({}) }, { push: (s, l) => lines.push(l) });
  assert.ok(lines.includes('suite=smoke labels=uart'), lines.join('\n'));
});

test('a dry run lists them with the rest of the command\'s environment', () => {
  const plan = dryRunPlan({ id: 'M-2', spec: spec({ target: { type: 'hw', labels: ['uart'] }, suite: 'smoke' }) }, '/w/M-2', {});
  assert.ok(plan.includes('  export JOB_SUITE=smoke') && plan.includes('  export JOB_LABEL=uart'), plan.join('\n'));
});
