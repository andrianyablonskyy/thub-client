/**
 * @file        packages/client/test/job-env.test.js
 * @description Tests: a job's --env reaches every command the Client runs for it, whatever the names; nothing in the
 *              Client depends on particular names (a registry login is the job's command's own business)
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
  { cloneRepo } = require('../src/downloader'),
  { SwExecutor, imageSource } = require('../src/executors/sw'),
  { JobRunner, dryRunPlan } = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thub-env-')),
  // Names of the job's own choosing — none of them means anything to the Client.
  ENV = { DOCKER_REGISTRY: 'registry.lab:5000', DOCKER_USER: 'nx-docker-service', DOCKER_PASSWORD: 'p a$s,w\'d' };

// A stand-in for `name` on PATH: logs its arguments, $JOB_MARK (and stdin,
// with `readStdin`) to <dir>/<name>.log, prints `out`.
function fakeTool(dir, name, { out = '', readStdin = false } = {}){
  const log = path.join(dir, `${name}.log`);
  fs.writeFileSync(path.join(dir, name),
    `#!/bin/sh\nprintf 'args=%s mark=%s stdin=%s\\n' "$*" "$JOB_MARK" "${readStdin ? '$(cat)' : ''}" >> '${log}'\n` +
    `printf '%s' '${out}'\n`, { mode: 0o755 });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

test('job env: git commands get it (under git\'s safety settings)', async () => {
  const bin = tmp(),
    calls = fakeTool(bin, 'git', { out: 'abc123' }),
    env = { JOB_MARK: 'm1', PATH: `${bin}:${process.env.PATH}` };
  assert.equal(await cloneRepo({ url: 'https://git.lab/r.git' }, path.join(tmp(), 'work'), { env }), 'abc123');
  assert.ok(calls().length >= 4 && calls().every((l) => l.includes('mark=m1')), calls().join('\n'));
});

test('the command gets the job env as given — its own docker login works with any names; the Client adds nothing', async () => {
  const bin = tmp(),
    calls = fakeTool(bin, 'docker', { readStdin: true }),
    jobDir = tmp(),
    task = { workDir: path.join(jobDir, 'work'), downloadsDir: path.join(jobDir, 'downloads'), downloads: [], commit: null },
    lines = [],
    job = {
      id: 'M-1',
      spec: {
        command: 'echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USER" --password-stdin' +
          ' && echo "config=${DOCKER_CONFIG:-unset}"',
        env: { ...ENV, PATH: `${bin}:${process.env.PATH}` }
      }
    };
  fs.mkdirSync(task.workDir);
  const code = await new JobRunner(null, {})._runCommand(job, task, { envFor: () => ({}) }, { push: (s, l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
  assert.deepEqual(calls(), [`args=login registry.lab:5000 --username nx-docker-service --password-stdin mark= stdin=${ENV.DOCKER_PASSWORD}`]);
  assert.ok(lines.includes('config=unset'), lines.join('\n')); // no DOCKER_CONFIG of the Client's
});

test('a DUT image is pulled from the registry it names (else Docker Hub) with the docker CLI — the host user\'s own logins', async () => {
  assert.deepEqual(imageSource('registry.lab:5000/python:3.14'), { label: 'registry registry.lab:5000', ref: 'registry.lab:5000/python:3.14' });
  assert.deepEqual(imageSource('python:3.14'), { label: 'Docker Hub', ref: 'python:3.14' });

  const bin = tmp(),
    calls = fakeTool(bin, 'docker'),
    ex = new SwExecutor({}, { push: () => {} }),
    savedPath = process.env.PATH;
  ex.docker = { listImages: async () => [] }; // not cached
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    assert.equal(await ex._pullIfMissing('registry.lab:5000/emu:1'), 'registry.lab:5000/emu:1');
  }
  finally {
    process.env.PATH = savedPath;
  }
  assert.deepEqual(calls(), ['args=pull -q registry.lab:5000/emu:1 mark= stdin=']);
});

test('dry run: every --env value hidden, whatever its name; no login step of the Client\'s', () => {
  const plan = dryRunPlan({ id: 'M-2', spec: { target: { type: 'hw', labels: [] }, command: './run.sh', env: { ...ENV, MODE: 'fast' } } }, '/w/M-2', {});
  assert.ok(plan.includes('  DOCKER_REGISTRY=***') && plan.includes('  MODE=***') && plan.includes('  DOCKER_PASSWORD=***'), plan.join('\n'));
  assert.ok(!plan.some((l) => l.includes(ENV.DOCKER_PASSWORD) || l.includes('nx-docker-service') || l.includes('docker login')));
  assert.ok(!plan.some((l) => l.includes('DOCKER_CONFIG')));
});
