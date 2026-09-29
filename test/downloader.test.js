/**
 * @file        packages/client/test/downloader.test.js
 * @description Tests: download policy, task inputs (downloaded files, git checkout at a ref/depth) and the task command
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
  { downloadAccess, prepareTask, downloadNames } = require('../src/downloader'),
  { JobRunner } = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thub-dl-')),
  git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

// Serves `root` over plain HTTP — archives, and a bare git repo via git's
// "dumb" HTTP protocol (after `git update-server-info`).
async function serve(root, seen = []){
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
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

test('downloads: every file into the downloads dir, named after its URL, numbered on clashes', async (t) => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'app.bin'), 'firmware');
  fs.writeFileSync(path.join(root, 'a', 'app.bin'), 'other');
  const { base, close } = await serve(root);
  t.after(close);
  const cfg = { sources: { allowedPrefixes: [base] } },
    jobDir = tmp(),
    task = await prepareTask({ downloads: [{ url: `${base}/app.bin` }, { url: `${base}/a/app.bin` }] }, jobDir, cfg);
  assert.deepEqual(task.downloads.map((p) => path.relative(jobDir, p)), ['downloads/app.bin', 'downloads/2-app.bin']);
  assert.equal(fs.readFileSync(task.downloads[1], 'utf8'), 'other');
  assert.ok(fs.statSync(task.workDir).isDirectory()); // no repo: an empty work dir
  assert.equal(task.commit, null);
  assert.deepEqual(downloadNames(['https://x/', 'https://x/a%20b.bin', 'https://x/../..']), ['download-1', 'a_b.bin', 'download-3']);
  await assert.rejects(prepareTask({ downloads: [{ url: 'https://evil.example/x' }] }, tmp(), cfg), /isn't an allowed download source/);
});

test('git repo: ref as branch, tag, full or short commit, or the default branch; depth honoured', async (t) => {
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
    at = async (extra) => {
      const task = await prepareTask({ git: { url, ...extra } }, tmp(), cfg);
      return [fs.readFileSync(path.join(task.workDir, 'which.txt'), 'utf8'), task.commit];
    };

  assert.equal((await at({}))[0], 'second');
  assert.equal((await at({ ref: 'feature' }))[0], 'feature');
  assert.equal((await at({ ref: 'v1' }))[0], 'first');
  assert.deepEqual(await at({ ref: first }), ['first', first]);
  assert.deepEqual(await at({ ref: first.slice(0, 8) }), ['first', first]);
  const full = await prepareTask({ git: { url, depth: 0 } }, tmp(), cfg);
  assert.equal(git(full.workDir, 'rev-list', '--count', 'HEAD'), '2');
  await assert.rejects(at({ ref: 'nope' }), /can't get ref nope/);
  await assert.rejects(prepareTask({ git: { url: 'https://other.example/r.git' } }, tmp(), cfg), /isn't an allowed download source/);
});

test('--git-options go between git and its subcommand on every call', async (t) => {
  const work = tmp(),
    root = tmp(),
    seen = [];
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'f.txt'), 'x');
  git(work, 'add', '.');
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'c1');
  execFileSync('git', ['clone', '-q', '--bare', work, path.join(root, 'repo.git')]);
  git(path.join(root, 'repo.git'), 'update-server-info');
  const { base, close } = await serve(root, seen);
  t.after(close);
  const task = await prepareTask(
    { git: { url: `${base}/repo.git`, options: '-c "http.extraHeader=X-Thub-Test: yes, it works"' } },
    tmp(),
    { sources: { allowedPrefixes: [base] } }
  );
  assert.ok(fs.existsSync(path.join(task.workDir, 'f.txt')));
  assert.ok(seen.length > 0);
  assert.ok(seen.every((h) => h['x-thub-test'] === 'yes, it works'), JSON.stringify(seen.map((h) => h['x-thub-test'])));
});

test('the command runs in the work dir via sh -c, with --arg values as "$@" and the job env', async () => {
  const jobDir = tmp(),
    downloadsDir = path.join(jobDir, 'downloads'),
    task = { workDir: path.join(jobDir, 'work'), downloadsDir, downloads: [path.join(downloadsDir, 'app.bin')], commit: 'abc123' },
    lines = [],
    runner = new JobRunner(null, {}),
    command = 'echo "cwd=$(basename "$PWD") args=$* job=$THUB_JOB_ID fw=$(basename "$THUB_DOWNLOAD_1") commit=$THUB_GIT_COMMIT dut=$THUB_DUT_HOST"; exit 3',
    job = { id: 'M-00007', spec: { command, args: ['a', 'b c'] } },
    executor = { envFor: () => ({ THUB_DUT_HOST: '127.0.0.1:5555' }) };
  fs.mkdirSync(task.workDir);
  const code = await runner._runCommand(job, task, executor, { push: (s, l) => lines.push(l) });
  assert.equal(code, 3);
  assert.ok(lines.includes('cwd=work args=a b c job=M-00007 fw=app.bin commit=abc123 dut=127.0.0.1:5555'), lines.join('\n'));
});
