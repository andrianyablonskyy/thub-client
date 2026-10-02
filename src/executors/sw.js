/**
 * @file        packages/client/src/executors/sw.js
 * @description SW executor: nothing to prepare — an SW job is just its command (README §8.3)
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

// §8.3 SW executor. The Client no longer pulls or runs a DUT image (no
// Docker needed): an SW job is its --command, which starts whatever it
// needs itself — `docker run …`, an emulator — with credentials from --env.
// Kept as an executor so the runner treats HW and SW alike.
class SwExecutor{
  constructor(config, logShipper){
    this.logShipper = logShipper;
  }

  async prepare(){}

  // A dry run's view: nothing before or after the command.
  plan(){
    return { steps: [], teardown: [], env: {} };
  }

  envFor(){
    return {};
  }

  async teardown(){}
}

module.exports = { SwExecutor };
