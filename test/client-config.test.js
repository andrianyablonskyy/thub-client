/**
 * @file        packages/client/test/client-config.test.js
 * @description Tests: the Client's editable config — what it reports, and applying a dashboard edit to its file
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
  { readEditableConfig, readShareableConfigFile, applyEditableConfig, loadConfig } = require('../src/config');

function configFile(content){
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thub-cc-')), 'dut1.json');
  fs.writeFileSync(file, JSON.stringify({ coordinatorUrl: 'http://x', joinKey: 'k', ...content }), { mode: 0o600 });
  return file;
}

test('reports the hw section normalized: shorthand entries and legacy single-device fields spelled out, power control dropped', () => {
  const file = configFile({
    type: 'hw',
    hw: { stlinkSerial: 'ABC123', uart: 2, usbs: ['/dev/thub/dut1-usb', 3], relays: [{ channel: 0 }], power: { method: 'uhubctl', hub: '1-1', port: 2 } }
  });
  assert.deepEqual(readEditableConfig(file, 'hw'), {
    stlinks: [{ serial: 'ABC123' }],
    uarts: [{ index: 2 }],
    usbs: [{ path: '/dev/thub/dut1-usb' }, { index: 3 }]
  });
  assert.deepEqual([loadConfig(file).hw.relays, loadConfig(file).hw.power], [undefined, undefined]); // an older file still loads, without them
});

test('reports the sw section without its secrets', () => {
  const file = configFile({ type: 'sw', sw: { image: 'emu:1', registry: 'reg.lab', registryAuth: { username: 'u', passwordFile: '/etc/p' } } });
  assert.deepEqual(readEditableConfig(file, 'sw'), { image: 'emu:1', registry: 'reg.lab' });
});

test('applying an edit keeps private fields and the rest of the file; the result loads', () => {
  const file = configFile({ type: 'sw', labels: ['a'], sw: { image: 'emu:1', registryAuth: { username: 'u', password: 'secret' } } });
  applyEditableConfig(file, 'sw', { image: 'emu:2', cpus: 1, memory: '1g', cmd: ['--x'] });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.sw, { image: 'emu:2', cpus: 1, memory: '1g', cmd: ['--x'], registryAuth: { username: 'u', password: 'secret' } });
  assert.deepEqual(raw.labels, ['a']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadConfig(file).sw.image, 'emu:2');
});

test('an invalid edit is refused and the file left as it was', () => {
  const file = configFile({ type: 'hw', hw: { uarts: [1] } }),
    before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applyEditableConfig(file, 'hw', { uarts: [{ path: '/tmp/nope' }] }), /hw\.uarts\.0\.path/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('import: the file\'s other fields written too; this Client keeps its URL, name, join key, id, paths and secrets', () => {
  const file = configFile({
    name: 'dut1', type: 'sw', clientId: 'c-1', labels: [], tokenFile: '/var/lib/thub/dut1.token',
    artifactory: { token: 'secret', tokenFile: '/etc/thub/a.token', allowedArtifactPrefixes: [] },
    sw: { image: 'emu:1', registryAuth: { password: 'x' } }
  });
  assert.deepEqual(readShareableConfigFile(file).artifactory, { tokenFile: '/etc/thub/a.token', allowedArtifactPrefixes: [] });
  assert.equal(readShareableConfigFile(file).sw.registryAuth, undefined);

  applyEditableConfig(file, 'sw', { image: 'emu:2' }, {
    labels: ['board:b'], heartbeatIntervalSec: 5, sources: { allowedPrefixes: ['*'] },
    artifactory: { allowedArtifactPrefixes: ['https://art/'] },
    // Filtered out by the Coordinator already; ignored here again regardless.
    joinKey: 'other', coordinatorUrl: 'https://evil', name: 'dut9', clientId: 'c-9', tokenFile: '/tmp/x'
  });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    [raw.coordinatorUrl, raw.joinKey, raw.name, raw.clientId, raw.tokenFile],
    ['http://x', 'k', 'dut1', 'c-1', '/var/lib/thub/dut1.token']
  );
  assert.deepEqual([raw.labels, raw.heartbeatIntervalSec, raw.sources], [['board:b'], 5, { allowedPrefixes: ['*'] }]);
  assert.deepEqual(raw.artifactory, { allowedArtifactPrefixes: ['https://art/'], token: 'secret', tokenFile: '/etc/thub/a.token' });
  assert.deepEqual(raw.sw, { image: 'emu:2', registryAuth: { password: 'x' } });

  assert.throws(() => applyEditableConfig(file, 'sw', { image: 'emu:3' }, { labels: 'x' }), /labels must be array/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sw.image, 'emu:2'); // refused: nothing written
});

test('a dashboard revision that still carries power control is applied without it', () => {
  const file = configFile({ type: 'hw', hw: { usbs: [] } });
  applyEditableConfig(file, 'hw', { usbs: [{ index: 1 }], relays: [], power: { method: 'uhubctl', hub: '1-1', port: 2 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hw, { usbs: [{ index: 1 }] });
});
