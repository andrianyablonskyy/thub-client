/**
 * @file        packages/client/src/downloader.js
 * @description Fetches a job's firmware and test sources (archive or git repository), under the Client's download
 *              policy: the Artifactory token only goes to allowedArtifactPrefixes (README §8.1, §12)
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
  crypto = require('node:crypto'),
  { execFile } = require('node:child_process');

// Git transports allowed for test sources — never ext:: (runs a command)
// or file:// (reads this host). Matches the job spec's own check.
const GIT_ALLOW_PROTOCOL = 'http:https:ssh:git',

  matches = (url, prefixes) => (prefixes || []).some((p) => p === '*' || url.startsWith(p));

// §8.1 step 3 / §12 — where may this Client fetch from, and with which
// credentials? Returns { token } (token may be null), or throws.
//   - under artifactory.allowedArtifactPrefixes: allowed, with the Client's
//     read-only Artifactory token;
//   - under sources.allowedPrefixes ("*" = anywhere): allowed, never with
//     the token — e.g. an internal git server, http://localhost/...;
//   - neither list configured at all: allowed, with the token (the original
//     behavior, before either list existed).
function downloadAccess(url, cfg){
  const artifactory = cfg.artifactory || {},
    artifactoryPrefixes = artifactory.allowedArtifactPrefixes || [],
    sourcePrefixes = cfg.sources?.allowedPrefixes || [];
  if (matches(url, artifactoryPrefixes) || (!artifactoryPrefixes.length && !sourcePrefixes.length)){
    return { token: artifactory.token || null };
  }
  if (matches(url, sourcePrefixes)){
    return { token: null };
  }
  throw new Error(
    `${url} isn't an allowed download source for this Client — add its prefix to "sources": { "allowedPrefixes": [...] } ` +
      '(no Artifactory token is sent there; "*" allows any) or, for Artifactory, to artifactory.allowedArtifactPrefixes'
  );
}

// `signal` lets a job cancel abort a download in progress (runner.js).
async function fetchToFile(url, destPath, { token, signal } = {}){
  const headers = token ? { Authorization: `Bearer ${token}` } : {},
    res = await fetch(url, { headers, signal });
  if (!res.ok){
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

function sha256File(filePath){
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function run(cmd, args, { signal, env, cwd } = {}){
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { signal, env: env || process.env, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err){
        if (err.code === 'ENOENT'){
          return reject(new Error(`${cmd} is not installed on this Client`));
        }
        return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      }
      resolve(stdout.trim());
    });
  });
}

// `cfg`: the Client config (artifactory + sources).
async function downloadFirmware(spec, jobDir, cfg, { signal } = {}){
  const { token } = downloadAccess(spec.firmware.url, cfg),
    dest = path.join(jobDir, 'fw', path.basename(new URL(spec.firmware.url).pathname) || 'app.bin');
  await fetchToFile(spec.firmware.url, dest, { token, signal });
  if (spec.firmware.sha256){
    const actual = sha256File(dest);
    if (actual !== spec.firmware.sha256){
      throw new Error(`Firmware sha256 mismatch: expected ${spec.firmware.sha256}, got ${actual}`);
    }
  }
  return dest;
}

// Unpacks by content, not by the URL's extension: zip by its magic bytes,
// anything else via tar, which detects gzip/bzip2/xz compression itself.
async function extractArchive(archive, destDir, { signal } = {}){
  fs.mkdirSync(destDir, { recursive: true });
  const head = Buffer.alloc(4),
    fd = fs.openSync(archive, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  try {
    if (head.toString('latin1') === 'PK\x03\x04'){
      await run('unzip', ['-q', '-o', archive, '-d', destDir], { signal });
    }
    else {
      await run('tar', ['-xf', archive, '-C', destDir], { signal });
    }
  }
  catch (err){
    throw new Error(`Extracting test package failed: ${err.message}`);
  }
}

// Fetches exactly the requested revision, shallowly where the server
// allows it. Refs are validated by the job spec (never an option-like
// "-..."), the transport is restricted, and git never prompts.
async function fetchGitSources(git, destDir, cfg, { signal, log = () => {} } = {}){
  downloadAccess(git.url, cfg);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL },
    g = (...args) => run('git', ['-C', destDir, ...args], { signal, env }),
    [refLabel, fetchRef] = git.branch
      ? [`branch ${git.branch}`, `refs/heads/${git.branch}`]
      : git.tag ? [`tag ${git.tag}`, `refs/tags/${git.tag}`] : git.commit ? [`commit ${git.commit}`, git.commit] : ['default branch', 'HEAD'];

  fs.mkdirSync(destDir, { recursive: true });
  await g('init', '-q');
  await g('remote', 'add', 'origin', git.url);
  log(`fetching ${git.url} (${refLabel})`);
  try {
    await g('fetch', '-q', '--depth', '1', 'origin', fetchRef);
    await g('checkout', '-q', '--detach', 'FETCH_HEAD');
  }
  catch (err){
    // Not every server does shallow fetches (e.g. git's plain "dumb" HTTP),
    // and a short or unadvertised commit can't be fetched by name: fall
    // back to a full fetch — of the ref, or of everything for a commit.
    log(`shallow fetch not possible (${err.message}) — fetching the full history`);
    try {
      if (git.commit){
        await g('fetch', '-q', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
        await g('checkout', '-q', '--detach', git.commit);
      }
      else {
        await g('fetch', '-q', 'origin', fetchRef);
        await g('checkout', '-q', '--detach', 'FETCH_HEAD');
      }
    }
    catch (e){
      throw new Error(`git: can't get ${refLabel} from ${git.url}: ${e.message}`);
    }
  }
  const commit = await g('rev-parse', 'HEAD');
  log(`test sources at commit ${commit}`);
  return commit;
}

// Test sources into <jobDir>/tests: an archive (tests.url) or a git
// repository (tests.git). Returns { testsDir, commit } (commit: git only).
async function fetchTests(spec, jobDir, cfg, { signal, log = () => {} } = {}){
  const testsDir = path.join(jobDir, 'tests');
  if (spec.tests.git){
    return { testsDir, commit: await fetchGitSources(spec.tests.git, testsDir, cfg, { signal, log }) };
  }
  const { token } = downloadAccess(spec.tests.url, cfg),
    archive = path.join(jobDir, 'tests.archive');
  log(`downloading tests ${spec.tests.url}`);
  await fetchToFile(spec.tests.url, archive, { token, signal });
  await extractArchive(archive, testsDir, { signal });
  return { testsDir, commit: null };
}

module.exports = { downloadFirmware, fetchTests, fetchGitSources, extractArchive, downloadAccess };
