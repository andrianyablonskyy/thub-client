/**
 * @file        packages/client/src/api-client.js
 * @description The shared JSON API client, identifying itself as this Client (thub-client/<version>)
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

const { ApiClient } = require('@andrian.yablonskyy/thub-common');

// The shared JSON API client. Nothing is uploaded besides logs and the
// result: a job's files stay in its workspace on this Client (README §8.1).
class ClientApiClient extends ApiClient{
  // Reports this Client's version to the Coordinator (resource card, §10).
  constructor(opts){
    super({ userAgent: `thub-client/${require('../package.json').version}`, ...opts });
  }
}

module.exports = { ClientApiClient };
