/**
 * @file        packages/client/src/capabilities.js
 * @description What this Client can drive — an HW Client's udev devices (an SW Client has none of its own) —
 *              reported to the Coordinator at registration (README §5.1, §10)
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
  { execFileSync } = require('node:child_process');

// `present` says whether the device node exists right now (its udev
// symlink resolves), so a missing adapter shows up on the dashboard
// instead of only as a failed job.
function device(entry, extra = {}){
  return { path: entry.path || null, ...(entry.index ? { index: entry.index } : {}), ...extra, present: entry.path ? fs.existsSync(entry.path) : null };
}

function describeCapabilities(config, { run = execFileSync } = {}){
  return { ...describeTyped(config), docker: describeDocker(run) };
}

// Whether a job's command can use Docker here — the `docker` CLI on the
// service's PATH, talking to a daemon this user may reach — so a host
// without it shows on the dashboard instead of as `docker: not found` in a
// job. { available, version } or { available: false, reason }.
function describeDocker(run){
  try {
    const version = String(run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })).trim();
    return { available: true, version: version || null };
  }
  catch (err){
    const stderr = String(err.stderr || ''),
      reason = err.code === 'ENOENT'
        ? `docker isn't installed, or not on the service's PATH (${process.env.PATH || 'unset'})`
        : /permission denied/i.test(stderr)
          ? 'no access to the Docker daemon — the service user needs the docker group (reinstall the Client after installing Docker, so its unit gets it)'
          : /Cannot connect to the Docker daemon|Is the docker daemon running/i.test(stderr)
            ? 'the Docker daemon isn\'t running'
            : (stderr.trim().split('\n').pop() || err.message).slice(0, 300);
    return { available: false, reason };
  }
}

function describeTyped(config){
  // An SW Client has no settings: a job's command brings whatever it runs.
  if (config.type === 'sw'){
    return { sw: {} };
  }
  const hw = config.hw || {};
  return {
    hw: {
      stlinks: (hw.stlinks || []).map((s) => device(s, s.serial ? { serial: s.serial } : {})),
      uarts: (hw.uarts || []).map((u) => device(u, u.baudRate ? { baudRate: u.baudRate } : {})),
      usbs: (hw.usbs || []).map((u) => device(u))
    }
  };
}

module.exports = { describeCapabilities };
