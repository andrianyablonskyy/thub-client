/**
 * @file        packages/client/src/docker-login.js
 * @description A job's Docker registry login (`--env DOCKER_REGISTRY=…,DOCKER_USERNAME=…,DOCKER_PASSWORD=…`), into
 *              a Docker config dir of the job's own, so its credentials never outlive it on the Client host
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
  { execFile } = require('node:child_process'),
  { DOCKER_LOGIN_ENV } = require('@andrian.yablonskyy/thub-common');

// Run as-is by `sh`, with the job's env: the password goes over stdin, never
// on a command line (ps) or in the log.
const LOGIN_SCRIPT = 'echo "$DOCKER_PASSWORD" | docker login "$DOCKER_REGISTRY" --username "$DOCKER_USERNAME" --password-stdin';

// { registry, username, password } when the job's env asks for a login
// (all three DOCKER_* set), else null.
function dockerLoginFor(env){
  if (!env || !DOCKER_LOGIN_ENV.every((n) => env[n])){
    return null;
  }
  return { registry: env.DOCKER_REGISTRY, username: env.DOCKER_USERNAME, password: env.DOCKER_PASSWORD };
}

// "https://registry.lab:5000/" -> "registry.lab:5000": how the host part of
// an image reference names a registry.
function registryHost(registry){
  return String(registry || '').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

// Logs in with LOGIN_SCRIPT, writing the credentials to `configDir` (its
// DOCKER_CONFIG) — the job's own directory, removed with the job.
function dockerLogin(env, configDir, { signal } = {}){
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', LOGIN_SCRIPT], { signal, env: { ...process.env, ...env, DOCKER_CONFIG: configDir } }, (err, stdout, stderr) => {
      if (err){
        const why = err.code === 127 || /docker: .*not found/.test(stderr)
          ? 'docker is not installed on this Client'
          : (stderr || err.message).trim().split('\n').slice(-2).join(' ');
        return reject(new Error(`docker login ${env.DOCKER_REGISTRY} as ${env.DOCKER_USERNAME} failed: ${why}`));
      }
      resolve();
    });
  });
}

module.exports = { dockerLoginFor, dockerLogin, registryHost, LOGIN_SCRIPT };
