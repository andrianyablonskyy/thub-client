'use strict';

const test = require('node:test'),
  assert = require('node:assert/strict'),
  { EventEmitter } = require('node:events'),
  net = require('node:net'),
  { encodeData } = require('@andrian.yablonskyy/thub-common'),
  { RemoteLink } = require('../src/remote-link');

class FakeWebSocket extends EventEmitter{
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent = [];

  send(data, options, callback){
    this.sent.push(data);
    this.emit('sent', data);
    callback?.();
  }
}

test('a named service channel connects only to Client loopback and relays TCP data', async (t) => {
  const server = net.createServer((socket) => socket.on('data', (data) => socket.write(data))),
    port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    ws = new FakeWebSocket(),
    link = new RemoteLink({ auth: () => ({}), hw: {}, uartHub: null, WebSocket: FakeWebSocket });
  link.ws = ws;
  t.after(() => {
    link._closeAll('test done');
    server.close();
  });

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service did not open')), 1000);
    ws.on('sent', (message) => {
      if (typeof message === 'string' && JSON.parse(message).t === 'opened'){
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await link._openService({ ch: 5, name: 'Web UI', port });
  await opened;

  const framePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('service did not relay data')), 1000);
    ws.on('sent', (message) => {
      if (Buffer.isBuffer(message)){
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  link._onData(encodeData(5, Buffer.from('hello')));
  const frame = await framePromise;
  assert.equal(frame.readUInt16BE(0), 5);
  assert.equal(frame.subarray(2).toString(), 'hello');
});

test('OpenOCD RTT args configure the memory range and selected up-channel', () => {
  const { openocdRttArgs } = require('../src/remote-link');
  assert.deepEqual(openocdRttArgs({
    serial: 'probe-1', target: 'stm32f4x', port: 4321, address: '0x20000000', size: '0x10000', channel: 2
  }), [
    '-f', 'interface/stlink.cfg',
    '-c', 'adapter serial probe-1',
    '-f', 'target/stm32f4x.cfg',
    '-c', 'bindto 127.0.0.1',
    '-c', 'gdb_port disabled',
    '-c', 'telnet_port disabled',
    '-c', 'tcl_port disabled',
    '-c', 'rtt setup 0x20000000 0x10000',
    '-c', 'rtt start',
    '-c', 'rtt server start 4321 2'
  ]);
});

test('RTT captures OpenOCD bytes and excludes concurrent GDB use of the same ST-Link', async (t) => {
  const { EventEmitter } = require('node:events'),
    { PassThrough } = require('node:stream'),
    servers = [],
    spawn = (command, args) => {
      const proc = new EventEmitter(),
        stdout = new PassThrough(),
        stderr = new PassThrough(),
        rttCommand = args.find((arg) => arg.startsWith('rtt server start ')),
        port = Number(rttCommand.split(' ')[3]),
        server = net.createServer((socket) => socket.write(Buffer.from('RTT: ✓\n')));
      server.listen(port, '127.0.0.1');
      servers.push(server);
      Object.assign(proc, {
        stdout, stderr, exitCode: null, killed: false,
        kill(){
          this.killed = true;
          this.exitCode = 0;
          server.close();
          this.emit('exit', 0);
        }
      });
      return proc;
    },
    ws = new FakeWebSocket(),
    link = new RemoteLink({
      auth: () => ({}), hw: { stlinks: [{ serial: 'probe-1', openocdTarget: 'stm32f4x' }] },
      uartHub: null, WebSocket: FakeWebSocket, spawn
    });
  link.ws = ws;
  t.after(() => {
    link._closeAll('test done');
    servers.forEach((server) => server.close());
  });

  await link._openRtt({ ch: 5, index: 1, address: '0x20000000', size: '0x10000', channel: 0 });
  const output = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RTT output was not relayed')), 1000);
    ws.on('sent', (message) => {
      if (Buffer.isBuffer(message)){
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  assert.equal(output.readUInt16BE(0), 5);
  assert.equal(output.subarray(2).toString(), 'RTT: ✓\n');
  await assert.rejects(link._openSwd({ ch: 6, index: 1 }), /already in use by RTT/);
});
