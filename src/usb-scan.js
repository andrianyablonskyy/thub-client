/**
 * @file        packages/client/src/usb-scan.js
 * @description Runs `lsusb -tvv` for the Coordinator's scan-usb command (resource card "USB devices" tab)
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
  // The USB tree (-t) with each device's vendor/product names and its
  // /sys and /dev paths (-vv): which port, hub and driver every device sits on.
  ARGS = ['-tvv'];

// { output, error } — never throws. Only ever run on an admin's request.
function scanUsb({ command = 'lsusb' } = {}){
  return new Promise((resolve) => {
    execFile(command, ARGS, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = String(stdout || '').slice(0, MAX_OUTPUT);
      if (!err){
        return resolve({ output, error: null });
      }
      let error;
      if (err.code === 'ENOENT'){
        error = `${command} isn't installed on this host (on Ubuntu: sudo apt install usbutils)`;
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

module.exports = { scanUsb, LSUSB_ARGS: ARGS };
