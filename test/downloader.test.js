/**
 * @file        packages/client/test/downloader.test.js
 * @description Tests: download policy, test sources from archives (tar/zip) and git (branch/tag/commit), job commands
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
  http = require('node:http'),
  { execFileSync } = require('node:child_process'),
  { downloadAccess, fetchTests } = require('../src/downloader'),
  { JobRunner } = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thub-dl-')),
  git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

// Serves `root` over plain HTTP — archives, and a bare git repo via git's
// "dumb" HTTP protocol (after `git update-server-info`).
async function serve(root){
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()){
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('download policy: token only for Artifactory prefixes; other sources only if allowed, without it', () => {
  const cfg = {
    artifactory: { token: 'secret', allowedArtifactPrefixes: ['https://art.lab/fw/'] },
    sources: { allowedPrefixes: ['http://localhost/', 'https://git.lab/'] }
  };
  assert.deepEqual(downloadAccess('https://art.lab/fw/app.bin', cfg), { token: 'secret' });
  assert.deepEqual(downloadAccess('http://localhost/test-cases', cfg), { token: null });
  assert.deepEqual(downloadAccess('https://git.lab/team/tests.git', cfg), { token: null });
  assert.throws(() => downloadAccess('https://evil.example/x', cfg), /sources.*allowedPrefixes/);
  assert.deepEqual(downloadAccess('https://anything/x', { ...cfg, sources: { allowedPrefixes: ['*'] } }), { token: null });
  // Neither list configured: the original allow-all behavior, token included.
  assert.deepEqual(downloadAccess('https://anything/x', { artifactory: { token: 't' } }), { token: 't' });
});

test('test sources from a tar.gz or a zip archive, detected by content', async (t) => {
  const root = tmp(),
    src = path.join(tmp(), 'pkg');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'run-tests.sh'), '#!/bin/sh\necho hi\n');
  execFileSync('tar', ['-czf', path.join(root, 'tests.tgz'), '-C', src, '.']);
  execFileSync('zip', ['-qr', path.join(root, 'tests.bin'), '.'], { cwd: src }); // zip, misleading name
  const { base, close } = await serve(root);
  t.after(close);
  const cfg = { sources: { allowedPrefixes: [base] } };

  for (const name of ['tests.tgz', 'tests.bin']){
    const { testsDir, commit } = await fetchTests({ tests: { url: `${base}/${name}` } }, tmp(), cfg);
    assert.ok(fs.existsSync(path.join(testsDir, 'run-tests.sh')), name);
    assert.equal(commit, null);
  }
});

test('test sources from git: branch, tag, full and short commit, default branch', async (t) => {
  const work = tmp(),
    root = tmp();
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.email', 't@t');
  git(work, 'config', 'user.name', 't');
  const commit = (file) => {
      fs.writeFileSync(path.join(work, 'which.txt'), file);
      git(work, 'add', '.');
      git(work, 'commit', '-qm', file);
      return git(work, 'rev-parse', 'HEAD');
    },
    first = commit('first');
  git(work, 'tag', 'v1');
  commit('second');
  git(work, 'checkout', '-qb', 'feature');
  commit('feature');
  git(work, 'checkout', '-q', 'main');
  execFileSync('git', ['clone', '-q', '--bare', work, path.join(root, 'repo.git')]);
  git(path.join(root, 'repo.git'), 'update-server-info');
  const { base, close } = await serve(root);
  t.after(close);
  const cfg = { sources: { allowedPrefixes: [base] } },
    url = `${base}/repo.git`,
    fetchAt = async (ref) => {
      const { testsDir, commit: at } = await fetchTests({ tests: { git: { url, ...ref } } }, tmp(), cfg);
      return [fs.readFileSync(path.join(testsDir, 'which.txt'), 'utf8'), at];
    };

  assert.equal((await fetchAt({}))[0], 'second');
  assert.equal((await fetchAt({ branch: 'feature' }))[0], 'feature');
  assert.equal((await fetchAt({ tag: 'v1' }))[0], 'first');
  assert.deepEqual(await fetchAt({ commit: first }), ['first', first]);
  assert.deepEqual(await fetchAt({ commit: first.slice(0, 8) }), ['first', first]);
  await assert.rejects(fetchAt({ branch: 'nope' }), /can't get branch nope/);
  await assert.rejects(
    fetchTests({ tests: { git: { url: 'https://other.example/r.git' } } }, tmp(), cfg),
    /isn't an allowed download source/
  );
});

test('the job command runs in the sources via sh -c, with --arg values as "$@" and job env', async () => {
  const testsDir = tmp(),
    lines = [],
    runner = new JobRunner(null, { allowJobCommands: true }),
    command = 'echo "cwd=$(basename "$PWD") args=$* job=$THUB_JOB_ID dut=$THUB_DUT_HOST"; exit 3',
    job = { id: 'M-00007', spec: { tests: { command, args: ['a', 'b c'] } } },
    executor = { envFor: () => ({ THUB_DUT_HOST: '127.0.0.1:5555' }) },
    code = await runner._runTests(job, testsDir, executor, { push: (s, l) => lines.push(l) });
  assert.equal(code, 3);
  assert.ok(lines.includes(`cwd=${path.basename(testsDir)} args=a b c job=M-00007 dut=127.0.0.1:5555`), lines.join('\n'));
});

test('without a command, sources lacking run-tests.sh fail with a hint', async () => {
  const runner = new JobRunner(null, {});
  await assert.rejects(
    runner._runTests({ id: 'M-1', spec: { tests: {} } }, tmp(), { envFor: () => ({}) }, { push: () => {} }),
    /no run-tests\.sh.*--run/
  );
});
