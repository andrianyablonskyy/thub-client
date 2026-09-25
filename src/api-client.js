/**
 * @file        packages/client/src/api-client.js
 * @description Adds multipart artifact upload on top of the shared JSON API client
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
  path = require('node:path'),
  { ApiClient } = require('@andrian.yablonskyy/thub-common');

// Adds multipart artifact upload (§6.2 POST /jobs/:id/artifacts) on top of
// the shared JSON API client.
class ClientApiClient extends ApiClient{
  // Reports this Client's version to the Coordinator (resource card, §10).
  constructor(opts){
    super({ userAgent: `thub-client/${require('../package.json').version}`, ...opts });
  }

  async postArtifacts(jobId, filePaths){
    const form = new FormData();
    for (const filePath of filePaths){
      const blob = await fs.openAsBlob(filePath);
      form.append('files', blob, path.basename(filePath));
    }
    return this.post(`/jobs/${jobId}/artifacts`, form);
  }
}

module.exports = { ClientApiClient };
