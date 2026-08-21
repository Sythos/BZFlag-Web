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
  BZFLAG_CONNECT_HEADER,
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
  subprotocolToken?: string;
  subprotocol?: boolean;
  queryToken?: boolean;
  host?: string;
}

function listenTcp(server: TcpServer, host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function listenUdp(socket: DatagramSocket, host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, host, () => {
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

function readServerFrame(socket: Socket, initial: Buffer<ArrayBufferLike> = Buffer.alloc(0)): Promise<ServerFrame> {
  return new Promise<ServerFrame>((resolve, reject) => {
    let buffer = Buffer.from(initial);
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const frame = parseServerFrame(buffer);
      if (!frame) return;
      socket.off('data', onData);
      resolve(frame);
    };
    const initialFrame = parseServerFrame(buffer);
    if (initialFrame) {
      resolve(initialFrame);
      return;
    }
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
  const subprotocolToken = options.subprotocolToken || token;
  const includeQueryToken = options.queryToken ?? !options.subprotocol;
  const queryToken = includeQueryToken ? `&token=${encodeURIComponent(token)}` : '';
  const subprotocol = options.subprotocol
    ? ['Sec-WebSocket-Protocol: bzflag-web-v1, bzflag-token.' + Buffer.from(subprotocolToken, 'utf8').toString('base64url')]
    : [];
  return new Promise<UpgradeResult>((resolve, reject) => {
    const host = options.host || '127.0.0.1';
    const hostHeader = host.includes(':') && !host.startsWith('[')
      ? `[${host}]`
      : host;
    const connection = createConnection({ host, port });
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
        `Host: ${hostHeader}`,
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

async function assertRejectedTargetGreeting(t: TestContext, greeting: Buffer): Promise<void> {
  let targetBytes = Buffer.alloc(0);
  const target = createTcpServer((socket) => {
    let greetingSent = false;
    socket.on('data', (data: Buffer | string) => {
      targetBytes = Buffer.concat([targetBytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      if (greetingSent || targetBytes.length < BZFLAG_CONNECT_HEADER.length) return;
      assert.deepEqual(targetBytes.subarray(0, BZFLAG_CONNECT_HEADER.length), BZFLAG_CONNECT_HEADER);
      greetingSent = true;
      socket.write(greeting);
    });
  });
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: targetPort }],
    limits: { targetHandshakeTimeoutMs: 1000, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.from('must-not-forward'))));
  await waitForSocketClose(connection.connection);
  assert.deepEqual(targetBytes, BZFLAG_CONNECT_HEADER);
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

test('target policy keeps TCP and UDP on the same non-local BZFS endpoint port', () => {
  assert.throws(() => normalizeConfig({
    servers: [{ id: 'split-port', kind: 'official', host: '8.8.8.8', port: 5154, udpPort: 5155 }],
  }), /udpPort must match port/);
  const localFixture = normalizeConfig({
    allowPrivateAddresses: true,
    servers: [{ id: 'split-port', kind: 'official', host: '127.0.0.1', port: 5154, udpPort: 5155 }],
  });
  assert.equal(localFixture.servers[0]?.udpPort, 5155);
});

test('gateway listener accepts an IPv6 loopback host', async (t: TestContext) => {
  const gateway = createGateway({
    host: '::1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://[::1]:3000'],
  });
  let address: AddressInfo;
  try {
    address = await gateway.start();
  } catch (error: any) {
    if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT') {
      if (process.env.BZFLAG_REQUIRE_IPV6 === 'true') throw error;
      t.skip(`IPv6 loopback is unavailable on this runner: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => gateway.stop());
  assert.equal(address.family, 'IPv6');
  const health = await fetch(`http://[::1]:${address.port}/healthz`).then((response) => response.json());
  assert.equal(health.status, 'ok');
});

test('gateway relays TCP and UDP to an IPv6 BZFS endpoint', async (t: TestContext) => {
  let tcpTarget: TcpServer | null = null;
  let udpTarget: DatagramSocket | null = null;
  let gateway: ReturnType<typeof createGateway> | null = null;
  try {
    tcpTarget = createTcpServer((socket) => {
      let buffered = Buffer.alloc(0);
      let ready = false;
      socket.on('data', (data: Buffer | string) => {
        buffered = Buffer.concat([buffered, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
        if (!ready) {
          if (buffered.length < BZFLAG_CONNECT_HEADER.length) return;
          assert.deepEqual(buffered.subarray(0, BZFLAG_CONNECT_HEADER.length), BZFLAG_CONNECT_HEADER);
          ready = true;
          buffered = buffered.subarray(BZFLAG_CONNECT_HEADER.length);
          socket.write(Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));
        }
        if (buffered.length > 0) {
          socket.write(Buffer.concat([Buffer.from('ipv6-tcp:'), buffered]));
          buffered = Buffer.alloc(0);
        }
      });
    });
    const tcpPort = await listenTcp(tcpTarget, '::1');
    t.after(() => tcpTarget?.close());

    udpTarget = createSocket('udp6');
    udpTarget.on('message', (data: Buffer, remote: RemoteInfo) => {
      udpTarget?.send(Buffer.concat([Buffer.from('ipv6-udp:'), data]), remote.port, remote.address);
    });
    const udpPort = await listenUdp(udpTarget, '::1');
    t.after(() => udpTarget?.close());

    gateway = createGateway({
      host: '127.0.0.1',
      port: 0,
      sessionToken: 'test-token',
      allowPrivateAddresses: true,
      allowedOrigins: ['http://localhost:3000'],
      servers: [{ id: 'official-ipv6', kind: 'official', host: '::1', port: tcpPort, udpPort }],
      limits: { maxFrameBytes: 1024, maxBufferedBytes: 8192, maxMessagesPerSecond: 20, maxBytesPerSecond: 8192, idleTimeoutMs: 5000 },
    });
    const address = await gateway.start();

    const { connection, response, remainder } = await awaitableSocket(address.port, { serverId: 'official-ipv6' });
    assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
    const greeting = await readServerFrame(connection, remainder);
    assert.deepEqual(decodeBridgeMessage(greeting.payload).payload, Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));

    connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.from('hello'))));
    const tcpReply = await readServerFrame(connection);
    assert.deepEqual(decodeBridgeMessage(tcpReply.payload).payload, Buffer.from('ipv6-tcp:hello'));

    connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_UDP, Buffer.from('ping'))));
    const udpReply = await readServerFrame(connection);
    assert.deepEqual(decodeBridgeMessage(udpReply.payload).payload, Buffer.from('ipv6-udp:ping'));
    connection.end(maskedWebSocketFrame(Buffer.alloc(0), 8));
  } catch (error: any) {
    if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT' || error?.code === 'ENETUNREACH') {
      if (process.env.BZFLAG_REQUIRE_IPV6 === 'true') throw error;
      t.skip(`IPv6 transport is unavailable on this runner: ${error.code}`);
      return;
    }
    throw error;
  } finally {
    if (gateway) await gateway.stop();
  }
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

test('gateway never falls back to a query token when a token subprotocol is present but invalid', async (t: TestContext) => {
  const target = createTcpServer();
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowLegacyQueryToken: true,
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: targetPort }],
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const result = await awaitableSocket(address.port, {
    subprotocol: true,
    queryToken: true,
    token: 'test-token',
    subprotocolToken: 'wrong-token',
  });
  assert.match(result.response, /^HTTP\/1\.1 403 Forbidden/);
  result.connection.destroy();
});

test('gateway exposes health and forwards TCP and UDP traffic only to an allowlisted target', async (t: TestContext) => {
  const tcpTarget = createTcpServer((socket) => {
    let ready = false;
    let buffered = Buffer.alloc(0);
    socket.on('data', (data: Buffer | string) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      if (!ready) {
        if (buffered.length < BZFLAG_CONNECT_HEADER.length) return;
        assert.deepEqual(buffered.subarray(0, BZFLAG_CONNECT_HEADER.length), BZFLAG_CONNECT_HEADER);
        ready = true;
        buffered = buffered.subarray(BZFLAG_CONNECT_HEADER.length);
        socket.write(Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));
      }
      if (buffered.length > 0) {
        socket.write(Buffer.concat([Buffer.from('tcp-reply:'), buffered]));
        buffered = Buffer.alloc(0);
      }
    });
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

  const { connection, response, remainder } = await awaitableSocket(address.port);
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/);
  const greetingFrame = await readServerFrame(connection, remainder);
  assert.deepEqual(decodeBridgeMessage(greetingFrame.payload).payload, Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));

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
  const greetingFrame = await readServerFrame(connectionResult.connection, connectionResult.remainder);
  assert.deepEqual(decodeBridgeMessage(greetingFrame.payload).payload, Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));

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

test('gateway rejects a non-BZFS target before forwarding queued client bytes', async (t: TestContext) => {
  let targetBytes = Buffer.alloc(0);
  const target = createTcpServer((socket) => {
    socket.on('data', (data: Buffer | string) => {
      targetBytes = Buffer.concat([targetBytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      socket.write(Buffer.from('HTTP/1.1\n', 'ascii'));
    });
  });
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: targetPort }],
    limits: { targetHandshakeTimeoutMs: 1000, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.from('client-secret'))));
  await waitForSocketClose(connection.connection);
  assert.deepEqual(targetBytes, BZFLAG_CONNECT_HEADER);
});

test('gateway closes a silent target when the upstream handshake deadline expires', async (t: TestContext) => {
  let targetBytes = Buffer.alloc(0);
  let probeSeenResolve: (() => void) | null = null;
  const probeSeen = new Promise<void>((resolve) => {
    probeSeenResolve = resolve;
  });
  const target = createTcpServer((socket) => {
    socket.on('data', (data: Buffer | string) => {
      targetBytes = Buffer.concat([targetBytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      if (targetBytes.length >= BZFLAG_CONNECT_HEADER.length) probeSeenResolve?.();
    });
  });
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: targetPort }],
    limits: { targetHandshakeTimeoutMs: 200, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  await probeSeen;
  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.from('must-not-forward'))));
  await waitForSocketClose(connection.connection, 1500);
  assert.deepEqual(targetBytes, BZFLAG_CONNECT_HEADER);
});

test('gateway accepts a fragmented BZFS greeting before releasing TCP traffic', async (t: TestContext) => {
  let targetInput = Buffer.alloc(0);
  let preambleSeen = false;
  const target = createTcpServer((socket) => {
    socket.on('data', (data: Buffer | string) => {
      targetInput = Buffer.concat([targetInput, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
      if (!preambleSeen) {
        if (targetInput.length < BZFLAG_CONNECT_HEADER.length) return;
        assert.deepEqual(targetInput.subarray(0, BZFLAG_CONNECT_HEADER.length), BZFLAG_CONNECT_HEADER);
        preambleSeen = true;
        targetInput = targetInput.subarray(BZFLAG_CONNECT_HEADER.length);
        socket.write(Buffer.from('BZFS', 'ascii'));
        setTimeout(() => {
          if (!socket.destroyed) socket.write(Buffer.from('0221', 'ascii'));
        }, 20);
        setTimeout(() => {
          if (!socket.destroyed) socket.write(Buffer.from([7]));
        }, 40);
      }
      if (preambleSeen && targetInput.length > 0) {
        const payload = targetInput;
        targetInput = Buffer.alloc(0);
        setTimeout(() => {
          if (!socket.destroyed) socket.write(Buffer.concat([Buffer.from('tcp-reply:'), payload]));
        }, 20);
      }
    });
  });
  const targetPort = await listenTcp(target);
  t.after(() => target.close());
  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: targetPort }],
    limits: { targetHandshakeTimeoutMs: 1000, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  const greetingFrame = await readServerFrame(connection.connection, connection.remainder);
  assert.deepEqual(decodeBridgeMessage(greetingFrame.payload).payload, Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));

  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_TCP, Buffer.from('fragmented-ok'))));
  const replyFrame = await readServerFrame(connection.connection);
  assert.deepEqual(decodeBridgeMessage(replyFrame.payload).payload, Buffer.from('tcp-reply:fragmented-ok'));
  connection.connection.end(maskedWebSocketFrame(Buffer.alloc(0), 8));
});

test('gateway rejects a target with the wrong BZFS protocol version before relay', async (t: TestContext) => {
  await assertRejectedTargetGreeting(t, Buffer.concat([Buffer.from('BZFS9999', 'ascii'), Buffer.from([7])]));
});

test('gateway rejects a target that returns the BZFS no-player id before relay', async (t: TestContext) => {
  await assertRejectedTargetGreeting(t, Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([255])]));
});

test('gateway withholds queued TCP and UDP traffic until the BZFS identity greeting is valid', async (t: TestContext) => {
  let targetSocket: Socket | null = null;
  let handshakeSeenResolve: (() => void) | null = null;
  const handshakeSeen = new Promise<void>((resolve) => {
    handshakeSeenResolve = resolve;
  });
  const tcpTarget = createTcpServer((socket) => {
    targetSocket = socket;
    socket.on('data', (data: Buffer | string) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (bytes.subarray(0, BZFLAG_CONNECT_HEADER.length).equals(BZFLAG_CONNECT_HEADER)) {
        handshakeSeenResolve?.();
      }
    });
  });
  const tcpPort = await listenTcp(tcpTarget);
  t.after(() => tcpTarget.close());

  const receivedUdp: Buffer[] = [];
  const udpTarget = createSocket('udp4');
  udpTarget.on('message', (data: Buffer) => receivedUdp.push(Buffer.from(data)));
  const udpPort = await listenUdp(udpTarget);
  t.after(() => udpTarget.close());

  const gateway = createGateway({
    host: '127.0.0.1',
    port: 0,
    sessionToken: 'test-token',
    allowPrivateAddresses: true,
    allowedOrigins: ['http://localhost:3000'],
    servers: [{ id: 'official-test', kind: 'official', host: '127.0.0.1', port: tcpPort, udpPort }],
    limits: { targetHandshakeTimeoutMs: 1000, idleTimeoutMs: 5000 },
  });
  const address = await gateway.start();
  t.after(() => gateway.stop());

  const connection = await awaitableSocket(address.port);
  assert.match(connection.response, /^HTTP\/1\.1 101 Switching Protocols/);
  await handshakeSeen;
  const queuedPacket = Buffer.from('queued-before-bzfs');
  connection.connection.write(maskedWebSocketFrame(encodeBridgeMessage(CHANNEL_UDP, queuedPacket)));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(receivedUdp, [], 'UDP payload reached the target before the BZFS greeting');

  const connectedTarget = targetSocket as Socket | null;
  assert.ok(connectedTarget, 'the TCP target did not accept the gateway connection');
  connectedTarget.write(Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));
  const greetingFrame = await readServerFrame(connection.connection, connection.remainder);
  assert.deepEqual(decodeBridgeMessage(greetingFrame.payload).payload, Buffer.concat([Buffer.from('BZFS0221', 'ascii'), Buffer.from([7])]));
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Queued UDP payload was not released after BZFS validation')), 1000);
    const check = (): void => {
      if (receivedUdp.some((packet: Buffer) => Buffer.compare(packet, queuedPacket) === 0)) {
        clearTimeout(deadline);
        resolve();
        return;
      }
      setTimeout(check, 10).unref?.();
    };
    check();
  });
  connection.connection.end(maskedWebSocketFrame(Buffer.alloc(0), 8));
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
