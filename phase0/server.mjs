import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(here, 'index.html'));
const token = process.env.SESSION_TOKEN ?? '';
const origin = process.env.ALLOWED_ORIGIN ?? '';
const udid = process.env.SIMULATOR_UDID ?? '';
const deviceName = process.env.SIMULATOR_NAME ?? 'iPhone Simulator';
const idleMs = Number(process.env.IDLE_TIMEOUT_MS ?? 300_000);
const maxSessionMs = Number(process.env.MAX_SESSION_MS ?? 900_000);
const fallbackPath = path.join(os.tmpdir(), `ui-ios-preview-${process.pid}.jpg`);
const fallbackPngPath = path.join(os.tmpdir(), `ui-ios-preview-${process.pid}.png`);
const evidenceDir = process.env.EVIDENCE_DIR ?? path.join(here, 'runner-evidence');

if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('SESSION_TOKEN must be 32 random bytes in hex.');
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(origin)) throw new Error('ALLOWED_ORIGIN must be the Quick Tunnel HTTPS origin.');
if (!/^[A-F0-9-]{36}$/i.test(udid)) throw new Error('SIMULATOR_UDID is missing or invalid.');
await mkdir(evidenceDir, {recursive: true});

function findScreenSize(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.screen_dimensions) {
    const width = Number(value.screen_dimensions.width_points ?? value.screen_dimensions.width);
    const height = Number(value.screen_dimensions.height_points ?? value.screen_dimensions.height);
    if (width > 0 && height > 0) return {width, height};
  }
  if (value.screen && Number.isFinite(value.screen.width) && Number.isFinite(value.screen.height)) {
    return {width: value.screen.width, height: value.screen.height};
  }
  for (const child of Object.values(value)) {
    const found = findScreenSize(child);
    if (found) return found;
  }
  return null;
}

const described = spawnSync('idb', ['describe', '--udid', udid, '--json'], {
  encoding: 'utf8',
  timeout: 20_000,
  maxBuffer: 8 * 1024 * 1024,
});
let logicalSize;
if (described.status === 0) {
  try {
    logicalSize = findScreenSize(JSON.parse(described.stdout));
  } catch {
    logicalSize = null;
  }
}
if (!logicalSize) {
  throw new Error(`Could not read simulator point dimensions from idb describe (exit ${described.status ?? 'unknown'}).`);
}

const clients = new Set();
let activeViewer = null;
let provider = 'idb-video-stream-mjpeg';
let frameCount = 0;
let frameWindowStart = Date.now();
let lastActivity = Date.now();
let lastFrameAt = 0;
let latestFrame = null;
let firstFrameSaved = false;
const nextFrameWaiters = [];
let stopping = false;
let streamProcess = null;
let fallbackLoop = false;
const startedAt = Date.now();

function log(message) {
  process.stdout.write(`[phase0] ${message}\n`);
}

function sendJson(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function emitFrame(buffer) {
  if (stopping || buffer.length < 4) return;
  frameCount += 1;
  lastFrameAt = Date.now();
  latestFrame = Buffer.from(buffer);
  if (!firstFrameSaved) {
    firstFrameSaved = true;
    void writeFile(path.join(evidenceDir, 'simulator-first-frame.jpg'), latestFrame);
  }
  while (nextFrameWaiters.length) nextFrameWaiters.shift()(latestFrame);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && ws === activeViewer) ws.send(buffer, {binary: true});
  }
}

function nextFrame(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const waiter = (frame) => {
      clearTimeout(timer);
      resolve(frame);
    };
    const timer = setTimeout(() => {
      const index = nextFrameWaiters.indexOf(waiter);
      if (index >= 0) nextFrameWaiters.splice(index, 1);
      resolve(latestFrame);
    }, timeoutMs);
    nextFrameWaiters.push(waiter);
  });
}

function parseJpegs(stream) {
  let pending = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length > 4) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        pending = pending.subarray(Math.max(0, pending.length - 1));
        return;
      }
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        pending = pending.subarray(start);
        return;
      }
      emitFrame(pending.subarray(start, end + 2));
      pending = pending.subarray(end + 2);
    }
  });
}

async function takeFallbackFrame() {
  await rm(fallbackPngPath, {force: true});
  const result = spawnSync('xcrun', ['simctl', 'io', udid, 'screenshot', fallbackPngPath], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = (result.stderr || result.error?.message || 'unknown screenshot error').trim();
    throw new Error(error);
  }
  const converted = spawnSync('sips', ['-s', 'format', 'jpeg', fallbackPngPath, '--out', fallbackPath], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (converted.status !== 0) {
    const error = (converted.stderr || converted.error?.message || 'unknown JPEG conversion error').trim();
    throw new Error(error);
  }
  const frame = await readFile(fallbackPath);
  emitFrame(frame);
}

async function fallbackFrames() {
  if (fallbackLoop || stopping) return;
  fallbackLoop = true;
  provider = 'simctl-screenshot-jpeg';
  for (const ws of clients) sendJson(ws, {type: 'provider', provider});
  log('Using xcrun simctl JPEG screenshot fallback at 5 fps.');
  while (!stopping) {
    const began = Date.now();
    try {
      await takeFallbackFrame();
    } catch (error) {
      log(`Screenshot fallback failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 200 - (Date.now() - began))));
  }
}

function startVideoStream() {
  const args = [
    'video-stream',
    '--format', 'mjpeg',
    '--fps', '5',
    '--compression-quality', '0.7',
    '--udid', udid,
  ];
  streamProcess = spawn('idb', args, {stdio: ['ignore', 'pipe', 'pipe']});
  parseJpegs(streamProcess.stdout);
  streamProcess.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) log(`idb: ${message.slice(0, 400)}`);
  });
  streamProcess.on('error', (error) => {
    log(`idb video-stream could not start: ${error.message}`);
    void fallbackFrames();
  });
  streamProcess.on('exit', (code, signal) => {
    if (!stopping) {
      log(`idb video-stream exited (code=${code}, signal=${signal ?? 'none'}).`);
      void fallbackFrames();
    }
  });
  setTimeout(() => {
    if (!stopping && frameCount === 0) {
      log('idb video-stream produced no frames within 8 seconds.');
      streamProcess?.kill('SIGTERM');
      void fallbackFrames();
    }
  }, 8_000).unref();
}

function runIdb(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('idb', [...args, '--udid', udid], {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({stdout, stderr});
      else reject(new Error(`idb ${args.join(' ')} failed (code=${code}, signal=${signal ?? 'none'}): ${(stderr || stdout).trim().slice(-1200)}`));
    });
  });
}

function constantTimeTokenMatch(candidate) {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify({ok: true, deviceName, provider, logicalSize}));
    return;
  }
  res.writeHead(404, {'Content-Type': 'text/plain'});
  res.end('Not found');
});

const wsServer = new WebSocketServer({noServer: true, maxPayload: 16 * 1024});
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || req.headers.origin !== origin) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
});

wsServer.on('connection', (ws) => {
  clients.add(ws);
  let authenticated = false;
  const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
  ws.on('message', async (raw, isBinary) => {
    if (isBinary || stopping) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { ws.close(1007, 'Invalid JSON'); return; }
    if (!authenticated) {
      if (message.type !== 'auth' || typeof message.token !== 'string' || !constantTimeTokenMatch(message.token)) {
        ws.close(1008, 'Invalid or expired session link');
        return;
      }
      if (activeViewer && activeViewer.readyState === WebSocket.OPEN) {
        ws.close(1008, 'Another viewer is already connected');
        return;
      }
      clearTimeout(authTimer);
      authenticated = true;
      activeViewer = ws;
      lastActivity = Date.now();
      sendJson(ws, {type: 'ready', deviceName, logicalSize, provider});
      if (latestFrame) ws.send(latestFrame, {binary: true});
      log(`Viewer connected from the authorized Pages/tunnel origin; device=${deviceName}.`);
      return;
    }

    lastActivity = Date.now();
    if (message.type === 'heartbeat') return;
    if (message.type === 'tap') {
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        sendJson(ws, {type: 'error', message: 'Tap point is outside the simulator screen.'});
        return;
      }
      const started = Date.now();
      try {
        await runIdb(['ui', 'tap', String(Math.round(x * logicalSize.width)), String(Math.round(y * logicalSize.height))]);
        const commandMs = Date.now() - started;
        const commandCompletedAt = Date.now();
        const afterTapFrame = await nextFrame();
        if (afterTapFrame) await writeFile(path.join(evidenceDir, 'simulator-after-tap.jpg'), afterTapFrame);
        sendJson(ws, {type: 'action-result', action: 'tap', ok: true, commandMs, frameWaitMs: Date.now() - commandCompletedAt, frameAt: lastFrameAt});
      } catch (error) {
        sendJson(ws, {type: 'action-result', action: 'tap', ok: false, error: error.message});
      }
      return;
    }
    if (message.type === 'swipe') {
      const points = [message.x1, message.y1, message.x2, message.y2].map(Number);
      if (points.some((point) => !Number.isFinite(point) || point < 0 || point > 1)) {
        sendJson(ws, {type: 'error', message: 'Swipe point is outside the simulator screen.'});
        return;
      }
      const args = ['ui', 'swipe',
        String(Math.round(points[0] * logicalSize.width)), String(Math.round(points[1] * logicalSize.height)),
        String(Math.round(points[2] * logicalSize.width)), String(Math.round(points[3] * logicalSize.height))];
      try {
        await runIdb(args);
        sendJson(ws, {type: 'action-result', action: 'swipe', ok: true});
      } catch (error) {
        sendJson(ws, {type: 'action-result', action: 'swipe', ok: false, error: error.message});
      }
      return;
    }
    if (message.type === 'stop') {
      sendJson(ws, {type: 'stopping'});
      await stop('viewer requested stop');
      return;
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    if (activeViewer === ws) activeViewer = null;
  });
  ws.on('error', () => {});
});

let resolveStop;
const stopPromise = new Promise((resolve) => { resolveStop = resolve; });
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  log(`Stopping: ${reason}.`);
  if (streamProcess && !streamProcess.killed) streamProcess.kill('SIGTERM');
  for (const ws of clients) ws.close(1001, 'Session stopped');
  httpServer.close(() => resolveStop());
  setTimeout(() => resolveStop(), 1500).unref();
}

const idleTimer = setInterval(() => {
  if (!activeViewer && Date.now() - lastActivity > idleMs) void stop('idle timeout without a viewer');
  if (Date.now() - startedAt > maxSessionMs) void stop('maximum phase 0 session time reached');
  const elapsed = (Date.now() - frameWindowStart) / 1000;
  if (elapsed >= 10) {
    log(`metrics fps=${(frameCount / elapsed).toFixed(2)} provider=${provider} activeViewer=${Boolean(activeViewer)}`);
    frameCount = 0;
    frameWindowStart = Date.now();
  }
}, 1000).unref();

httpServer.listen(8787, '0.0.0.0', () => {
  log(`ready origin=${origin} device=${deviceName} logical=${logicalSize.width}x${logicalSize.height} idleTimeoutMs=${idleMs}`);
  startVideoStream();
});

await stopPromise;
clearInterval(idleTimer);
await rm(fallbackPath, {force: true});
await rm(fallbackPngPath, {force: true});
log('Session server stopped cleanly.');
