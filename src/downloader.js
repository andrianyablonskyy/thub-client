'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// §8.1 step 3 / §12: download firmware and test package using the
// Client's own read-only Artifactory token, restricted to
// allowedArtifactPrefixes, and verify sha256 before flashing anything.
function assertAllowedUrl(url, allowedPrefixes) {
  if (!allowedPrefixes || allowedPrefixes.length === 0) return;
  if (!allowedPrefixes.some((p) => url.startsWith(p))) {
    throw new Error(`URL ${url} is not under an allowed Artifactory prefix`);
  }
}

async function fetchToFile(url, destPath, { token } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function downloadFirmware(spec, jobDir, artifactoryCfg) {
  assertAllowedUrl(spec.firmware.url, artifactoryCfg.allowedArtifactPrefixes);
  const dest = path.join(jobDir, 'fw', path.basename(new URL(spec.firmware.url).pathname) || 'app.bin');
  await fetchToFile(spec.firmware.url, dest, { token: artifactoryCfg.token });
  if (spec.firmware.sha256) {
    const actual = sha256File(dest);
    if (actual !== spec.firmware.sha256) {
      throw new Error(`Firmware sha256 mismatch: expected ${spec.firmware.sha256}, got ${actual}`);
    }
  }
  return dest;
}

async function downloadAndExtractTests(spec, jobDir, artifactoryCfg) {
  assertAllowedUrl(spec.tests.url, artifactoryCfg.allowedArtifactPrefixes);
  const archive = path.join(jobDir, 'tests.tar.gz');
  await fetchToFile(spec.tests.url, archive, { token: artifactoryCfg.token });
  const testsDir = path.join(jobDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', testsDir], (err, stdout, stderr) => {
      if (err) return reject(new Error(`Extracting test package failed: ${stderr || err.message}`));
      resolve();
    });
  });
  return testsDir;
}

module.exports = { downloadFirmware, downloadAndExtractTests, assertAllowedUrl };
