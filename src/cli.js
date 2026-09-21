#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { loadConfig } = require('./config');
const { sendCommand } = require('./control-socket');

// §8.4: "sudo thub-client lock --reason ... / sudo thub-client unlock"
const program = new Command();
program.name('thub-client').description('Control the local thub-client daemon');

function socketPath() {
  return loadConfig().socketPath;
}

program
  .command('lock')
  .description('Take the bench for manual work (-> BUSY, source=local)')
  .requiredOption('--reason <reason>')
  .action(async (opts) => {
    const res = await sendCommand(socketPath(), { cmd: 'lock', reason: opts.reason });
    console.log(res.ok ? 'Locked.' : `Error: ${res.error}`);
    process.exit(res.ok ? 0 : 1);
  });

program
  .command('unlock')
  .description('Release the bench (-> IDLE)')
  .action(async () => {
    const res = await sendCommand(socketPath(), { cmd: 'unlock' });
    console.log(res.ok ? 'Unlocked.' : `Error: ${res.error}`);
    process.exit(res.ok ? 0 : 1);
  });

program
  .command('status')
  .description('Show the daemon\'s current state')
  .action(async () => {
    const res = await sendCommand(socketPath(), { cmd: 'status' });
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  });

program.parseAsync(process.argv);
