/**
 * @file        packages/client/test/artifacts-file.test.js
 * @description Tests: the artifacts list a job's command writes to $THUB_ARTIFACTS_FILE, reported with the result
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
  { readArtifactsList, jobEnv } = require('../src/runner');

test('THUB_ARTIFACTS_FILE sits next to the work directory, not in the checkout', () => {
  const env = jobEnv({ id: 'M-00001', spec: { target: { type: 'sw' } } }, { workDir: '/var/lib/thub/work/dut0/M-00001/work', downloads: [] }, {}, 'lab');
  assert.equal(env.THUB_ARTIFACTS_FILE, '/var/lib/thub/work/dut0/M-00001/artifacts.json');
});

test('the list is read as written; missing, broken or oversized files report nothing, said in the log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-artfile-')),
    file = path.join(dir, 'artifacts.json'),
    lines = [],
    log = (l) => lines.push(l);

  assert.equal(readArtifactsList(file, log), undefined); // the job reported none
  assert.deepEqual(lines, []);

  const list = [{ name: 'app.bin', size: 1233, link: 'https://artifactory.example.com/app.bin', timestamp: 1790000000 }];
  fs.writeFileSync(file, JSON.stringify(list));
  assert.deepEqual(readArtifactsList(file, log), list);
  assert.match(lines.pop(), /reported 1 artifact/);

  fs.writeFileSync(file, '[{"name": ');
  assert.equal(readArtifactsList(file, log), undefined);
  assert.match(lines.pop(), /ignored: not valid JSON/);

  fs.writeFileSync(file, '{"name": "x"}');
  assert.equal(readArtifactsList(file, log), undefined);
  assert.match(lines.pop(), /must hold a JSON array/);

  fs.writeFileSync(file, `[${'"x",'.repeat(300_000)}"x"]`);
  assert.equal(readArtifactsList(file, log), undefined);
  assert.match(lines.pop(), /larger than 1024 KB/);
});
