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

test('reports hw-devices normalized: shorthand entries and legacy single-device fields spelled out, power control dropped', () => {
  const file = configFile({
    type: 'hw',
    'hw-devices': {
      stlinkSerial: 'ABC123', uart: 2, usbs: ['/dev/thub/dut1-usb', 3], relays: [{ channel: 0 }], power: { method: 'uhubctl', hub: '1-1', port: 2 }
    }
  });
  assert.deepEqual(readEditableConfig(file, 'hw'), {
    stlinks: [{ serial: 'ABC123' }],
    uarts: [{ index: 2 }],
    usbs: [{ path: '/dev/thub/dut1-usb' }, { index: 3 }]
  });
  assert.deepEqual([loadConfig(file).hw.relays, loadConfig(file).hw.power], [undefined, undefined]); // an older file still loads, without them
});

test('an older file\'s `hw` section still loads as hw-devices; its `sw` section is ignored', () => {
  const hw = configFile({ type: 'hw', hw: { uarts: [1] } }),
    sw = configFile({ type: 'sw', sw: { image: 'emu:1', registryAuth: { username: 'u', passwordFile: '/nope' } } });
  assert.equal(loadConfig(hw).hw.uarts[0].path, '/dev/thub/dut1-uart');
  assert.deepEqual(readEditableConfig(hw, 'hw').uarts, [{ index: 1 }]);
  assert.equal(loadConfig(sw).sw, undefined); // no passwordFile read, no error
  assert.deepEqual(readEditableConfig(sw, 'sw'), {});
  assert.equal(readShareableConfigFile(sw).sw, undefined);
});

test('applying an edit writes hw-devices, drops older hw / sw sections, keeps the rest; the result loads', () => {
  const file = configFile({ type: 'hw', labels: ['a'], hw: { uarts: [1] }, sw: { image: 'x' } });
  applyEditableConfig(file, 'hw', { uarts: [{ index: 2, baudRate: 9600 }] });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw['hw-devices'], { uarts: [{ index: 2, baudRate: 9600 }] });
  assert.deepEqual([raw.hw, raw.sw, raw.labels], [undefined, undefined, ['a']]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadConfig(file).hw.uarts[0].path, '/dev/thub/dut2-uart');

  assert.throws(() => applyEditableConfig(file, 'sw', { image: 'emu:2' }), /SW Client has no settings of its own/);
});

test('an invalid edit is refused and the file left as it was', () => {
  const file = configFile({ type: 'hw', 'hw-devices': { uarts: [1] } }),
    before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applyEditableConfig(file, 'hw', { uarts: [{ path: '/tmp/nope' }] }), /hw-devices\.uarts\.0\.path/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('import: the file\'s other fields written too; this Client keeps its URL, name, join key, id and paths', () => {
  const file = configFile({
    name: 'dut1', type: 'sw', clientId: 'c-1', labels: [], tokenFile: '/var/lib/thub/dut1.token',
    artifactory: { token: 'secret', tokenFile: '/etc/thub/a.token', allowedArtifactPrefixes: [] },
    sources: { allowedPrefixes: ['*'] },
    sw: { image: 'emu:1', registryAuth: { password: 'x' } }
  });
  // Legacy sections, unused now (artifactory and sw held secrets): not reported.
  assert.deepEqual(['artifactory', 'sources', 'sw'].map((k) => readShareableConfigFile(file)[k]), [undefined, undefined, undefined]);

  applyEditableConfig(file, 'sw', {}, {
    labels: ['board:b'], heartbeatIntervalSec: 5,
    sources: { allowedPrefixes: ['https://x/'] }, artifactory: { allowedArtifactPrefixes: ['https://art/'] },
    // Filtered out by the Coordinator already; ignored here again regardless.
    joinKey: 'other', coordinatorUrl: 'https://evil', name: 'dut9', clientId: 'c-9', tokenFile: '/tmp/x'
  });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(
    [raw.coordinatorUrl, raw.joinKey, raw.name, raw.clientId, raw.tokenFile],
    ['http://x', 'k', 'dut1', 'c-1', '/var/lib/thub/dut1.token']
  );
  assert.deepEqual([raw.labels, raw.heartbeatIntervalSec], [['board:b'], 5]);
  // Legacy sections aren't imported; artifactory/sources are left as they were, sw is dropped.
  assert.deepEqual(raw.sources, { allowedPrefixes: ['*'] });
  assert.deepEqual(raw.artifactory, { token: 'secret', tokenFile: '/etc/thub/a.token', allowedArtifactPrefixes: [] });
  assert.equal(raw.sw, undefined);

  assert.throws(() => applyEditableConfig(file, 'sw', {}, { labels: 'x' }), /labels must be array/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).labels, ['board:b']); // refused: nothing written
});

test('a dashboard revision that still carries power control is applied without it', () => {
  const file = configFile({ type: 'hw', 'hw-devices': { usbs: [] } });
  applyEditableConfig(file, 'hw', { usbs: [{ index: 1 }], relays: [], power: { method: 'uhubctl', hub: '1-1', port: 2 } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['hw-devices'], { usbs: [{ index: 1 }] });
});

test('a dashboard apply pins the running identity: the restart comes back with the same Coordinator, name, type and join key', () => {
  // The file says one name; the Client runs as another (started with --name).
  const file = configFile({ name: 'from-file', type: 'hw', 'hw-devices': { usbs: [] } }),
    running = loadConfig(file, { name: 'lab-hw-07' }),
    { Daemon } = require('../src/daemon'),
    identity = (env) => {
      const saved = process.env.THUB_CLIENT_JOIN_KEY;
      if (env === undefined){
        delete process.env.THUB_CLIENT_JOIN_KEY;
      }
      else {
        process.env.THUB_CLIENT_JOIN_KEY = env;
      }
      try {
        return Daemon.prototype._identity.call({ config: running });
      }
      finally {
        if (saved === undefined){
          delete process.env.THUB_CLIENT_JOIN_KEY;
        }
        else {
          process.env.THUB_CLIENT_JOIN_KEY = saved;
        }
      }
    };
  assert.deepEqual(identity(), { coordinatorUrl: 'http://x', name: 'lab-hw-07', type: 'hw', joinKey: 'k' });
  assert.equal(identity('from-env').joinKey, undefined); // stays in the environment

  // An import can't change them, and the apply writes the running ones.
  applyEditableConfig(file, 'hw', { usbs: [{ index: 1 }] }, { name: 'dut0', coordinatorUrl: 'https://evil', joinKey: 'x', labels: ['a'] }, identity());
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([raw.coordinatorUrl, raw.name, raw.type, raw.joinKey, raw.labels], ['http://x', 'lab-hw-07', 'hw', 'k', ['a']]);
  // A restart the way the systemd unit starts it (no --name) keeps that name.
  const restarted = loadConfig(file);
  assert.deepEqual([restarted.coordinatorUrl, restarted.name, restarted.type, restarted.joinKey], ['http://x', 'lab-hw-07', 'hw', 'k']);
});

test('the systemd unit starts the daemon with --config only — no --name overriding the file', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', 'systemd', 'thub-client@.service'), 'utf8'),
    installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-systemd-unit.js'), 'utf8');
  assert.match(unit, /^ExecStart=.*daemon\.js --config \S+\/%i\.json$/m);
  assert.doesNotMatch(unit, /^ExecStart=.*--name/m);
  assert.match(installer, /ExecStart=\$\{process\.execPath\} \$\{DAEMON_PATH\} --config \$\{paths\.configDir\}\/%i\.json/);
});
