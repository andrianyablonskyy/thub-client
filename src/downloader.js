/**
 * @file        packages/client/src/downloader.js
 * @description Prepares a task's inputs — its downloaded files and git checkout — under the Client's download
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
  { execFile } = require('node:child_process'),
  { splitArgs } = require('@andrian.yablonskyy/thub-common');

// Git transports allowed for a task's repository — never ext:: (runs a command)
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

// A safe, unique file name for each download, from its URL's last path
// segment (app.bin), numbered when several share a name (2-app.bin).
function downloadNames(urls){
  const seen = new Map();
  return urls.map((url, i) => {
    let base;
    try {
      base = decodeURIComponent(path.basename(new URL(url).pathname));
    }
    catch {
      base = '';
    }
    base = base.replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '') || `download-${i + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${n}-${base}`;
  });
}

// --download-file: each URL into `destDir`, before the command runs.
// Returns the absolute paths, in the job's order.
async function downloadFiles(downloads, destDir, cfg, { signal, log = () => {} } = {}){
  const urls = (downloads || []).map((d) => d.url),
    names = downloadNames(urls),
    paths = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const [i, url]of urls.entries()){
    const { token } = downloadAccess(url, cfg),
      dest = path.join(destDir, names[i]);
    log(`downloading ${url} -> ${path.join(path.basename(destDir), names[i])}`);
    await fetchToFile(url, dest, { token, signal });
    paths.push(dest);
  }
  return paths;
}

const looksLikeCommit = (ref) => /^[0-9a-fA-F]{7,40}$/.test(ref || '');

// --git-repo <url> [ref] --depth <n>: clone into `destDir` at `ref` (branch,
// tag or commit; default: the default branch), `depth` commits deep (0:
// full history). Where the server can't do that (no shallow support, a
// short or unadvertised commit), falls back to a full fetch. Refs are
// validated by the job spec (never an option-like "-..."), the transport is
// restricted, and git never prompts.
async function cloneRepo(git, destDir, cfg, { signal, log = () => {} } = {}){
  downloadAccess(git.url, cfg);
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL },
    // --git-options: between `git` and the rest, on every call. Never logged
    // (they may reference credentials).
    extra = git.options ? splitArgs(git.options) : [],
    g = (...args) => run('git', [...extra, '-C', destDir, ...args], { signal, env }),
    ref = git.ref || null,
    fetchRef = ref || 'HEAD',
    depth = Number.isInteger(git.depth) ? git.depth : 1,
    label = ref ? `ref ${ref}` : 'default branch';

  fs.mkdirSync(destDir, { recursive: true });
  await g('init', '-q');
  await g('remote', 'add', 'origin', git.url);
  log(`cloning ${git.url} (${label}${depth ? `, depth ${depth}` : ', full history'})`);
  try {
    await g('fetch', '-q', ...(depth ? ['--depth', String(depth)] : []), 'origin', fetchRef);
    await g('checkout', '-q', '--detach', 'FETCH_HEAD');
  }
  catch (err){
    log(`fetching ${label} that way failed (${err.message}) — fetching the full history`);
    try {
      if (looksLikeCommit(ref)){
        await g('fetch', '-q', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
        await g('checkout', '-q', '--detach', ref);
      }
      else {
        await g('fetch', '-q', 'origin', fetchRef);
        await g('checkout', '-q', '--detach', 'FETCH_HEAD');
      }
    }
    catch (e){
      throw new Error(`git: can't get ${label} from ${git.url}: ${e.message}`);
    }
  }
  const commit = await g('rev-parse', 'HEAD');
  log(`checked out commit ${commit}`);
  return commit;
}

// A task's inputs, before its command runs: `<jobDir>/work` — the git
// checkout, or an empty directory — is where the command runs; the
// downloads go to `<jobDir>/downloads`, apart from the checkout so they
// can't clobber its files. Returns { workDir, downloadsDir, downloads, commit }.
async function prepareTask(spec, jobDir, cfg, { signal, log } = {}){
  const workDir = path.join(jobDir, 'work'),
    downloadsDir = path.join(jobDir, 'downloads'),
    commit = spec.git ? await cloneRepo(spec.git, workDir, cfg, { signal, log }) : null;
  fs.mkdirSync(workDir, { recursive: true });
  const downloads = await downloadFiles(spec.downloads, downloadsDir, cfg, { signal, log });
  return { workDir, downloadsDir, downloads, commit };
}

module.exports = { prepareTask, downloadFiles, cloneRepo, downloadNames, downloadAccess };
