/**
 * @file        packages/client/src/downloader.js
 * @description Prepares a task's inputs — its downloaded files (README §8.1)
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
  path = require('node:path');

// The server's certificate chain doesn't end at a CA this process trusts —
// usually a lab or company CA: Node.js doesn't read the system's CA store.
const UNTRUSTED_CA = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ]),
  UNTRUSTED_CA_HINT = ' — the server\'s certificate isn\'t from a CA this Client trusts: give the Client the CA with NODE_EXTRA_CA_CERTS (README §7.5)';

// A plain GET: nothing is ever sent along with a download. A source that
// needs credentials is fetched by the job's command, with a token from --env.
// `signal` lets a job cancel abort a download in progress (runner.js).
async function fetchToFile(url, destPath, { signal } = {}){
  let res;
  try {
    res = await fetch(url, { signal });
  }
  catch (err){
    if (signal?.aborted){
      throw err;
    }
    // fetch() itself only says "fetch failed": the reason is its cause.
    const cause = err.cause,
      why = cause ? `${cause.message || cause}${cause.code ? ` (${cause.code})` : ''}` : err.message;
    throw new Error(`Download failed for ${url}: ${why}${UNTRUSTED_CA.has(cause?.code) ? UNTRUSTED_CA_HINT : ''}`);
  }
  if (!res.ok){
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
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
async function downloadFiles(downloads, destDir, { signal, log = () => {} } = {}){
  const urls = (downloads || []).map((d) => d.url),
    names = downloadNames(urls),
    paths = [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const [i, url]of urls.entries()){
    const dest = path.join(destDir, names[i]);
    log(`downloading ${url} -> ${path.join(path.basename(destDir), names[i])}`);
    await fetchToFile(url, dest, { signal });
    paths.push(dest);
  }
  return paths;
}

// Where a task's inputs go: the job directory, `<client workDir>/<jobId>`,
// is the work directory ($THUB_WORK_DIR) the command runs in, deleted when
// the job ends; the downloads go to its `downloads/`. The command clones
// into a folder of its own there (`src/`, say), the Docker config is kept in
// `.docker/` (runner.js), the artifacts list in `artifacts.json`.
function taskDirs(jobDir){
  return { workDir: jobDir, downloadsDir: path.join(jobDir, 'downloads') };
}

// A task's inputs, before its command runs. Returns { workDir, downloadsDir,
// downloads }.
async function prepareTask(spec, jobDir, { signal, log } = {}){
  const { workDir, downloadsDir } = taskDirs(jobDir);
  fs.mkdirSync(workDir, { recursive: true });
  const downloads = await downloadFiles(spec.downloads, downloadsDir, { signal, log });
  return { workDir, downloadsDir, downloads };
}

// What prepareTask would do, without doing it (a dry run): the task it would
// return plus `steps` — the downloads.
function planTask(spec, jobDir){
  const { workDir, downloadsDir } = taskDirs(jobDir),
    steps = [],
    urls = (spec.downloads || []).map((d) => d.url),
    downloads = downloadNames(urls).map((name) => path.join(downloadsDir, name));
  for (const [i, url]of urls.entries()){
    steps.push(`GET ${url} -> ${downloads[i]}`);
  }
  return { task: { workDir, downloadsDir, downloads }, steps };
}

// A command line to show, quoted the way a POSIX shell would read it back.
function shellQuote(arg){
  const s = String(arg);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, '\'\\\'\'')}'`;
}

function shellJoin(args){
  return args.map(shellQuote).join(' ');
}

module.exports = { prepareTask, planTask, downloadFiles, downloadNames, shellQuote, shellJoin };
