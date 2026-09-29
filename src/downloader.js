/**
 * @file        packages/client/src/downloader.js
 * @description Prepares a task's inputs — its downloaded files and git checkout (README §8.1)
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
const GIT_ALLOW_PROTOCOL = 'http:https:ssh:git';

// A plain GET: nothing is ever sent along with a download. A source that
// needs credentials is fetched by the job's command, with a token from --env.
// `signal` lets a job cancel abort a download in progress (runner.js).
async function fetchToFile(url, destPath, { signal } = {}){
  const res = await fetch(url, { signal });
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

const looksLikeCommit = (ref) => /^[0-9a-fA-F]{7,40}$/.test(ref || '');

// --git-repo <url> [ref] --depth <n>: clone into `destDir` at `ref` (branch,
// tag or commit; default: the default branch), `depth` commits deep (0:
// full history). Where the server can't do that (no shallow support, a
// short or unadvertised commit), falls back to a full fetch. Refs are
// validated by the job spec (never an option-like "-..."), the transport is
// restricted, and git never prompts.
// `env`: the job's own (`--env`), under git's safety settings.
async function cloneRepo(git, destDir, { signal, log = () => {}, env: jobEnv = {} } = {}){
  const env = { ...process.env, ...jobEnv, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL },
    steps = gitSteps(git, destDir),
    g = (args) => run('git', args, { signal, env });

  fs.mkdirSync(destDir, { recursive: true });
  for (const args of steps.setup){
    await g(args);
  }
  log(`cloning ${git.url} (${steps.label}${steps.depth ? `, depth ${steps.depth}` : ', full history'})`);
  try {
    for (const args of steps.fetch){
      await g(args);
    }
  }
  catch (err){
    log(`fetching ${steps.label} that way failed (${err.message}) — fetching the full history`);
    try {
      for (const args of steps.fallback){
        await g(args);
      }
    }
    catch (e){
      throw new Error(`git: can't get ${steps.label} from ${git.url}: ${e.message}`);
    }
  }
  const commit = await g(steps.revParse);
  log(`checked out commit ${commit}`);
  return commit;
}

// The git argument lists cloneRepo runs, in order: `setup`, then `fetch`
// (shallow, at the ref), or `fallback` (full history) if that fails, then
// `revParse`. --git-options go between `git` and the rest, on every call;
// cloneRepo never logs them (they may reference credentials) — only a dry
// run shows them.
function gitSteps(git, destDir){
  const extra = git.options ? splitArgs(git.options) : [],
    g = (...args) => [...extra, '-C', destDir, ...args],
    ref = git.ref || null,
    fetchRef = ref || 'HEAD',
    depth = Number.isInteger(git.depth) ? git.depth : 1;
  return {
    label: ref ? `ref ${ref}` : 'default branch',
    depth,
    setup: [g('init', '-q'), g('remote', 'add', 'origin', git.url)],
    fetch: [
      g('fetch', '-q', ...(depth ? ['--depth', String(depth)] : []), 'origin', fetchRef),
      g('checkout', '-q', '--detach', 'FETCH_HEAD')
    ],
    fallback: looksLikeCommit(ref)
      ? [g('fetch', '-q', '--tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'), g('checkout', '-q', '--detach', ref)]
      : [g('fetch', '-q', 'origin', fetchRef), g('checkout', '-q', '--detach', 'FETCH_HEAD')],
    revParse: g('rev-parse', 'HEAD')
  };
}

// Where a task's inputs go under its job directory: `<jobDir>/work` — the
// git checkout, or an empty directory — is where the command runs; the
// downloads go to `<jobDir>/downloads`, apart from the checkout so they
// can't clobber its files.
function taskDirs(jobDir){
  return { workDir: path.join(jobDir, 'work'), downloadsDir: path.join(jobDir, 'downloads') };
}

// A task's inputs, before its command runs. Returns { workDir, downloadsDir,
// downloads, commit }.
async function prepareTask(spec, jobDir, { signal, log } = {}){
  const { workDir, downloadsDir } = taskDirs(jobDir),
    commit = spec.git ? await cloneRepo(spec.git, workDir, { signal, log, env: spec.env }) : null;
  fs.mkdirSync(workDir, { recursive: true });
  const downloads = await downloadFiles(spec.downloads, downloadsDir, { signal, log });
  return { workDir, downloadsDir, downloads, commit };
}

// What prepareTask would do, without doing it (a dry run): the task it would
// return (commit unknown) plus `steps` — the full git commands and the
// downloads.
function planTask(spec, jobDir){
  const { workDir, downloadsDir } = taskDirs(jobDir),
    steps = [];
  if (spec.git){
    const git = gitSteps(spec.git, workDir),
      cmd = (args) => shellJoin(['git', ...args]);
    steps.push(
      'env GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=' + GIT_ALLOW_PROTOCOL + ' for every git command:',
      ...[...git.setup, ...git.fetch].map(cmd),
      `if that fetch fails: ${git.fallback.map(cmd).join(' && ')}`,
      cmd(git.revParse)
    );
  }
  const urls = (spec.downloads || []).map((d) => d.url),
    downloads = downloadNames(urls).map((name) => path.join(downloadsDir, name));
  for (const [i, url]of urls.entries()){
    steps.push(`GET ${url} -> ${downloads[i]}`);
  }
  return { task: { workDir, downloadsDir, downloads, commit: null }, steps };
}

// A command line to show, quoted the way a POSIX shell would read it back.
function shellQuote(arg){
  const s = String(arg);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, '\'\\\'\'')}'`;
}

function shellJoin(args){
  return args.map(shellQuote).join(' ');
}

module.exports = { prepareTask, planTask, downloadFiles, cloneRepo, gitSteps, downloadNames, shellQuote, shellJoin };
