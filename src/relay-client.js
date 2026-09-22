/**
 * @file        packages/client/src/relay-client.js
 * @description REST client stub for the networked relay board used for DUT power cycling (README §8.6)
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

// STUB — DUT power via a relay board's REST API (README §8.2/§8.6,
// `hw.power.method: "relay"`). Endpoint shapes are placeholders; the
// request/response JSON will be finalized once the relay firmware's API
// is specified, at which point only this file should need to change.
class RelayClient {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  // GET /state — expected to return the state of all 8 channels.
  async getState() {
    const res = await fetch(`${this.baseUrl}/state`);
    if (!res.ok) throw new Error(`Relay state check failed: HTTP ${res.status}`);
    return res.json();
  }

  // POST /relay/set — turns one relay channel on or off.
  // STUB body shape: { relay: <0-7>, state: "on" | "off" }.
  async setRelay(relayIndex, on) {
    const res = await fetch(`${this.baseUrl}/relay/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relay: relayIndex, state: on ? 'on' : 'off' }),
    });
    if (!res.ok) throw new Error(`Relay set failed: HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }
}

module.exports = { RelayClient };
