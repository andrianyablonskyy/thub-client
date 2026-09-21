'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ApiClient } = require('@thub/shared');

// Adds multipart artifact upload (§6.2 POST /jobs/:id/artifacts) on top of
// the shared JSON API client.
class ClientApiClient extends ApiClient {
  async postArtifacts(jobId, filePaths) {
    const form = new FormData();
    for (const filePath of filePaths) {
      const blob = await fs.openAsBlob(filePath);
      form.append('files', blob, path.basename(filePath));
    }
    return this.post(`/jobs/${jobId}/artifacts`, form);
  }
}

module.exports = { ClientApiClient };
