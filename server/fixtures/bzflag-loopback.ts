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

import { createSocket } from 'node:dgram';
import { createServer as createTcpServer } from 'node:net';
import type { RemoteInfo, Socket as DatagramSocket } from 'node:dgram';
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net';

export interface BzFlagLoopbackFixture {
  tcpPort: number;
  udpPort: number;
  tcpServer: TcpServer;
  udpSocket: DatagramSocket;
  close(): Promise<void>;
}

function listenTcp(server: TcpServer): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function listenUdp(socket: DatagramSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      socket.off('error', onError);
      resolve(socket.address().port);
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(0, '127.0.0.1');
  });
}

function extractPackets(buffer: Buffer): { packets: Buffer[]; remainder: Buffer } {
  const packets: Buffer[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const payloadLength = buffer.readUInt16BE(offset);
    const packetLength = payloadLength + 4;
    if (packetLength > 1024 || buffer.length - offset < packetLength) break;
    packets.push(Buffer.from(buffer.subarray(offset, offset + packetLength)));
    offset += packetLength;
  }
  return { packets, remainder: buffer.subarray(offset) };
}

/**
 * Creates local TCP and UDP endpoints that speak the 2.4.x length-prefixed
 * packet format. TCP replies are deliberately split to prove that the gateway
 * preserves a byte stream across multiple WebSocket bridge messages.
 */
export async function createBzFlagLoopbackFixture(fragmentDelayMs = 10): Promise<BzFlagLoopbackFixture> {
  const connections = new Set<Socket>();
  const tcpServer = createTcpServer((socket: Socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    let tcpInput: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer | string) => {
      tcpInput = Buffer.concat([tcpInput, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const extracted = extractPackets(tcpInput);
      tcpInput = extracted.remainder;
      for (const packet of extracted.packets) {
        const splitAt = Math.min(2, packet.length);
        socket.write(packet.subarray(0, splitAt));
        setTimeout(() => {
          if (!socket.destroyed) socket.write(packet.subarray(splitAt));
        }, fragmentDelayMs).unref?.();
      }
    });
  });
  const tcpPort = await listenTcp(tcpServer);

  const udpSocket = createSocket('udp4');
  udpSocket.on('message', (data: Buffer, remote: RemoteInfo) => {
    udpSocket.send(data, remote.port, remote.address);
  });
  const udpPort = await listenUdp(udpSocket);

  return {
    tcpPort,
    udpPort,
    tcpServer,
    udpSocket,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => {
        if (!tcpServer.listening) return resolve();
        tcpServer.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        try {
          udpSocket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
