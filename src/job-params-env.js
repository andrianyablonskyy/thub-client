/**
 * @file        packages/client/src/job-params-env.js
 * @description The job's `thub run` parameters as JOB_<NAME> environment variables for its command (README §8.1,
 *              "Client environment variables") — e.g. --git-repo <url> <ref> --depth n as JOB_GIT_REPO_URL,
 *              JOB_GIT_BRANCH, JOB_GIT_DEPTH
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

// `--meta ciJobId=1` -> CI_JOB_ID: camelCase split, anything else to `_`.
function envKey(key){
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

// A repeatable parameter: <NAME> with every value (joined by `sep`), plus
// <NAME>_1, <NAME>_2, … one per value, in the order given.
function repeated(name, values, sep){
  return values.length
    ? { [name]: values.join(sep), ...Object.fromEntries(values.map((v, i) => [`${name}_${i + 1}`, v])) }
    : {};
}

// Every parameter the job was submitted with that reaches the Client, as
// JOB_<NAME>. A parameter that wasn't given leaves its variable unset (so
// `${JOB_GIT_BRANCH:-main}` works). `clientName`: this Client's own name —
// what a job pinned with --client ran on. Values are strings, as given;
// --env variables are already in the environment under their own names.
function jobParamsEnv(spec, { clientName } = {}){
  const target = spec.target || {},
    labels = target.labels || [],
    git = spec.git,
    set = (name, value) => (value === undefined || value === null || value === '' ? {} : { [name]: String(value) });
  return {
    ...set('JOB_TYPE', target.type),
    ...repeated('JOB_LABEL', labels, ','),
    ...set('JOB_GROUP', target.group),
    ...set('JOB_CLIENT', target.client ? clientName || target.client : undefined),
    ...set('JOB_USER', spec.user),
    ...set('JOB_COMMAND', spec.command),
    ...repeated('JOB_DOWNLOAD_FILE', (spec.downloads || []).map((d) => d.url), '\n'),
    ...set('JOB_DOCKER_IMAGE', spec.image),
    ...(git
      ? {
        ...set('JOB_GIT_REPO_URL', git.url),
        ...set('JOB_GIT_BRANCH', git.ref),
        ...set('JOB_GIT_DEPTH', Number.isInteger(git.depth) ? git.depth : 1),
        ...set('JOB_GIT_OPTIONS', git.options)
      }
      : {}),
    ...set('JOB_SUITE', spec.suite || 'default'),
    ...repeated('JOB_ARG', spec.args || [], ' '),
    ...set('JOB_TIMEOUT', spec.timeoutSec),
    ...set('JOB_PRIORITY', spec.priority),
    ...Object.fromEntries(Object.entries(spec.meta || {})
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => [`JOB_META_${envKey(k)}`, String(v)]))
  };
}

module.exports = { jobParamsEnv, envKey };
