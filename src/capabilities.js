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

const fs = require('node:fs');

// `present` says whether the device node exists right now (its udev
// symlink resolves), so a missing adapter shows up on the dashboard
// instead of only as a failed job.
function device(entry, extra = {}){
  return { path: entry.path || null, ...(entry.index ? { index: entry.index } : {}), ...extra, present: entry.path ? fs.existsSync(entry.path) : null };
}

function describeCapabilities(config){
  return describeTyped(config);
}

function describeTyped(config){
  // An SW Client has no settings: it runs whatever DUT image a job brings.
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
