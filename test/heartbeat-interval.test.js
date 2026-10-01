/**
 * @file        packages/client/test/heartbeat-interval.test.js
 * @description Tests: the Client follows the heartbeat interval the Coordinator sends (registration and every heartbeat reply)
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
  os = require('node:os'),
  path = require('node:path'),
  { Daemon } = require('../src/daemon');

test('adopts the Coordinator\'s heartbeat interval and reschedules; ignores missing or bad values', (t) => {
  const log = t.mock.method(console, 'log', () => {}),
    daemon = new Daemon({ heartbeatIntervalSec: 10, configRevisionFile: path.join(os.tmpdir(), 'thub-no-such-revision.json') }),
    ticks = [];
  daemon.heartbeatTick = () => ticks.push(Date.now());
  daemon.heartbeatTimer = setInterval(daemon.heartbeatTick, 10_000);
  t.after(() => clearInterval(daemon.heartbeatTimer));
  const before = daemon.heartbeatTimer;

  assert.equal(daemon._heartbeatMs(), 10_000); // its own value, until told otherwise
  daemon._adoptHeartbeatInterval(undefined); // an older Coordinator sends none
  daemon._adoptHeartbeatInterval('abc');
  daemon._adoptHeartbeatInterval(0);
  daemon._adoptHeartbeatInterval(10); // unchanged: no reschedule
  assert.equal(daemon.heartbeatTimer, before);
  assert.equal(log.mock.callCount(), 0);

  daemon._adoptHeartbeatInterval(3);
  assert.equal(daemon._heartbeatMs(), 3_000);
  assert.notEqual(daemon.heartbeatTimer, before); // the timer runs at the new pace
  assert.match(log.mock.calls[0].arguments[0], /Heartbeat interval: 3s \(from the Coordinator\)/);
});
