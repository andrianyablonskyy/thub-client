/**
 * @file        packages/client/src/control-socket.js
 * @description Unix domain socket server/client used by thub-client to control the running daemon
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
  net = require('node:net');

// §8.4: "The command talks to the daemon over its Unix socket."
function createControlSocketServer(socketPath, handlers){
  fs.mkdirSync(require('node:path').dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });

  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1){
        return;
      }
      const line = buf.slice(0, nl);
      try {
        const { cmd, ...args } = JSON.parse(line),
          handler = handlers[cmd];
        if (!handler){
          throw new Error(`Unknown command ${cmd}`);
        }
        const result = await handler(args);
        socket.end(JSON.stringify({ ok: true, ...result }) + '\n');
      }
      catch (err){
        socket.end(JSON.stringify({ ok: false, error: err.message }) + '\n');
      }
    });
  });

  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
  return server;
}

function sendCommand(socketPath, payload){
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';
    socket.on('connect', () => socket.end(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => (buf += chunk));
    socket.on('close', () => {
      try {
        resolve(JSON.parse(buf));
      }
      catch {
        reject(new Error('Malformed response from thub-client daemon'));
      }
    });
    socket.on('error', reject);
  });
}

module.exports = { createControlSocketServer, sendCommand };
