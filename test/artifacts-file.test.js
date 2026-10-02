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

test('THUB_WORK_DIR is the job directory; the artifacts list and the Docker config live there, beside the clone', () => {
  const env = jobEnv({ id: 'M-00001', spec: { target: { type: 'sw' } } }, { workDir: '/var/lib/thub/work/dut0/M-00001', downloads: [] }, {}, 'lab');
  assert.equal(env.THUB_WORK_DIR, '/var/lib/thub/work/dut0/M-00001');
  assert.equal(env.THUB_ARTIFACTS_FILE, '/var/lib/thub/work/dut0/M-00001/artifacts.json');
  assert.equal(env.DOCKER_CONFIG, '/var/lib/thub/work/dut0/M-00001/.docker');
  // A job's own --env DOCKER_CONFIG wins.
  const own = jobEnv({ id: 'M-2', spec: { target: { type: 'sw' }, env: { DOCKER_CONFIG: '/x' } } }, { workDir: '/w/M-2', downloads: [] }, {}, 'lab');
  assert.equal(own.DOCKER_CONFIG, '/x');
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

test('JUnit XML is read from results/ or artifacts/ in the work dir or a folder there (src/ after a clone) — not downloads or .docker', () => {
  const { junitFiles, summarizeJUnit } = require('../src/runner'),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-junit-')),
    write = (rel, tests, failures) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), `<testsuite tests="${tests}" failures="${failures}" errors="0" skipped="0"></testsuite>`);
    };
  write('src/results/junit.xml', 5, 1);
  write('results/top.xml', 2, 0);
  write('downloads/results/x.xml', 99, 99);
  write('.docker/results/x.xml', 99, 99);
  assert.deepEqual(junitFiles(dir).map((f) => path.relative(dir, f)).sort(), ['results/top.xml', 'src/results/junit.xml']);
  assert.equal(summarizeJUnit(junitFiles(dir)).total, 7);
  assert.equal(summarizeJUnit(junitFiles(dir)).failed, 1);
});
