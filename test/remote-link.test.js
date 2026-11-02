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
