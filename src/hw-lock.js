/**
 * @file        packages/client/src/hw-lock.js
 * @description One HW Client per machine: a machine-wide lock an HW daemon holds while it runs, and who holds it
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

const fs = require('node:fs'),
  net = require('node:net'),
  os = require('node:os'),
  path = require('node:path');

const NAME = 'thub-client-hw',
  ASK_TIMEOUT_MS = 1000,
  // The exit code of an HW daemon that finds another one running: the
  // systemd unit's RestartPreventExitStatus, so it doesn't restart-loop.
  EXIT_HW_LOCKED = 78;

// The lock is a listening socket. On Linux an abstract one: no file to
// write (the service runs with ProtectSystem=strict) and none left behind
// by a crash — it goes with the process. Elsewhere a socket file in the
// temp directory.
function lockAddress(){
  return process.platform === 'linux' ? `\0${NAME}` : path.join(os.tmpdir(), `${NAME}.sock`);
}

// The instance holding the lock (what it answers on connect), or null when
// no HW Client runs here.
function hwLockHolder({ address = lockAddress() } = {}){
  return new Promise((resolve) => {
    let answer = '';
    const socket = net.connect(address),
      done = (holder) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(holder);
      },
      timer = setTimeout(() => done(answer.trim() || '(unknown instance)'), ASK_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      answer += chunk;
    });
    socket.on('end', () => done(answer.trim() || '(unknown instance)'));
    socket.on('error', () => done(null));
  });
}

function listen(address, instance){
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end(`${instance}\n`));
    server.once('error', reject);
    server.listen(address, () => {
      server.unref(); // the lock never keeps the process alive
      resolve(server);
    });
  });
}

// Takes the lock for `instance`; resolves to { release() }. Rejects with
// code EHWLOCKED (and `holder`) when another HW Client holds it.
async function acquireHwLock(instance, { address = lockAddress() } = {}){
  let server;
  try {
    server = await listen(address, instance);
  }
  catch (err){
    if (err.code !== 'EADDRINUSE'){
      throw err;
    }
    const holder = await hwLockHolder({ address });
    // A socket file nobody answers on is a crashed holder's (not Linux).
    if (holder === null && !address.startsWith('\0')){
      fs.rmSync(address, { force: true });
      return acquireHwLock(instance, { address });
    }
    throw Object.assign(new Error(
      `another HW Client already runs on this machine (instance "${holder}"); only one may. ` +
        'Stop it first, or run this one as an SW Client.'
    ), { code: 'EHWLOCKED', holder });
  }
  return {
    release(){
      server.close();
      if (!address.startsWith('\0')){
        fs.rmSync(address, { force: true });
      }
    }
  };
}

module.exports = { acquireHwLock, hwLockHolder, lockAddress, EXIT_HW_LOCKED };
