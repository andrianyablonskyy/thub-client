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
    image: 'registry.lab:5000/emu:1',
    git: { url: 'git@bitbucket.org:team/tests.git', ref: 'main', depth: 20, options: '-c core.sshCommand="ssh -i /k"' },
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
    JOB_DOCKER_IMAGE: 'registry.lab:5000/emu:1',
    JOB_GIT_REPO_URL: 'git@bitbucket.org:team/tests.git', JOB_GIT_BRANCH: 'main', JOB_GIT_DEPTH: '20', JOB_GIT_OPTIONS: '-c core.sshCommand="ssh -i /k"',
    JOB_SUITE: 'smoke',
    JOB_ARG: '--junit fast', JOB_ARG_1: '--junit', JOB_ARG_2: 'fast',
    JOB_TIMEOUT: '600',
    JOB_PRIORITY: '70',
    JOB_META_CI_JOB_ID: '42', JOB_META_REPO: 'team/fw'
  });
});

test('parameters not given leave their variables unset; a git repo without a ref or depth gets depth 1, no branch', () => {
  const env = jobParamsEnv(spec({ target: { type: 'hw' }, git: { url: 'https://git.lab/r.git' } }));
  assert.deepEqual(Object.keys(env).sort(),
    ['JOB_COMMAND', 'JOB_GIT_DEPTH', 'JOB_GIT_REPO_URL', 'JOB_PRIORITY', 'JOB_SUITE', 'JOB_TIMEOUT', 'JOB_TYPE']);
  assert.equal(env.JOB_GIT_DEPTH, '1');
});

test('the command sees them — e.g. to clone the repo itself', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-jp-')),
    task = { workDir: path.join(jobDir, 'work'), downloadsDir: path.join(jobDir, 'downloads'), downloads: [], commit: null },
    lines = [],
    job = { id: 'M-1', spec: spec({
      target: { type: 'hw' }, git: { url: 'https://git.lab/r.git', ref: 'dev', depth: 5 },
      command: 'echo "git clone --depth $JOB_GIT_DEPTH --branch $JOB_GIT_BRANCH $JOB_GIT_REPO_URL"'
    }) };
  fs.mkdirSync(task.workDir);
  await new JobRunner(null, { name: 'HIL-4' })._runCommand(job, task, { envFor: () => ({}) }, { push: (s, l) => lines.push(l) });
  assert.ok(lines.includes('git clone --depth 5 --branch dev https://git.lab/r.git'), lines.join('\n'));
});

test('a dry run lists them with the rest of the command\'s environment', () => {
  const plan = dryRunPlan({ id: 'M-2', spec: spec({ target: { type: 'hw' }, git: { url: 'https://git.lab/r.git', ref: 'dev' } }) }, '/w/M-2', {});
  assert.ok(plan.includes('  export JOB_GIT_REPO_URL=https://git.lab/r.git') && plan.includes('  export JOB_GIT_BRANCH=dev'), plan.join('\n'));
});
