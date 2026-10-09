/**
 * @file        packages/client/test/register-retry.test.js
 * @description Tests: registration the Coordinator's license has no room for (402) is tried again every minute,
 *              in the process; any other refusal still ends the start
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
  { Daemon } = require('../src/daemon');

const refused = (status, message) => Object.assign(new Error(message), { status }),
  self = () => ({ stopped: false, shutdown: new AbortController() }),
  // The join-key API client: answers each POST with the next of `answers`
  // (an Error is thrown), the last one again once they run out.
  coordinator = (...answers) => ({
    post: async () => {
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (answer instanceof Error){
        throw answer;
      }
      return answer;
    }
  });

test('402 (no room in the license): waits a minute and tries again, until it\'s in', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = t.mock.method(console, 'error', () => {}),
    anon = coordinator(refused(402, 'The license allows 2 runners, and 2 are registered.'), { resourceId: 'res_1', resourceToken: 't' }),
    pending = Daemon.prototype._register.call(self(), anon, {});

  await new Promise(setImmediate);
  assert.match(log.mock.calls[0].arguments[0], /Not registered: The license allows 2 runners.* Trying again in 60 s\./);
  t.mock.timers.tick(60 * 1000);
  assert.deepEqual(await pending, { resourceId: 'res_1', resourceToken: 't' });
});

test('any other refusal, or a stop while waiting: the start ends as before', async (t) => {
  t.mock.method(console, 'error', () => {});
  await assert.rejects(Daemon.prototype._register.call(self(), coordinator(refused(409, 'name taken')), {}), /name taken/);

  const daemon = self(),
    pending = Daemon.prototype._register.call(daemon, coordinator(refused(402, 'no room')), {});
  await new Promise(setImmediate);
  daemon.stopped = true;
  daemon.shutdown.abort();
  await assert.rejects(pending, /no room/);
});
