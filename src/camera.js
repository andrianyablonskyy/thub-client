/**
 * @file        packages/client/src/camera.js
 * @description USB camera of a reserved board (README §5.7): finds the host's first USB camera, and while the runner
 *              is reserved streams it with ffmpeg as H.264 in MPEG-TS over UDP (loopback) for the remote link to relay
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
  dgram = require('node:dgram'),
  { spawn: spawnProcess } = require('node:child_process'),
  { backoffMs } = require('@andrian.yablonskyy/thub-common');

// The label a Client with a camera registers with, so a developer can find
// (and reserve) the runners whose board can be watched.
const CAMERA_LABEL = 'video-stream',
  SYS_DIR = '/sys/class/video4linux';

// The first USB camera on the host: the lowest /dev/videoN whose device
// sits on a USB bus and is a capture node (a UVC camera also has a metadata
// node, index 1). { path, name } or null.
function findUsbCamera({ sysDir = SYS_DIR, read = fs } = {}){
  let entries;
  try {
    entries = read.readdirSync(sysDir).filter((n) => /^video\d+$/.test(n));
  }
  catch {
    return null;
  }
  entries.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  for (const n of entries){
    const dir = path.join(sysDir, n),
      attr = (f) => {
        try {
          return read.readFileSync(path.join(dir, f), 'utf8').trim();
        }
        catch {
          return null;
        }
      };
    let device;
    try {
      device = read.realpathSync(path.join(dir, 'device'));
    }
    catch {
      continue;
    }
    if (!/\/usb\d*\//.test(device) || (attr('index') ?? '0') !== '0'){
      continue;
    }
    return { path: `/dev/${n}`, name: (attr('name') || n).slice(0, 64) };
  }
  return null;
}

// ffmpeg: the camera at its own default format, at most 1280 wide, H.264
// tuned for latency (a keyframe every second, so a new viewer starts at
// once), as MPEG-TS in UDP datagrams to `port` on loopback.
function ffmpegArgs(device, port){
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'v4l2', '-i', device,
    '-vf', 'scale=\'min(1280,iw)\':-2', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '2M', '-g', '30',
    '-an', '-f', 'mpegts', `udp://127.0.0.1:${port}?pkt_size=1316`
  ];
}

// The stream for one reservation: started with it, stopped with it, and
// started again (1 s, 2 s … 30 s apart) if ffmpeg stops — a camera
// unplugged and plugged back, say. `onData(datagram)`: every UDP packet;
// `onNote(text)`: what to tell the viewers; `onState({ streaming, error })`:
// whenever that changes (the Agent shows it at once). All of it is logged
// too, so the Client's journal says why a stream isn't there.
class CameraStream{
  constructor(camera, { onData, onNote = () => {}, onState = () => {}, spawn = spawnProcess, ffmpeg = 'ffmpeg', log = console }){
    Object.assign(this, { camera, onData, onNote, onState, spawn, ffmpeg, log });
    this.running = false;
    this.streaming = false; // packets are coming
    this.proc = null;
    this.sock = null;
    this.attempt = 0;
    this.timer = null;
    this.error = null; // why it isn't streaming, if it isn't
  }

  _setState(streaming, error){
    if (streaming === this.streaming && error === this.error){
      return;
    }
    this.streaming = streaming;
    this.error = error;
    this.onState({ streaming, error });
  }

  async start(){
    if (this.running){
      return;
    }
    this.running = true;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (buf) => {
      if (!this.streaming){
        this.log.log?.(`camera: streaming ${this.camera.path} (${this.camera.name})`);
        this.attempt = 0;
        this._setState(true, null);
      }
      this.onData(buf);
    });
    this.sock.on('error', (err) => this.log.error?.(`camera: ${err.message}`));
    await new Promise((resolve) => this.sock.bind(0, '127.0.0.1', resolve));
    this._run();
  }

  _run(){
    if (!this.running){
      return;
    }
    const port = this.sock.address().port,
      args = ffmpegArgs(this.camera.path, port),
      tail = [];
    let spawnError = null,
      proc;
    this.log.log?.(`camera: starting ${this.ffmpeg} ${args.join(' ')}`);
    try {
      proc = this.spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    catch (err){
      return this._failed(`ffmpeg: ${err.message}`);
    }
    this.proc = proc;
    proc.stderr?.on('data', (d) => {
      tail.push(...String(d).split('\n').filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 3));
    });
    proc.on('error', (err) => {
      spawnError = err.code === 'ENOENT'
        ? `${this.ffmpeg} isn't installed on this Client host (on Ubuntu: sudo apt install ffmpeg)`
        : `ffmpeg: ${err.message}`;
    });
    // 'close', not 'exit': a binary that isn't there gets only 'error' and 'close'.
    proc.on('close', (code) => {
      if (this.proc !== proc || !this.running){
        return;
      }
      this.proc = null;
      this._failed(spawnError || `ffmpeg stopped (${code}): ${tail.join(' | ') || 'no output'}`);
    });
  }

  _failed(error){
    this._setState(false, error);
    const retry = backoffMs(this.attempt++),
      text = `${error} — trying again in ${Math.round(retry / 1000)} s`;
    this.log.error?.(`camera: ${text}`);
    this.onNote(text);
    this.timer = setTimeout(() => this._run(), retry);
    this.timer.unref?.();
  }

  stop(){
    this.running = false;
    clearTimeout(this.timer);
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null){
      proc.kill('SIGTERM');
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref?.();
    }
    try {
      this.sock?.close();
    }
    catch {
      // already closed
    }
    this.sock = null;
  }
}

// The labels a Client registers with: its config's, plus video-stream when
// the host has a camera.
function registrationLabels(labels, camera){
  return camera ? [...new Set([...(labels || []), CAMERA_LABEL])] : labels;
}

module.exports = { CAMERA_LABEL, findUsbCamera, ffmpegArgs, registrationLabels, CameraStream };
