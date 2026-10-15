/**
 * @file        packages/client/test/camera.test.js
 * @description Tests: the board's USB camera (README §5.7) — finding it, its label, and its ffmpeg stream
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  dgram = require('node:dgram'),
  { EventEmitter } = require('node:events'),
  { findUsbCamera, ffmpegArgs, registrationLabels, CameraStream, CAMERA_LABEL } = require('../src/camera'),
  { describeCapabilities } = require('../src/capabilities');

// A /sys/class/video4linux stand-in: `devices` maps videoN to the device
// directory its `device` link points at, its index and name.
function fakeSys(devices){
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-v4l-')),
    sys = path.join(root, 'class'),
    bus = path.join(root, 'devices');
  fs.mkdirSync(sys);
  for (const [n, { at, index, name }]of Object.entries(devices)){
    const dev = path.join(bus, at);
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(path.join(sys, n));
    fs.symlinkSync(dev, path.join(sys, n, 'device'));
    fs.writeFileSync(path.join(sys, n, 'index'), `${index}\n`);
    fs.writeFileSync(path.join(sys, n, 'name'), `${name}\n`);
  }
  return sys;
}

test('the first USB camera\'s capture node — not its metadata node, not a non-USB video device', () => {
  const sys = fakeSys({
    video0: { at: 'platform/bcm2835-codec', index: 0, name: 'bcm2835-codec-decode' },
    video11: { at: 'pci0000:00/usb3/3-2/3-2:1.0', index: 1, name: 'HD Pro Webcam C920' },
    video10: { at: 'pci0000:00/usb3/3-2/3-2:1.0', index: 0, name: 'HD Pro Webcam C920' },
    video12: { at: 'pci0000:00/usb3/3-4/3-4:1.0', index: 0, name: 'Second camera' }
  });
  assert.deepEqual(findUsbCamera({ sysDir: sys }), { path: '/dev/video10', name: 'HD Pro Webcam C920' });
  assert.equal(findUsbCamera({ sysDir: path.join(sys, 'nope') }), null);
  assert.equal(findUsbCamera({ sysDir: fakeSys({ video0: { at: 'platform/codec', index: 0, name: 'codec' } }) }), null);
});

test('a camera registers the video-stream label and shows in the capabilities', () => {
  const cam = { path: '/dev/video0', name: 'C920' };
  assert.deepEqual(registrationLabels(['board:f4'], cam), ['board:f4', CAMERA_LABEL]);
  assert.deepEqual(registrationLabels([CAMERA_LABEL], cam), [CAMERA_LABEL]);
  assert.deepEqual(registrationLabels(['board:f4'], null), ['board:f4']);
  const run = () => {
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  assert.deepEqual(describeCapabilities({ type: 'hw', hw: {} }, { run, camera: cam }).hw.camera, cam);
  assert.equal(describeCapabilities({ type: 'hw', hw: {} }, { run }).hw.camera, null);
});

test('ffmpeg: the camera as low-latency H.264 in MPEG-TS over loopback UDP', () => {
  const args = ffmpegArgs('/dev/video0', 40000);
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 4), ['-f', 'v4l2', '-i', '/dev/video0']);
  assert.ok(args.includes('zerolatency') && args.includes('libx264'));
  assert.equal(args.at(-1), 'udp://127.0.0.1:40000?pkt_size=1316');
});

test('the stream: every UDP packet reaches onData; a stopped ffmpeg is started again, and said so', async () => {
  const runs = [],
    got = [],
    notes = [],
    spawn = (cmd, args) => {
      const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), exitCode: null, kill(){
        proc.exitCode = 0;
      } });
      runs.push({ cmd, args, proc });
      // Like ffmpeg: packets to the UDP address it was given.
      const port = Number(/:(\d+)\?/.exec(args.at(-1))[1]),
        sock = dgram.createSocket('udp4');
      sock.send(Buffer.from(`ts-packet-${runs.length}`), port, '127.0.0.1', () => sock.close());
      return proc;
    },
    states = [],
    logged = [],
    stream = new CameraStream({ path: '/dev/video0', name: 'C920' }, {
      spawn, onData: (b) => got.push(String(b)), onNote: (t) => notes.push(t), onState: (s) => states.push(s),
      log: { log: (m) => logged.push(m), error: (m) => logged.push(m) }
    });
  await stream.start();
  for (let i = 0; i < 100 && !got.length; i++){
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(got, ['ts-packet-1']);
  assert.deepEqual(states, [{ streaming: true, error: null }]);

  runs[0].proc.stderr.emit('data', '/dev/video0: Device or resource busy\n');
  runs[0].proc.exitCode = 1;
  runs[0].proc.emit('close', 1);
  assert.match(notes[0], /ffmpeg stopped \(1\): \/dev\/video0: Device or resource busy — trying again in \d s/);
  assert.equal(states.at(-1).streaming, false);
  // The journal says so too: started, streaming, stopped.
  const journal = logged.join('\n');
  assert.match(journal, /camera: starting ffmpeg .*-i \/dev\/video0/);
  assert.match(journal, /camera: streaming \/dev\/video0 \(C920\)[\s\S]*camera: ffmpeg stopped \(1\)/);
  stream.stop();
  assert.equal(runs.length, 1); // stopped before its retry
});

test('no ffmpeg on the host: said at once — to the Agent, the viewers and the journal — and tried again later', async () => {
  const states = [],
    notes = [],
    logged = [],
    stream = new CameraStream({ path: '/dev/video0', name: 'C920' }, {
      ffmpeg: 'thub-test-no-such-ffmpeg', onData: () => {}, onNote: (t) => notes.push(t), onState: (s) => states.push(s),
      log: { log: () => {}, error: (m) => logged.push(m) }
    });
  await stream.start();
  for (let i = 0; i < 100 && !states.length; i++){
    await new Promise((r) => setTimeout(r, 10));
  }
  stream.stop();
  assert.deepEqual(states, [{ streaming: false, error: 'thub-test-no-such-ffmpeg isn\'t installed on this Client host (on Ubuntu: sudo apt install ffmpeg)' }]);
  assert.match(notes[0], /isn't installed on this Client host .* — trying again in \d s/);
  assert.match(logged[0], /^camera: thub-test-no-such-ffmpeg isn't installed/);
});
