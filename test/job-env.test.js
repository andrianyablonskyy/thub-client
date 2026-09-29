/**
 * @file        packages/client/test/job-env.test.js
 * @description Tests: a job's --env reaches every command the Client runs for it; DOCKER_* log in to a registry first
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
  { dockerLoginFor, dockerLogin } = require('../src/docker-login'),
  { cloneRepo } = require('../src/downloader'),
  { imageSource } = require('../src/executors/sw'),
  { JobRunner, dryRunPlan } = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thub-env-')),
  LOGIN = { DOCKER_REGISTRY: 'registry.lab:5000', DOCKER_USERNAME: 'ci', DOCKER_PASSWORD: 'p a$s,w\'d' };

// A stand-in for `name` on PATH: logs its arguments, $DOCKER_CONFIG, $JOB_MARK
// (and stdin, with `readStdin`) to <dir>/<name>.log, prints `out`.
function fakeTool(dir, name, { out = '', readStdin = false } = {}){
  const log = path.join(dir, `${name}.log`);
  fs.writeFileSync(path.join(dir, name),
    `#!/bin/sh\nprintf 'args=%s config=%s mark=%s stdin=%s\\n' "$*" "$DOCKER_CONFIG" "$JOB_MARK" "${readStdin ? '$(cat)' : ''}" >> '${log}'\n` +
    `printf '%s' '${out}'\n`, { mode: 0o755 });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

test('docker login: only with all three DOCKER_* set; the password over stdin, into the job\'s own DOCKER_CONFIG', async () => {
  assert.equal(dockerLoginFor({ DOCKER_USERNAME: 'ci', DOCKER_PASSWORD: 'x' }), null);
  assert.deepEqual(dockerLoginFor(LOGIN), { registry: 'registry.lab:5000', username: 'ci', password: LOGIN.DOCKER_PASSWORD });

  const bin = tmp(),
    calls = fakeTool(bin, 'docker', { readStdin: true }),
    config = path.join(tmp(), 'docker');
  await dockerLogin({ ...LOGIN, PATH: `${bin}:${process.env.PATH}` }, config);
  assert.deepEqual(calls(), [`args=login registry.lab:5000 --username ci --password-stdin config=${config} mark= stdin=${LOGIN.DOCKER_PASSWORD}`]);
  assert.equal(fs.statSync(config).mode & 0o777, 0o700);

  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\necho "unauthorized: incorrect username or password" >&2\nexit 1\n');
  await assert.rejects(dockerLogin({ ...LOGIN, PATH: `${bin}:${process.env.PATH}` }, config),
    /docker login registry.lab:5000 as ci failed: unauthorized/);
});

test('job env: git commands get it (under git\'s safety settings), and so does the command, with DOCKER_CONFIG after a login', async () => {
  const bin = tmp(),
    calls = fakeTool(bin, 'git', { out: 'abc123' }),
    env = { JOB_MARK: 'm1', PATH: `${bin}:${process.env.PATH}` };
  assert.equal(await cloneRepo({ url: 'https://git.lab/r.git' }, path.join(tmp(), 'work'), { env }), 'abc123');
  assert.ok(calls().length >= 4 && calls().every((l) => l.includes('mark=m1')), calls().join('\n'));

  const jobDir = tmp(),
    task = { workDir: path.join(jobDir, 'work'), downloadsDir: path.join(jobDir, 'downloads'), downloads: [], commit: null,
      dockerConfig: path.join(jobDir, 'docker') },
    lines = [],
    command = 'echo "mark=$JOB_MARK reg=$DOCKER_REGISTRY config=$DOCKER_CONFIG job=$THUB_JOB_ID"',
    job = { id: 'M-1', spec: { command, env: { ...LOGIN, JOB_MARK: 'm2' } } };
  fs.mkdirSync(task.workDir);
  await new JobRunner(null, {})._runCommand(job, task, { envFor: () => ({}) }, { push: (s, l) => lines.push(l) });
  assert.ok(lines.includes(`mark=m2 reg=registry.lab:5000 config=${task.dockerConfig} job=M-1`), lines.join('\n'));
});

test('an image is pulled from the registry it names (else Docker Hub), with the job\'s login for that registry', () => {
  const login = { registry: 'https://registry.lab:5000/', username: 'ci', password: 'pw' };
  assert.deepEqual(imageSource('registry.lab:5000/python:3.14', login), {
    label: 'registry registry.lab:5000', ref: 'registry.lab:5000/python:3.14', auth: { username: 'ci', password: 'pw', serveraddress: 'registry.lab:5000' }
  });
  assert.deepEqual(imageSource('python:3.14', login), { label: 'Docker Hub', ref: 'python:3.14', auth: null });
  assert.equal(imageSource('other.lab/app:1', login).auth, null);
  assert.equal(imageSource('alpine', { registry: 'docker.io', username: 'u', password: 'p' }).auth.username, 'u');
});

test('dry run: the job env (secret-looking values masked) and the registry login, before everything else', () => {
  const plan = dryRunPlan({ id: 'M-2', spec: { target: { type: 'sw', labels: [] }, command: './run.sh', env: { ...LOGIN, MODE: 'fast' } } }, '/w/M-2', {}),
    at = (s) => plan.findIndex((l) => l.includes(s));
  assert.ok(plan.includes('  DOCKER_PASSWORD=\'***\''), plan.join('\n'));
  assert.ok(plan.includes('  DOCKER_REGISTRY=registry.lab:5000'));
  assert.ok(plan.includes('  MODE=fast'));
  assert.ok(!plan.some((l) => l.includes(LOGIN.DOCKER_PASSWORD)));
  assert.ok(at('docker login "$DOCKER_REGISTRY"') > 0 && at('docker login') < at('sh -c ./run.sh'));
  assert.ok(plan.includes('  export DOCKER_CONFIG=/w/M-2/docker'));
});
