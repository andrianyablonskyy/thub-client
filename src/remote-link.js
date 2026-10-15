/**
 * @file        packages/client/src/remote-link.js
 * @description Remote board access (README §5.6): while the runner is reserved, a WebSocket to the Coordinator that
 *              serves the developer's channels — a UART through the UartHub, or SWD through an OpenOCD GDB server
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

const net = require('node:net'),
  path = require('node:path'),
  { spawn: spawnProcess, execFile } = require('node:child_process'),
  { CameraStream } = require('./camera'),
  { decodeData, dataMessages, parseControl, agentControl, remoteUrl, backoffMs, OPENOCD_TARGET_RE, REMOTE_CLOSE
  } = require('@andrian.yablonskyy/thub-common');

// The Coordinator pings every 30 s; without one for this long the link is
// taken for dead (a proxy or NAT dropped it silently) and reconnected.
const PING_TIMEOUT_MS = 75_000,
  // OpenOCD: how long it may take to open the probe and listen for GDB, and
  // to exit once its GDB connection is gone.
  OPENOCD_READY_MS = 15_000,
  OPENOCD_KILL_MS = 3_000,
  // A channel's sends waiting in the WebSocket: past this, its TCP side is
  // paused until they're out (a GDB download mustn't fill memory).
  HIGH_WATER = 1024 * 1024,
  // Video is dropped, not queued, past this much waiting in the WebSocket:
  // a slow viewer must never hold up the UARTs and GDB on the same link.
  VIDEO_DROP = 2 * 1024 * 1024;

// The probe's USB serial number from its udev device (ID_SERIAL_SHORT) —
// what tells OpenOCD which ST-Link to open when the host has several.
function udevSerial(devPath, { run = execFile } = {}){
  return new Promise((resolve) => {
    run('udevadm', ['info', '--query=property', `--name=${devPath}`], { timeout: 5000 }, (err, stdout) => {
      const m = !err && /^ID_SERIAL_SHORT=([A-Za-z0-9]{1,64})$/m.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
}

// The OpenOCD command line for one GDB connection: the ST-Link (by serial),
// the board's target script, GDB on a loopback port, nothing else open.
function openocdArgs({ serial, target, port }){
  return [
    '-f', 'interface/stlink.cfg',
    ...(serial ? ['-c', `adapter serial ${serial}`] : []),
    '-f', `target/${target}.cfg`,
    '-c', 'bindto 127.0.0.1',
    '-c', `gdb_port ${port}`,
    '-c', 'telnet_port disabled',
    '-c', 'tcl_port disabled'
  ];
}

function freePort(){
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

class RemoteLink{
  // `auth()`: { baseUrl, token, resourceId } now (the token changes when
  // the Client registers again). `hw`: the Client's hw-devices config.
  // `camera`: the host's USB camera (camera.js findUsbCamera), or null —
  // streamed for as long as the runner is reserved (README §5.7).
  constructor({
    auth, hw, uartHub, userAgent, log = console, WebSocket = require('ws'), spawn = spawnProcess, openocd = 'openocd', serialOf = udevSerial,
    camera = null, cameraStream = (cam, opts) => new CameraStream(cam, opts)
  }){
    Object.assign(this, { auth, hw: hw || {}, uartHub, userAgent, log, WebSocket, spawn, openocd, serialOf, camera, cameraStream });
    this.video = null; // the reservation's CameraStream
    this.viewers = new Set(); // its video channels
    this.enabled = false;
    this.session = null; // the reservation's id: its link's path
    this.ws = null;
    this.attempt = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.channels = new Map();
  }

  // From each heartbeat reply: the reservation's id while the runner is
  // reserved (its link is on that reservation's own path), else null. A
  // new reservation means a new link: the old one's channels close.
  setSession(id){
    id = id || null;
    if (id === this.session){
      return;
    }
    this.stop();
    if (id){
      this.session = id;
      this.enabled = true;
      this.attempt = 0;
      this._connect();
      this._startVideo();
    }
  }

  stop(){
    this.enabled = false;
    this.session = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pingTimer);
    this._closeAll('the reservation ended');
    this.video?.stop();
    this.video = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'not reserved');
  }

  // What the developer can open: every UART, and every ST-Link with the
  // target its OpenOCD needs (theirs at connect time, else the config's).
  devices(){
    const name = (p, fallback) => (p ? path.basename(p) : fallback);
    return {
      uarts: (this.hw.uarts || []).map((u, i) => ({
        index: i + 1, label: u.label || name(u.path, `uart${i + 1}`), baudRate: u.baudRate || 115200
      })),
      probes: (this.hw.stlinks || []).map((s, i) => ({
        index: i + 1, label: name(s.path, `stlink${i + 1}`), serial: s.serial || null, target: s.openocdTarget || null
      })),
      serial: this.uartHub?.available ?? false,
      camera: this.camera ? { name: this.camera.name, codec: 'h264', container: 'mpegts' } : null
    };
  }

  // The camera starts streaming with the reservation, whether anyone
  // watches yet or not; each viewer's channel gets every packet from then on.
  _startVideo(){
    if (!this.camera){
      return;
    }
    const stream = this.cameraStream(this.camera, {
      log: this.log,
      onData: (buf) => {
        if (this.ws && this.ws.bufferedAmount < VIDEO_DROP){
          for (const ch of this.viewers){
            this._sendData(ch, buf);
          }
        }
      },
      onNote: (text) => this.viewers.forEach((ch) => this._note(ch, text))
    });
    this.video = stream;
    stream.start().catch((err) => this.log.error?.(`camera: ${err.message}`));
  }

  async _openVideo({ ch }){
    if (!this.camera || !this.video){
      throw new Error('this Client host has no USB camera');
    }
    this.viewers.add(ch);
    this.channels.set(ch, { write: () => {}, close: () => this.viewers.delete(ch) });
    this._send({ t: 'opened', ch, kind: 'video', name: this.camera.name });
    if (this.video.error){
      this._note(ch, this.video.error);
    }
  }

  _connect(){
    if (!this.enabled){
      return;
    }
    const { baseUrl, token, resourceId } = this.auth(),
      ws = new this.WebSocket(remoteUrl(baseUrl, `/resources/${resourceId}/remote-link/${this.session}`), {
        headers: { Authorization: `Bearer ${token}`, ...(this.userAgent ? { 'User-Agent': this.userAgent } : {}) },
        handshakeTimeout: 15_000
      });
    this.ws = ws;
    const alive = () => {
      clearTimeout(this.pingTimer);
      this.pingTimer = setTimeout(() => ws.terminate(), PING_TIMEOUT_MS);
      this.pingTimer.unref?.();
    };
    ws.on('open', () => {
      this.attempt = 0;
      alive();
      this.log.log?.('remote access: connected to the Coordinator');
      this._send({ t: 'devices', ...this.devices() });
    });
    ws.on('ping', alive);
    ws.on('message', (data, isBinary) => (isBinary ? this._onData(data) : this._onControl(parseControl(data))));
    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode,
        proxy = status === 426 || (status >= 300 && status < 400);
      this.log.error?.(`remote access: the Coordinator refused the link (HTTP ${status})` +
        (proxy ? ' — a reverse proxy in front of it isn\'t passing WebSocket upgrades on to it' : ''));
      ws.terminate();
    });
    ws.on('error', (err) => this.log.error?.(`remote access: ${err.message}`));
    ws.on('close', (code) => {
      clearTimeout(this.pingTimer);
      if (this.ws !== ws){
        return;
      }
      this.ws = null;
      // The reservation ended: everything stops now (the camera too), not
      // at the next heartbeat — and there's nothing to reconnect to.
      if (code === REMOTE_CLOSE.RESERVATION_ENDED){
        return this.stop();
      }
      this._closeAll('the link to the Coordinator dropped');
      if (this.enabled){
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this._connect(), backoffMs(this.attempt++));
        this.retryTimer.unref?.();
      }
    });
  }

  _send(msg){
    if (this.ws?.readyState === this.WebSocket.OPEN){
      this.ws.send(JSON.stringify(msg));
    }
  }

  _sendData(ch, data, done){
    const ws = this.ws;
    if (ws?.readyState !== this.WebSocket.OPEN){
      return;
    }
    const msgs = [...dataMessages(ch, data)];
    msgs.forEach((msg, i) => ws.send(msg, { binary: true }, i === msgs.length - 1 ? done : undefined));
  }

  _onControl(raw){
    if (raw?.t === 'reset'){
      return this._closeAll('the developer disconnected', { tell: false });
    }
    const msg = agentControl(raw);
    if (!msg){
      return;
    }
    if (msg.t === 'close'){
      return this._closeChannel(msg.ch, null, { tell: false });
    }
    this._closeChannel(msg.ch, null, { tell: false }); // a reused id: the old one is gone
    const open = { uart: () => this._openUart(msg), swd: () => this._openSwd(msg), video: () => this._openVideo(msg) }[msg.kind];
    open().catch((err) => this._closeChannel(msg.ch, err.message));
  }

  _onData(buf){
    const frame = decodeData(buf),
      channel = frame && this.channels.get(frame.ch);
    channel?.write(frame.data);
  }

  _closeChannel(ch, reason, { tell = true } = {}){
    const channel = this.channels.get(ch);
    if (channel){
      this.channels.delete(ch);
      channel.close();
    }
    if (tell){
      this._send({ t: 'close', ch, ...(reason ? { reason } : {}) });
    }
  }

  _closeAll(reason, { tell = true } = {}){
    for (const ch of [...this.channels.keys()]){
      this._closeChannel(ch, reason, { tell });
    }
  }

  _note(ch, text){
    this._send({ t: 'note', ch, text });
  }

  // A UART: shared with a job capturing it, reopened when the board resets.
  async _openUart({ ch, index }){
    const uart = (this.hw.uarts || [])[index - 1];
    if (!uart){
      throw new Error(`this Client has no UART ${index}`);
    }
    if (!this.uartHub?.available){
      throw new Error('the \'serialport\' package isn\'t installed on this Client host');
    }
    let waiting = false;
    const sub = this.uartHub.subscribe(uart, (event, arg) => {
      if (event === 'data'){
        this._sendData(ch, arg);
      }
      else if (event === 'opened' && waiting){
        waiting = false;
        this._note(ch, `${uart.path} is back`);
      }
      else if ((event === 'closed' || event === 'open-failed') && !waiting){
        waiting = true;
        this._note(ch, `${uart.path} ${event === 'closed' ? 'disconnected' : 'isn\'t there'} — waiting for it`);
      }
      else if (event === 'error'){
        this._note(ch, `${uart.path}: ${arg.message}`);
      }
    });
    this.channels.set(ch, { write: (data) => sub.write(data), close: () => sub.close() });
    this._send({ t: 'opened', ch, kind: 'uart', baudRate: uart.baudRate || 115200 });
  }

  // SWD: an OpenOCD of its own for this GDB connection, gone with it — so a
  // job can flash the probe while no debugger is attached.
  async _openSwd({ ch, index, target }){
    const probe = (this.hw.stlinks || [])[index - 1];
    if (!probe){
      throw new Error(`this Client has no ST-Link ${index}`);
    }
    const script = target || probe.openocdTarget;
    if (!script || !OPENOCD_TARGET_RE.test(script)){
      throw new Error(`no OpenOCD target for ST-Link ${index}: thub connect --target <name> (e.g. stm32f4x), ` +
        'or set openocdTarget on the probe in the Client\'s config');
    }
    let closed = false,
      sock = null,
      pending = 0;
    const serial = probe.serial || (probe.path ? await this.serialOf(probe.path) : null),
      port = await freePort(),
      args = openocdArgs({ serial, target: script, port }),
      proc = this.spawn(this.openocd, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
      tail = [],
      keep = (buf) => {
        tail.push(...String(buf).split('\n').filter(Boolean));
        tail.splice(0, Math.max(0, tail.length - 5));
      },
      stopProc = () => {
        if (proc.exitCode === null && !proc.killed){
          proc.kill('SIGTERM');
          setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), OPENOCD_KILL_MS).unref?.();
        }
      },
      channel = {
        write: (data) => sock?.write(data),
        close: () => {
          closed = true;
          sock?.destroy();
          stopProc();
        }
      };
    this.channels.set(ch, channel);
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    proc.on('error', (err) => {
      if (!closed){
        this._closeChannel(ch, err.code === 'ENOENT'
          ? 'OpenOCD isn\'t installed on this Client host (on Ubuntu: sudo apt install openocd)'
          : `OpenOCD: ${err.message}`);
      }
    });
    proc.on('exit', (code) => {
      if (!closed && this.channels.get(ch) === channel){
        this._closeChannel(ch, `OpenOCD exited (${code}): ${tail.join(' | ') || 'no output'}`);
      }
    });
    this._note(ch, `starting OpenOCD: target/${script}.cfg on ST-Link ${serial || probe.path || index}`);

    // Wait for its GDB port, then pipe it.
    for (const start = Date.now(); !closed && proc.exitCode === null; await new Promise((r) => setTimeout(r, 200))){
      try {
        sock = await new Promise((resolve, reject) => {
          const s = net.connect(port, '127.0.0.1', () => resolve(s));
          s.once('error', reject);
        });
        break;
      }
      catch {
        if (Date.now() - start > OPENOCD_READY_MS){
          throw new Error(`OpenOCD didn't open its GDB port in ${OPENOCD_READY_MS / 1000} s: ${tail.join(' | ') || 'no output'}`);
        }
      }
    }
    if (!sock){
      return;
    }
    if (closed){
      return sock.destroy();
    }
    sock.on('data', (data) => {
      pending += data.length;
      if (pending > HIGH_WATER){
        sock.pause();
      }
      this._sendData(ch, data, () => {
        pending -= data.length;
        if (pending <= HIGH_WATER / 2){
          sock.resume();
        }
      });
    });
    sock.on('error', () => {});
    sock.on('close', () => !closed && this.channels.get(ch) === channel && this._closeChannel(ch, 'OpenOCD closed the GDB connection'));
    this._send({ t: 'opened', ch, kind: 'swd', target: script, serial });
  }
}

module.exports = { RemoteLink, openocdArgs, udevSerial };
