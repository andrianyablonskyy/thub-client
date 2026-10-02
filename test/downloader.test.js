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
  { prepareTask, downloadNames } = require('../src/downloader'),
  { JobRunner } = require('../src/runner');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thub-dl-'));

// Serves `root` over plain HTTP.
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

test('downloads: every file into the downloads dir, named after its URL, numbered on clashes; no credentials sent', async (t) => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'a'));
  fs.writeFileSync(path.join(root, 'app.bin'), 'firmware');
  fs.writeFileSync(path.join(root, 'a', 'app.bin'), 'other');
  const seen = [],
    { base, close } = await serve(root, seen);
  t.after(close);
  const jobDir = tmp(),
    task = await prepareTask({ downloads: [{ url: `${base}/app.bin` }, { url: `${base}/a/app.bin` }] }, jobDir);
  assert.deepEqual(task.downloads.map((p) => path.relative(jobDir, p)), ['downloads/app.bin', 'downloads/2-app.bin']);
  assert.equal(fs.readFileSync(task.downloads[1], 'utf8'), 'other');
  assert.ok(fs.statSync(task.workDir).isDirectory()); // an empty work dir: the command clones into it if it needs to
  assert.deepEqual(downloadNames(['https://x/', 'https://x/a%20b.bin', 'https://x/../..']), ['download-1', 'a_b.bin', 'download-3']);
  assert.ok(seen.every((h) => !h.authorization));
  await assert.rejects(prepareTask({ downloads: [{ url: `${base}/missing.bin` }] }, tmp()), /Download failed \(404\)/);
});

test('the command runs in the work dir via sh -c, with --arg values as "$@" and the job env', async () => {
  const jobDir = tmp(),
    downloadsDir = path.join(jobDir, 'downloads'),
    task = { workDir: path.join(jobDir, 'work'), downloadsDir, downloads: [path.join(downloadsDir, 'app.bin')] },
    lines = [],
    runner = new JobRunner(null, {}),
    command = 'echo "cwd=$(basename "$PWD") args=$* job=$THUB_JOB_ID fw=$(basename "$THUB_DOWNLOAD_1") dut=$THUB_DUT_STLINK"; exit 3',
    job = { id: 'M-00007', spec: { command, args: ['a', 'b c'] } },
    executor = { envFor: () => ({ THUB_DUT_STLINK: '066D' }) };
  fs.mkdirSync(task.workDir);
  const code = await runner._runCommand(job, task, executor, { push: (s, l) => lines.push(l) });
  assert.equal(code, 3);
  assert.ok(lines.includes('cwd=work args=a b c job=M-00007 fw=app.bin dut=066D'), lines.join('\n'));
});
