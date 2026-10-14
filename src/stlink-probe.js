/**
 * @file        packages/client/src/stlink-probe.js
 * @description Runs `st-info --probe` for the Coordinator's probe-stlink command (resource card "ST-Link probes" tab)
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

const { execFile } = require('node:child_process');

const TIMEOUT_MS = 15_000,
  MAX_OUTPUT = 64 * 1024,
  ARGS = ['--probe'];

// { output, error } — never throws. Only ever run on an admin's request.
// stderr goes into the output too: st-info reports a probe it can't open
// ("access error": no udev rule giving the service's user the device) there,
// and still exits 0.
function probeStlinks({ command = 'st-info' } = {}){
  return new Promise((resolve) => {
    execFile(command, ARGS, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [String(stderr || '').trim(), String(stdout || '').trim()].filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
      if (!err){
        return resolve({ output, error: null });
      }
      let error;
      if (err.code === 'ENOENT'){
        error = `${command} isn't installed on this host (on Ubuntu: sudo apt install stlink-tools)`;
      }
      else if (err.killed){
        error = `${command} ${ARGS.join(' ')} didn't finish within ${TIMEOUT_MS / 1000} s`;
      }
      else {
        error = `${command} ${ARGS.join(' ')} failed: ${String(stderr || err.message).trim().slice(0, 500)}`;
      }
      resolve({ output, error });
    });
  });
}

module.exports = { probeStlinks };
