/*
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';

export const GATEWAY_VERSION = '0.1.0';
export const DEFAULT_BZFLAG_VERSION = '2.4.31';
export const DEFAULT_BZFLAG_PROTOCOL = '0221';
export const BRIDGE_MAGIC = Buffer.from('BZWB', 'ascii');
export const BRIDGE_VERSION = 1;
export const CHANNEL_TCP = 0;
export const CHANNEL_UDP = 1;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_UDP_BYTES = 65507;
const INDEX_HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url));

const MIT_LICENSE = [
  'Copyright (c) 2026 Sythos (https://www.sythos.net)',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
].join('\n');

export const DEFAULT_CONFIG = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  bridgePath: '/bridge',
  healthPath: '/healthz',
  allowedOrigins: ['http://localhost', 'http://127.0.0.1'],
  allowCustomServers: false,
  protocolVersion: DEFAULT_BZFLAG_PROTOCOL,
  bzflagVersion: DEFAULT_BZFLAG_VERSION,
  servers: [],
  limits: {
    maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
    maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
    maxMessagesPerSecond: 120,
    maxBytesPerSecond: 8 * 1024 * 1024,
    maxSessions: 128,
    maxSessionsPerIp: 4,
    idleTimeoutMs: 15 * 60 * 1000,
  },
  trustProxy: false,
});

function cloneDefaultConfig() {
  return {
    ...DEFAULT_CONFIG,
    allowedOrigins: [...DEFAULT_CONFIG.allowedOrigins],
    servers: [],
    limits: { ...DEFAULT_CONFIG.limits },
  };
}

function readJsonFile(path) {
  if (!path) {
    return {};
  }
  if (!existsSync(path)) {
    throw new Error(`Configuration file does not exist: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to parse configuration file ${path}: ${error.message}`);
  }
}

function asPositiveInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error('allowedOrigins must contain at least one origin');
  }
  return origins.map((origin) => {
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new Error('allowedOrigins entries must be non-empty strings');
    }
    if (origin !== '*') {
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`Invalid allowed origin: ${origin}`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new Error(`Allowed origins must contain only scheme and host: ${origin}`);
      }
      return parsed.origin;
    }
    return origin;
  });
}

function normalizeServer(server, index) {
  if (!server || typeof server !== 'object') {
    throw new Error(`servers[${index}] must be an object`);
  }
  const id = String(server.id ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw new Error(`servers[${index}].id must contain only letters, numbers, dot, underscore, or dash`);
  }
  const host = String(server.host ?? '').trim();
  if (!host || host.length > 253 || /[\s/]/.test(host)) {
    throw new Error(`servers[${index}].host must be a DNS name or IP address`);
  }
  const port = asPositiveInteger(server.port, 5154, `servers[${index}].port`);
  const udpPort = asPositiveInteger(server.udpPort, port, `servers[${index}].udpPort`);
  if (port > 65535 || udpPort > 65535) {
    throw new Error(`servers[${index}] ports must be between 1 and 65535`);
  }
  const kind = server.kind ?? 'official';
  if (kind !== 'official' && kind !== 'custom') {
    throw new Error(`servers[${index}].kind must be official or custom`);
  }
  return Object.freeze({
    id,
    host,
    port,
    udpPort,
    kind,
    enabled: server.enabled !== false,
    protocolVersion: String(server.protocolVersion ?? DEFAULT_BZFLAG_PROTOCOL),
    bzflagVersion: String(server.bzflagVersion ?? DEFAULT_BZFLAG_VERSION),
    label: String(server.label ?? id).slice(0, 120),
  });
}

export function normalizeConfig(input = {}) {
  const defaults = cloneDefaultConfig();
  const source = input && typeof input === 'object' ? input : {};
  const limits = { ...defaults.limits, ...(source.limits ?? {}) };
  const config = {
    ...defaults,
    ...source,
    limits,
  };

  config.host = String(config.host || defaults.host);
  // Port zero is useful for isolated tests and lets an embedding process ask
  // the operating system for a free listener. Configured BZFlag target ports
  // remain strictly positive in normalizeServer.
  config.port = config.port === 0 ? 0 : asPositiveInteger(config.port, defaults.port, 'port');
  if (config.port > 65535) {
    throw new Error('port must be between 1 and 65535');
  }
  config.bridgePath = String(config.bridgePath || defaults.bridgePath);
  config.healthPath = String(config.healthPath || defaults.healthPath);
  if (!config.bridgePath.startsWith('/') || !config.healthPath.startsWith('/')) {
    throw new Error('bridgePath and healthPath must start with /');
  }
  config.allowedOrigins = normalizeOrigins(config.allowedOrigins);
  config.allowCustomServers = config.allowCustomServers === true;
  config.trustProxy = config.trustProxy === true;
  config.protocolVersion = String(config.protocolVersion || DEFAULT_BZFLAG_PROTOCOL);
  config.bzflagVersion = String(config.bzflagVersion || DEFAULT_BZFLAG_VERSION);
  if (!Array.isArray(config.servers)) {
    throw new Error('servers must be an array');
  }
  config.servers = config.servers.map(normalizeServer);
  const ids = new Set();
  for (const server of config.servers) {
    if (ids.has(server.id)) {
      throw new Error(`Duplicate server id: ${server.id}`);
    }
    ids.add(server.id);
  }
  config.limits = {
    maxFrameBytes: asPositiveInteger(limits.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, 'limits.maxFrameBytes'),
    maxBufferedBytes: asPositiveInteger(limits.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, 'limits.maxBufferedBytes'),
    maxMessagesPerSecond: asPositiveInteger(limits.maxMessagesPerSecond, 120, 'limits.maxMessagesPerSecond'),
    maxBytesPerSecond: asPositiveInteger(limits.maxBytesPerSecond, 8 * 1024 * 1024, 'limits.maxBytesPerSecond'),
    maxSessions: asPositiveInteger(limits.maxSessions, 128, 'limits.maxSessions'),
    maxSessionsPerIp: asPositiveInteger(limits.maxSessionsPerIp, 4, 'limits.maxSessionsPerIp'),
    idleTimeoutMs: asPositiveInteger(limits.idleTimeoutMs, 15 * 60 * 1000, 'limits.idleTimeoutMs'),
  };
  if (config.limits.maxFrameBytes < 1024) {
    throw new Error('limits.maxFrameBytes must be at least 1024');
  }
  if (config.limits.maxSessionsPerIp > config.limits.maxSessions) {
    config.limits.maxSessionsPerIp = config.limits.maxSessions;
  }
  const token = config.sessionToken ?? '';
  config.sessionToken = typeof token === 'string' && token.length > 0
    ? token
    : randomBytes(32).toString('base64url');
  if (config.sessionToken.length > 512) {
    throw new Error('sessionToken must not exceed 512 characters');
  }
  config.tls = config.tls && typeof config.tls === 'object' ? { ...config.tls } : null;
  return config;
}

export function loadConfig({ path = process.env.BZFLAG_WEB_CONFIG || 'config.json', env = process.env } = {}) {
  const fileConfig = path && existsSync(path) ? readJsonFile(path) : {};
  const input = { ...fileConfig };
  if (env.BZFLAG_WEB_HOST) input.host = env.BZFLAG_WEB_HOST;
  if (env.BZFLAG_WEB_PORT) input.port = env.BZFLAG_WEB_PORT;
  if (env.BZFLAG_WEB_SESSION_TOKEN) input.sessionToken = env.BZFLAG_WEB_SESSION_TOKEN;
  if (env.BZFLAG_WEB_ALLOWED_ORIGINS) {
    input.allowedOrigins = env.BZFLAG_WEB_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  if (env.BZFLAG_WEB_ALLOW_CUSTOM_SERVERS === 'true') input.allowCustomServers = true;
  if (env.BZFLAG_WEB_TRUST_PROXY === 'true') input.trustProxy = true;
  const config = normalizeConfig(input);
  config.configPath = path && existsSync(path) ? path : null;
  return config;
}

function tokenMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}

export function encodeBridgeMessage(channel, payload, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
  if (channel !== CHANNEL_TCP && channel !== CHANNEL_UDP) {
    throw new Error(`Unsupported bridge channel: ${channel}`);
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > maxFrameBytes - 8) {
    throw new Error('Bridge payload exceeds the configured frame limit');
  }
  const message = Buffer.allocUnsafe(8 + body.length);
  BRIDGE_MAGIC.copy(message, 0);
  message[4] = BRIDGE_VERSION;
  message[5] = channel;
  message.writeUInt16BE(0, 6);
  body.copy(message, 8);
  return message;
}

export function decodeBridgeMessage(input, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
  const message = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (message.length > maxFrameBytes) {
    throw new Error('WebSocket message exceeds the configured frame limit');
  }
  if (message.length < 4 || !message.subarray(0, 4).equals(BRIDGE_MAGIC)) {
    // Raw TCP messages are accepted for a short compatibility path. New clients
    // should always send the explicit envelope so UDP can be selected safely.
    return { channel: CHANNEL_TCP, payload: message, legacy: true };
  }
  if (message.length < 8) throw new Error('Incomplete bridge envelope');
  if (message[4] !== BRIDGE_VERSION) throw new Error(`Unsupported bridge version: ${message[4]}`);
  if (message.readUInt16BE(6) !== 0) throw new Error('Bridge envelope flags are reserved');
  const channel = message[5];
  if (channel !== CHANNEL_TCP && channel !== CHANNEL_UDP) throw new Error(`Unsupported bridge channel: ${channel}`);
  return { channel, payload: message.subarray(8), legacy: false };
}

function splitBuffer(buffer, size) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  }
  return chunks;
}

function websocketFrame(payload, opcode = 2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function websocketCloseFrame(code, reason = '') {
  const reasonBuffer = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const body = Buffer.allocUnsafe(2 + reasonBuffer.length);
  body.writeUInt16BE(code, 0);
  reasonBuffer.copy(body, 2);
  return websocketFrame(body, 8);
}

export class WebSocketConnection {
  constructor(socket, { maxFrameBytes, maxBufferedBytes, onMessage, onClose }) {
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.fragmentBuffer = null;
    this.closed = false;
    this.closeSent = false;
    this.lastActivity = Date.now();
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => this.#finish());
    socket.on('close', () => this.#finish());
    socket.on('timeout', () => this.close(1001, 'Idle timeout'));
  }

  #onData(chunk) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.#parseFrames();
    } catch (error) {
      this.close(error.code === 'WS_TOO_LARGE' ? 1009 : 1002, error.message);
    }
  }

  #parseFrames() {
    while (!this.closed && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let headerLength = 2;
      if (rsv !== 0) throw new Error('WebSocket extensions are not enabled');
      if (!masked) throw new Error('Client WebSocket frames must be masked');
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const extendedLength = this.buffer.readBigUInt64BE(2);
        if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame length is too large');
        length = Number(extendedLength);
        headerLength = 10;
      }
      if (length > this.maxFrameBytes) {
        const error = new Error('WebSocket frame exceeds the configured limit');
        error.code = 'WS_TOO_LARGE';
        throw error;
      }
      const control = opcode >= 8;
      if (control && (!fin || length > 125)) throw new Error('Invalid WebSocket control frame');
      const frameLength = headerLength + 4 + length;
      if (this.buffer.length < frameLength) return;
      const mask = this.buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(this.buffer.subarray(headerLength + 4, frameLength));
      this.buffer = this.buffer.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      this.#handleFrame(opcode, fin, payload);
    }
  }

  #handleFrame(opcode, fin, payload) {
    this.lastActivity = Date.now();
    if (opcode === 0x8) {
      if (!this.closeSent) {
        this.closeSent = true;
        this.socket.write(websocketFrame(payload, 8));
      }
      this.socket.end();
      this.closed = true;
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(websocketFrame(payload, 0xA));
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x1) throw new Error('Text WebSocket messages are not supported');
    if (opcode === 0x2) {
      if (this.fragmentBuffer !== null) throw new Error('A fragmented WebSocket message is already open');
      if (fin) {
        this.onMessage(payload);
      } else {
        this.fragmentBuffer = payload;
      }
      return;
    }
    if (opcode === 0x0) {
      if (this.fragmentBuffer === null) throw new Error('Unexpected WebSocket continuation frame');
      this.fragmentBuffer = Buffer.concat([this.fragmentBuffer, payload]);
      if (this.fragmentBuffer.length > this.maxFrameBytes) {
        const error = new Error('Fragmented WebSocket message exceeds the configured limit');
        error.code = 'WS_TOO_LARGE';
        throw error;
      }
      if (fin) {
        const completeMessage = this.fragmentBuffer;
        this.fragmentBuffer = null;
        this.onMessage(completeMessage);
      }
      return;
    }
    throw new Error(`Unsupported WebSocket opcode: ${opcode}`);
  }

  sendBinary(payload) {
    if (this.closed || !this.socket.writable) return false;
    const frame = websocketFrame(payload, 2);
    if (this.socket.writableLength + frame.length > this.maxBufferedBytes) {
      this.close(1013, 'Gateway send buffer is full');
      return false;
    }
    this.socket.write(frame);
    this.lastActivity = Date.now();
    return true;
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    if (!this.closeSent && this.socket.writable) {
      this.closeSent = true;
      this.socket.write(websocketCloseFrame(code, reason));
    }
    this.socket.end();
    this.#finish();
  }

  #finish() {
    if (!this.closed) this.closed = true;
    if (this.onClose) {
      const callback = this.onClose;
      this.onClose = null;
      callback();
    }
  }
}

class RateLimiter {
  constructor(maxMessages, maxBytes) {
    this.maxMessages = maxMessages;
    this.maxBytes = maxBytes;
    this.windowStarted = Date.now();
    this.messages = 0;
    this.bytes = 0;
  }

  consume(bytes) {
    const now = Date.now();
    if (now - this.windowStarted >= 1000) {
      this.windowStarted = now;
      this.messages = 0;
      this.bytes = 0;
    }
    if (this.messages + 1 > this.maxMessages || this.bytes + bytes > this.maxBytes) return false;
    this.messages += 1;
    this.bytes += bytes;
    return true;
  }
}

class GatewaySession {
  constructor(gateway, ws, target, clientIp) {
    this.gateway = gateway;
    this.ws = ws;
    this.target = target;
    this.clientIp = clientIp;
    this.tcp = null;
    this.udp = null;
    this.closed = false;
    this.lastActivity = Date.now();
    this.inboundLimiter = new RateLimiter(
      gateway.config.limits.maxMessagesPerSecond,
      gateway.config.limits.maxBytesPerSecond,
    );
    this.outboundLimiter = new RateLimiter(
      gateway.config.limits.maxMessagesPerSecond,
      gateway.config.limits.maxBytesPerSecond,
    );
    this.ws.onMessage = (payload) => this.#handleClientMessage(payload);
    this.ws.onClose = () => this.close('websocket closed');
    gateway.sessions.add(this);
    gateway.incrementIp(clientIp);
    this.#connect();
  }

  #connect() {
    this.tcp = createConnection({ host: this.target.host, port: this.target.port });
    this.tcp.setNoDelay(true);
    this.tcp.setTimeout(this.gateway.config.limits.idleTimeoutMs, () => this.close('TCP idle timeout'));
    this.tcp.on('connect', () => {
      this.lastActivity = Date.now();
    });
    this.tcp.on('data', (data) => this.#sendTargetData(CHANNEL_TCP, data));
    this.tcp.on('error', (error) => this.#fail(`TCP connection error: ${error.code || 'error'}`));
    this.tcp.on('close', () => {
      if (!this.closed) this.close('TCP connection closed');
    });

    this.udp = createSocket(this.target.host.includes(':') ? 'udp6' : 'udp4');
    this.udp.on('message', (data) => this.#sendTargetData(CHANNEL_UDP, data));
    this.udp.on('error', (error) => this.#fail(`UDP connection error: ${error.code || 'error'}`));
    this.udp.connect(this.target.udpPort, this.target.host, () => {
      this.lastActivity = Date.now();
    });
  }

  #handleClientMessage(payload) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (!this.inboundLimiter.consume(payload.length)) {
      this.#fail('Inbound rate limit exceeded', 1008);
      return;
    }
    let message;
    try {
      message = decodeBridgeMessage(payload, this.gateway.config.limits.maxFrameBytes);
    } catch (error) {
      this.#fail(error.message, 1003);
      return;
    }
    if (message.channel === CHANNEL_UDP && message.payload.length > DEFAULT_MAX_UDP_BYTES) {
      this.#fail('UDP datagram exceeds the protocol limit', 1009);
      return;
    }
    if (message.channel === CHANNEL_TCP) {
      if (!this.tcp || this.tcp.destroyed) return this.#fail('TCP connection is unavailable');
      this.tcp.write(message.payload);
    } else {
      if (!this.udp) return this.#fail('UDP connection is unavailable');
      this.udp.send(message.payload);
    }
  }

  #sendTargetData(channel, data) {
    if (this.closed) return;
    this.lastActivity = Date.now();
    const chunkSize = Math.max(1, this.gateway.config.limits.maxFrameBytes - 8);
    for (const chunk of splitBuffer(data, chunkSize)) {
      const envelope = encodeBridgeMessage(channel, chunk, this.gateway.config.limits.maxFrameBytes);
      if (!this.outboundLimiter.consume(envelope.length)) {
        return this.#fail('Outbound rate limit exceeded', 1008);
      }
      if (!this.ws.sendBinary(envelope)) return;
    }
  }

  #fail(reason, code = 1011) {
    if (this.closed) return;
    this.ws.close(code, reason);
    this.close(reason);
  }

  tick(now) {
    if (!this.closed && now - this.lastActivity > this.gateway.config.limits.idleTimeoutMs) {
      this.#fail('Session idle timeout', 1001);
    }
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    if (this.tcp && !this.tcp.destroyed) this.tcp.destroy();
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        // The UDP socket may already have emitted close during shutdown.
      }
    }
    this.gateway.sessions.delete(this);
    this.gateway.decrementIp(this.clientIp);
    if (!this.ws.closed) this.ws.close(1000, reason);
  }
}

function clientIpForRequest(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function writeHttpResponse(response, statusCode, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(body);
}

function rejectUpgrade(socket, statusCode, message) {
  const body = `${message}\n`;
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusCode === 400 ? 'Bad Request' : statusCode === 403 ? 'Forbidden' : 'Not Found'}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
}

function websocketAccept(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function hasUpgradeHeader(value) {
  return typeof value === 'string' && value.split(',').some((part) => part.trim().toLowerCase() === 'upgrade');
}

function serveHome(response) {
  const body = existsSync(INDEX_HTML_PATH)
    ? readFileSync(INDEX_HTML_PATH, 'utf8')
    : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BZFlag Web Gateway</title></head><body><h1>BZFlag Web Gateway</h1><p>The gateway is running. Open the web client and configure its bridge URL.</p></body></html>';
  writeHttpResponse(response, 200, body, 'text/html; charset=utf-8');
}

export function createGateway(inputConfig = {}) {
  const config = normalizeConfig(inputConfig);
  const tlsOptions = config.tls && config.tls.keyFile && config.tls.certFile
    ? { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) }
    : null;
  const server = tlsOptions ? createHttpsServer(tlsOptions) : createHttpServer();
  const gateway = {
    config,
    server,
    sessions: new Set(),
    sessionsByIp: new Map(),
    heartbeat: null,
    incrementIp(ip) {
      this.sessionsByIp.set(ip, (this.sessionsByIp.get(ip) || 0) + 1);
    },
    decrementIp(ip) {
      const count = (this.sessionsByIp.get(ip) || 1) - 1;
      if (count <= 0) this.sessionsByIp.delete(ip);
      else this.sessionsByIp.set(ip, count);
    },
    findServer(id) {
      return this.config.servers.find((serverEntry) => serverEntry.id === id && serverEntry.enabled) || null;
    },
    health() {
      return {
        status: 'ok',
        gatewayVersion: GATEWAY_VERSION,
        bzflagVersion: this.config.bzflagVersion,
        protocolVersion: this.config.protocolVersion,
        activeSessions: this.sessions.size,
        allowlistedServers: this.config.servers.filter((serverEntry) => serverEntry.enabled).length,
      };
    },
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          this.heartbeat = setInterval(() => {
            const now = Date.now();
            for (const session of this.sessions) session.tick(now);
          }, Math.min(30_000, Math.max(1_000, Math.floor(this.config.limits.idleTimeoutMs / 2))));
          this.heartbeat.unref?.();
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.config.port, this.config.host);
      });
    },
    stop() {
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const session of [...this.sessions]) session.close('Gateway shutdown');
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
  };

  server.on('request', (request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://gateway.invalid');
    } catch {
      return writeHttpResponse(response, 400, JSON.stringify({ error: 'Invalid request URL' }));
    }
    if (request.method === 'GET' && url.pathname === config.healthPath) {
      return writeHttpResponse(response, 200, JSON.stringify(gateway.health()));
    }
    if (request.method === 'GET' && url.pathname === '/') return serveHome(response);
    return writeHttpResponse(response, 404, JSON.stringify({ error: 'Not found' }));
  });

  server.on('upgrade', (request, socket) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://gateway.invalid');
    } catch {
      return rejectUpgrade(socket, 400, 'Invalid request URL');
    }
    const headers = request.headers;
    if (url.pathname !== config.bridgePath) return rejectUpgrade(socket, 404, 'Bridge endpoint not found');
    if (String(headers.upgrade || '').toLowerCase() !== 'websocket' || !hasUpgradeHeader(headers.connection)) {
      return rejectUpgrade(socket, 400, 'WebSocket upgrade required');
    }
    if (String(headers['sec-websocket-version'] || '') !== '13' || typeof headers['sec-websocket-key'] !== 'string') {
      return rejectUpgrade(socket, 400, 'Unsupported WebSocket handshake');
    }
    if (!isOriginAllowed(headers.origin, config.allowedOrigins)) return rejectUpgrade(socket, 403, 'Origin is not allowed');
    if (!tokenMatches(config.sessionToken, url.searchParams.get('token') || '')) return rejectUpgrade(socket, 403, 'Invalid session token');
    const targetId = url.searchParams.get('server') || '';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(targetId)) return rejectUpgrade(socket, 400, 'A valid server id is required');
    const target = gateway.findServer(targetId);
    if (!target) return rejectUpgrade(socket, 403, 'Server is not allowlisted');
    if (target.kind === 'custom' && !config.allowCustomServers) return rejectUpgrade(socket, 403, 'Custom servers are disabled');
    const clientIp = clientIpForRequest(request, config.trustProxy);
    if (gateway.sessions.size >= config.limits.maxSessions) return rejectUpgrade(socket, 503, 'Gateway session limit reached');
    if ((gateway.sessionsByIp.get(clientIp) || 0) >= config.limits.maxSessionsPerIp) return rejectUpgrade(socket, 429, 'Client session limit reached');

    const accept = websocketAccept(headers['sec-websocket-key']);
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    socket.setNoDelay(true);
    const ws = new WebSocketConnection(socket, {
      maxFrameBytes: config.limits.maxFrameBytes,
      maxBufferedBytes: config.limits.maxBufferedBytes,
      onMessage: null,
      onClose: null,
    });
    new GatewaySession(gateway, ws, target, clientIp);
  });

  return gateway;
}

export function buildLicenseText() {
  return MIT_LICENSE;
}

function printStartup(config, address) {
  const protocol = config.tls ? 'https' : 'http';
  const tokenSource = process.env.BZFLAG_WEB_SESSION_TOKEN ? 'environment' : config.configPath ? 'configuration file' : 'generated at startup';
  console.log(`BZFlag Web Gateway ${GATEWAY_VERSION} listening on ${protocol}://${address.address}:${address.port}`);
  console.log(`Allowlisted servers: ${config.servers.filter((server) => server.enabled).map((server) => server.id).join(', ') || 'none'}`);
  console.log(`Session token source: ${tokenSource}`);
  if (!process.env.BZFLAG_WEB_SESSION_TOKEN && !config.configPath) {
    console.log(`Session token (set BZFLAG_WEB_SESSION_TOKEN for a stable value): ${config.sessionToken}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const configFlagIndex = argv.indexOf('--config');
  const configPath = configFlagIndex >= 0 ? argv[configFlagIndex + 1] : undefined;
  if (configFlagIndex >= 0 && !configPath) throw new Error('--config requires a file path');
  const config = loadConfig({ path: configPath });
  const gateway = createGateway(config);
  const shutdown = async () => {
    await gateway.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const address = await gateway.start();
  printStartup(config, address);
  return gateway;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Gateway startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
