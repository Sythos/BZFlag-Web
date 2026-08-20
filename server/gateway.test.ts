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

import { createConnection, createServer as createTcpServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net';
import type { RemoteInfo, Socket as DatagramSocket } from 'node:dgram';
import type { TestContext } from 'node:test';
import { createBzFlagLoopbackFixture } from './fixtures/bzflag-loopback.js';
import {
  CHANNEL_TCP,
  CHANNEL_UDP,
  createGateway,
  decodeBridgeMessage,
  encodeBridgeMessage,
  isPublicTargetAddress,
  loadConfig,
  normalizeConfig,
} from './gateway.js';

interface ServerFrame {
  opcode: number;
  payload: Buffer;
  rest: Buffer;
}

interface UpgradeResult {
  connection: Socket;
  response: string;
  remainder: Buffer;
}

interface UpgradeOptions {
  serverId?: string;
  token?: string;
  subprotocol?: boolean;
}

function listenTcp(server: TcpServer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function listenUdp(socket: DatagramSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve(socket.address().port);
    });
  });
}

function maskedWebSocketFrame(payload: Buffer | Uint8Array | string, opcode = 2, fin = true): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  let header;
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrame(buffer: Buffer): ServerFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return { opcode: first & 0x0f, payload: buffer.subarray(offset, offset + length), rest: buffer.subarray(offset + length) };
}

function readServerFrame(socket: Socket): Promise<ServerFrame> {
  return new Promise<ServerFrame>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const frame = parseServerFrame(buffer);
      if (!frame) return;
      socket.off('data', onData);
      resolve(frame);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function waitForSocketClose(socket: Socket, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for the WebSocket socket to close'));
    }, timeoutMs);
    timer.unref?.();
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function awaitableSocket(port: number, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const serverId = options.serverId || 'official-test';
  const token = options.token || 'test-token';
  const queryToken = options.subprotocol ? '' : `&token=${encodeURIComponent(token)}`;
  const subprotocol = options.subprotocol
    ? ['Sec-WebSocket-Protocol: bzflag-web-v1, bzflag-token.' + Buffer.from(token, 'utf8').toString('base64url')]
    : [];
  return new Promise<UpgradeResult>((resolve, reject) => {
    const connection = createConnection({ host: '127.0.0.1', port });
    let response = Buffer.alloc(0);
    const onData = (chunk: Buffer | string) => {
      response = Buffer.concat([response, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const marker = response.indexOf('\r\n\r\n');
      if (marker < 0) return;
      connection.off('data', onData);
      resolve({ connection, response: response.subarray(0, marker + 4).toString('ascii'), remainder: response.subarray(marker + 4) });
    };
    connection.on('data', onData);
    connection.once('error', reject);
    connection.on('connect', () => {
      connection.write([
        `GET /bridge?server=${encodeURIComponent(serverId)}${queryToken} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Origin: http://localhost:3000',
        ...subprotocol,
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function bzFlagPacket(code: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const packet = Buffer.alloc(4 + payload.length);
  packet.writeUInt16BE(payload.length, 0);
  packet.writeUInt16BE(code, 2);
  payload.copy(packet, 4);
  return packet;
}

test('bridge envelope encodes explicit TCP and UDP channels', () => {
  const tcp = encodeBridgeMessage(CHANNEL_TCP, Buffer.from('tcp'));
  const udp = encodeBridgeMessage(CHANNEL_UDP, Buffer.from('udp'));
  assert.deepEqual(decodeBridgeMessage(tcp), { channel: CHANNEL_TCP, payload: Buffer.from('tcp'), legacy: false });
  assert.deepEqual(decodeBridgeMessage(udp), { channel: CHANNEL_UDP, payload: Buffer.from('udp'), legacy: false });
  assert.deepEqual(decodeBridgeMessage(Buffer.from('legacy')), { channel: CHANNEL_TCP, payload: Buffer.from('legacy'), legacy: true });
});

test('trustProxy requires an exact IP peer allowlist', () => {
  assert.throws(() => normalizeConfig({ trustProxy: true }), /trustedProxyPeers/);
  assert.throws(() => normalizeConfig({ trustedProxyPeers: ['proxy.example.test'] }), /IP addresses/);
  const config = normalizeConfig({ trustProxy: true, trustedProxyPeers: ['127.0.0.1'] });
  assert.equal(config.trustProxy, true);
  assert.deepEqual(config.trustedProxyPeers, ['127.0.0.1']);
});

test('target policy rejects private and metadata address space unless explicitly enabled for local fixtures', () => {
  assert.equal(isPublicTargetAddress('127.0.0.1'), false);
  assert.equal(isPublicTargetAddress('10.0.0.12'), false);
  assert.equal(isPublicTargetAddress('169.254.169.254'), false);
  assert.equal(isPublicTargetAddress('192.168.1.10'), false);
  assert.equal(isPublicTargetAddress('::1'), false);
  assert.equal(isPublicTargetAddress('fd00:ec2::254'), false);
  assert.equal(isPublicTargetAddress('203.0.113.20'), false);
  assert.equal(isPublicTargetAddress('8.8.8.8'), true);
  assert.throws(() => normalizeConfig({
    servers: [{ id: 'private', kind: 'official', host: '127.0.0.1', port: 5154 }],
  }), /publicly routable/);
  const localFixture = normalizeConfig({
    allowPrivateAddresses: true,
    servers: [{ id: 'private', kind: 'official', host: '127.0.0.1', port: 5154 }],
  });
  assert.equal(localFixture.allowPrivateAddresses, true);
});

test('configuration paths stay relative and the default target policy is official-only', () => {
  const config = loadConfig({
    path: './config.example.json',
    env: {
      BZFLAG_WEB_CONFIG: '',
      BZFLAG_WEB_SESSION_TOKEN: 'test-token',
    },
  });
  assert.equal(config.configPath, './config.example.json');
  assert.equal(config.allowCustomServers, false);
  assert.equal(config.servers[0]?.kind, 'official');
});

test('gateway authenticates bearer tokens through the WebSocket subprotocol and can disable query compatibility', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowLegacyQueryToken: false,
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: targetPort }],
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const subprotocol = await awaitableSocket(address.port, { subprotocol: true });
  assert.match(subprotocol.response, /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(subprotocol.response, /Sec-WebSocket-Protocol: bzflag-web-v1\r?\n/i);
  subprotocol.connection.end(maskedWebSocketFrame(Buffer.alloc(0), 8));

  const legacy = await awaitableSocket(address.port);
  assert.match(legacy.response, /^HTTP\/1\.1 403 Forbidden/);
  legacy.connection.destroy();
});

test('gateway exposes health and forwards TCP and UDP traffic only to an allowlisted target', async (t: TestContext) => {
  const tcpTarget = createTcpServer((socket) => {
    socket.on('data', (data: Buffer | string) => socket.write(Buffer.concat([Buffer.from('tcp-reply:'), Buffer.isBuffer(data) ? data : Buffer.from(data)])));
  });
  const tcpPort = await listenTcp(tcpTarget);
  t.after(() => tcpTarget.close());

  const udpTarget = createSocket('udp4');
  udpTarget.on('message', (data: Buffer, remote: RemoteInfo) => udpTarget.send(Buffer.concat([Buffer.from('udp-reply:'), data]), remote.port, remote.address));
  const udpPort = await listenUdp(udpTarget);
  t.after(() => udpTarget.close());

  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: tcpPort, udpPort }],
    limits: { maxFrameBytes: 1024, maxBufferedBytes: 8192, maxMessagesPerSecond: 20, maxBytesPerSecond: 8192, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`).then((response) => response.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.allowlistedServers, 1);
  const home = await fetch(`http://127.0.0.1:${address.port}/`).then((response) => response.text());
  assert.match(home, /BZFlag Web Gateway/);

  const { connection, response } = await awaitableSocket(address.port);
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);

  connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.from('hello'))));
  const tcpFrame = await readServerFrame(connection);
  assert.equal(tcpFrame.opcode, 2);
  assert.deepEqual(decodeBridgeMessage(tcpFrame.payload).payload, Buffer.from('tcp-reply:hello'));

  connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_UDP, Buffer.from('ping'))));
  const udpFrame = await readServerFrame(connection);
  assert.equal(udpFrame.opcode, 2);
  assert.deepEqual(decodeBridgeMessage(udpFrame.payload).payload, Buffer.from('udp-reply:ping'));

  connection.end(maskedWebSocketFrame(Buffer.alloc(0), 8));
});

test('gateway relays BZFlag TCP streams and intact UDP datagrams through the bridge', async (t: TestContext) => {
  const fixture = await createBzFlagLoopbackFixture();
  t.after(() => fixture.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{
      id: 'official-loopback',
      kind: 'official',
      host: '127.0.0.1',
      port: fixture.tcpPort,
      udpPort: fixture.udpPort,
    }],
    limits: { maxFrameBytes: 1024, maxBufferedBytes: 8192, maxMessagesPerSecond: 20, maxBytesPerSecond: 8192, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connectionResult = await new Promise<UpgradeResult>((resolve, reject) => {
    const connection = createConnection({ host: '127.0.0.1', port: address.port });
    let response = Buffer.alloc(0);
    const onData = (chunk: Buffer | string) => {
      response = Buffer.concat([response, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const marker = response.indexOf('\r\n\r\n');
      if (marker < 0) return;
      connection.off('data', onData);
      resolve({ connection, response: response.subarray(0, marker + 4).toString('ascii'), remainder: response.subarray(marker + 4) });
    };
    connection.on('data', onData);
    connection.once('error', reject);
    connection.on('connect', () => connection.write([
      'GET /bridge?server=official-loopback&token=test-token HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Origin: http://localhost:3000',
      '',
      '',
    ].join('\r\n')));
  });
  assert.match(connectionResult.response, /^HTTP\/1\.1 101 Switching Protocols/);

  const tcpPacket = bzFlagPacket(0x656e, Buffer.from([0, 1, 2, 3]));
  connectionResult.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, tcpPacket)));
  const tcpFirst = await readServerFrame(connectionResult.connection);
  const tcpSecond = await readServerFrame(connectionResult.connection);
  const tcpPayload = Buffer.concat([
    decodeBridgeMessage(tcpFirst.payload).payload,
    decodeBridgeMessage(tcpSecond.payload).payload,
  ]);
  assert.deepEqual(tcpPayload, tcpPacket);

  const udpPacket = bzFlagPacket(0x7075, Buffer.from([0xaa, 0xbb, 0xcc]));
  connectionResult.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_UDP, udpPacket)));
  const udpFrame = await readServerFrame(connectionResult.connection);
  const udpMessage = decodeBridgeMessage(udpFrame.payload);
  assert.equal(udpMessage.channel, CHANNEL_UDP);
  assert.deepEqual(udpMessage.payload, udpPacket);

  connectionResult.connection.end(maskedWebSocketFrame(Buffer.alloc(0), 8));
});

test('gateway closes a session before TCP write buffering can exceed its limit', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', host: '127.0.0.1', port: targetPort }],
    limits: { maxFrameBytes: 1024, maxBufferedBytes: 64, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.alloc(100))));
  await waitForSocketClose(connection.connection);
});

test('gateway rejects UDP datagrams larger than the upstream 2.4.31 limit', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', host: '127.0.0.1', port: targetPort }],
    limits: { maxFrameBytes: 1024, maxBufferedBytes: 8192, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_UDP, Buffer.alloc(69))));
  await waitForSocketClose(connection.connection);
});

test('gateway rejects a WebSocket upgrade with an untrusted Origin', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', host: '127.0.0.1', port: targetPort }],
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());
  const result = await new Promise<{ response: string; connection: Socket }>((resolve, reject) => {
    const connection = createConnection({ host: '127.0.0.1', port: address.port });
    let response = '';
    connection.on('data', (chunk: Buffer | string) => {
      response += chunk.toString('ascii');
      if (response.includes('\r\n\r\n')) resolve({ response, connection });
    });
    connection.once('error', reject);
    connection.on('connect', () => connection.write([
      'GET /bridge?server=official-test&token=test-token HTTP/1.1',
      'Host: 127.0.0.1',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Origin: https://untrusted.example',
      '',
      '',
    ].join('\r\n')));
  });
  assert.match(result.response, /^HTTP\/1\.1 403 Forbidden/);
  result.connection.destroy();
});

test('gateway closes an incomplete frame after the parser deadline and bounds continuations', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', host: '127.0.0.1', port: targetPort }],
    limits: {
      handshakeTimeoutMs: 1000,
      parserTimeoutMs: 50,
      maxContinuationFrames: 1,
      maxContinuationBytes: 1024,
      idleTimeoutMs: 5000,
    },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const partial = await awaitableSocket(address.port);
  // FIN binary frame, masked, declares five bytes but sends only one byte.
  partial.connection.write(Buffer.from([0x82, 0x85, 0x12, 0x34, 0x56, 0x78, 0x01]));
  await waitForSocketClose(partial.connection);

  const fragmented = await awaitableSocket(address.port);
  fragmented.connection.write(maskedWebSocketFrame(Buffer.from([0x01]), 2, false));
  fragmented.connection.write(maskedWebSocketFrame(Buffer.from([0x02]), 0, false));
  fragmented.connection.write(maskedWebSocketFrame(Buffer.from([0x03]), 0, true));
  await waitForSocketClose(fragmented.connection);
});

test('gateway bounds complete frame and control-frame rates', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', host: '127.0.0.1', port: targetPort }],
    limits: {
      maxFrameBytes: 1024,
      maxFramesPerSecond: 8,
      maxControlFramesPerSecond: 1,
      parserTimeoutMs: 1000,
      idleTimeoutMs: 5000,
    },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const controlFrames = await awaitableSocket(address.port);
  controlFrames.connection.write(maskedWebSocketFrame(Buffer.from('one'), 0x9));
  controlFrames.connection.write(maskedWebSocketFrame(Buffer.from('two'), 0x9));
  await waitForSocketClose(controlFrames.connection);

  const oversized = await awaitableSocket(address.port);
  const header = Buffer.alloc(8);
  header[0] = 0x82;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(1025, 2);
  Buffer.from([0x12, 0x34, 0x56, 0x78]).copy(header, 4);
  oversized.connection.write(header);
  await waitForSocketClose(oversized.connection);
});
