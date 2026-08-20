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
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { RemoteInfo, Socket as DatagramSocket } from 'node:dgram';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const GATEWAY_VERSION = '0.1.1';
export const DEFAULT_BZFLAG_VERSION = '2.4.31';
export const DEFAULT_BZFLAG_PROTOCOL = '0221';
export const BZFLAG_CONNECT_HEADER = Buffer.from('BZFLAG\r\n\r\n', 'ascii');
const BZFS_GREETING_BYTES = 9;
const BZFS_NO_PLAYER = 255;
export const BRIDGE_MAGIC = Buffer.from('BZWB', 'ascii');
export const BRIDGE_VERSION = 1;
export const CHANNEL_TCP = 0;
export const CHANNEL_UDP = 1;
export const WEBSOCKET_SUBPROTOCOL = 'bzflag-web-v1';
const TOKEN_SUBPROTOCOL_PREFIX = 'bzflag-token.';
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
// BZFlag 2.4.31's Protocol.h defines MaxUDPPacketLen as 68 bytes, including
// the four-byte length/code header. Keep UDP datagrams intact and reject larger
// payloads before they reach the allowlisted server.
const DEFAULT_MAX_UDP_BYTES = 68;
const INDEX_HTML_PATHS = [
  fileURLToPath(new URL('./index.html', import.meta.url)),
  fileURLToPath(new URL('../index.html', import.meta.url)),
];

type BridgeChannel = typeof CHANNEL_TCP | typeof CHANNEL_UDP;

interface ServerTarget {
  id: string;
  host: string;
  port: number;
  udpPort: number;
  kind: 'official' | 'custom';
  enabled: boolean;
  protocolVersion: string;
  bzflagVersion: string;
  label: string;
}

interface GatewayLimits {
  maxFrameBytes: number;
  maxBufferedBytes: number;
  maxMessagesPerSecond: number;
  maxBytesPerSecond: number;
  maxSessions: number;
  maxSessionsPerIp: number;
  idleTimeoutMs: number;
  handshakeTimeoutMs: number;
  parserTimeoutMs: number;
  maxFramesPerSecond: number;
  maxControlFramesPerSecond: number;
  maxContinuationFrames: number;
  maxContinuationBytes: number;
  targetHandshakeTimeoutMs: number;
}

interface TlsConfig {
  keyFile?: string;
  certFile?: string;
}

interface GatewayConfig {
  host: string;
  port: number;
  bridgePath: string;
  healthPath: string;
  allowedOrigins: string[];
  allowCustomServers: boolean;
  /**
   * Local integration-test escape hatch. Production configurations must keep
   * this false so a DNS answer cannot turn the bridge into an internal proxy.
   */
  allowPrivateAddresses: boolean;
  /**
   * Temporary compatibility switch for pre-subprotocol browser clients.
   * Production deployments should disable query-string bearer tokens after
   * all clients have moved to the WebSocket subprotocol transport.
   */
  allowLegacyQueryToken: boolean;
  protocolVersion: string;
  bzflagVersion: string;
  servers: ServerTarget[];
  limits: GatewayLimits;
  trustProxy: boolean;
  trustedProxyPeers: string[];
  sessionToken?: string;
  tls?: TlsConfig | null;
  configPath?: string | null;
}

interface BridgeMessage {
  channel: BridgeChannel;
  payload: Buffer;
  legacy: boolean;
}

interface Gateway {
  config: GatewayConfig;
  server: ReturnType<typeof createHttpServer>;
  sessions: Set<GatewaySession>;
  sessionsByIp: Map<string, number>;
  heartbeat: ReturnType<typeof setInterval> | null;
  incrementIp(ip: string): void;
  decrementIp(ip: string): void;
  findServer(id: string): ServerTarget | null;
  health(): Record<string, string | number>;
  start(): Promise<AddressInfo>;
  stop(): Promise<void>;
}

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

export const DEFAULT_CONFIG: Omit<GatewayConfig, 'sessionToken' | 'tls' | 'configPath'> = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  bridgePath: '/bridge',
  healthPath: '/healthz',
  allowedOrigins: ['http://localhost', 'http://127.0.0.1'],
  allowCustomServers: false,
  allowPrivateAddresses: false,
  allowLegacyQueryToken: true,
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
    handshakeTimeoutMs: 10 * 1000,
    parserTimeoutMs: 30 * 1000,
    maxFramesPerSecond: 240,
    maxControlFramesPerSecond: 60,
    maxContinuationFrames: 16,
    maxContinuationBytes: DEFAULT_MAX_FRAME_BYTES,
    targetHandshakeTimeoutMs: 10 * 1000,
  },
  trustProxy: false,
  trustedProxyPeers: [],
});

function cloneDefaultConfig(): GatewayConfig {
  return {
    ...DEFAULT_CONFIG,
    allowedOrigins: [...DEFAULT_CONFIG.allowedOrigins],
    servers: [],
    limits: { ...DEFAULT_CONFIG.limits },
    trustedProxyPeers: [],
  };
}

function readJsonFile(path: string): Record<string, any> {
  if (!path) {
    return {};
  }
  if (!existsSync(path)) {
    throw new Error(`Configuration file does not exist: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: any) {
    throw new Error(`Unable to parse configuration file ${path}: ${error.message}`);
  }
}

function asPositiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeOrigins(origins: unknown): string[] {
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

function normalizeProxyPeers(peers: unknown): string[] {
  if (peers === undefined || peers === null) return [];
  if (!Array.isArray(peers)) throw new Error('trustedProxyPeers must be an array of IP addresses');
  return peers.map((peer) => {
    if (typeof peer !== 'string' || isIP(peer.trim()) === 0) {
      throw new Error(`trustedProxyPeers entries must be IP addresses: ${peer}`);
    }
    return peer.trim();
  });
}

const IPV4_BLOCKED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0x00ffffff], // unspecified and current network
  [0x0a000000, 0x0affffff], // RFC 1918
  [0x64400000, 0x647fffff], // RFC 6598 shared address space
  [0x7f000000, 0x7fffffff], // loopback
  [0xa9fe0000, 0xa9feffff], // link-local
  [0xc0000000, 0xc00000ff], // IETF protocol assignments
  [0xc0000200, 0xc00002ff], // TEST-NET-1
  [0xc0586300, 0xc05863ff], // 6to4 anycast
  [0xc0a80000, 0xc0a8ffff], // RFC 1918
  [0xc6120000, 0xc613ffff], // benchmarking
  [0xc6336400, 0xc63364ff], // TEST-NET-2
  [0xcb007100, 0xcb0071ff], // TEST-NET-3
  [0xe0000000, 0xffffffff], // multicast and reserved
];

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256) + octets[3];
}

function parseIpv6(address: string): number[] | null {
  if (address.includes('%')) return null;
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const embedded = separator >= 0 ? parseIpv4(value.slice(separator + 1)) : null;
    if (embedded === null) return null;
    const high = Math.floor(embedded / 0x10000).toString(16);
    const low = (embedded % 0x10000).toString(16);
    value = `${value.slice(0, separator + 1)}${high}:${low}`;
  }
  const compressionIndex = value.indexOf('::');
  if (compressionIndex >= 0 && value.indexOf('::', compressionIndex + 2) >= 0) return null;
  const leftText = compressionIndex >= 0 ? value.slice(0, compressionIndex) : value;
  const rightText = compressionIndex >= 0 ? value.slice(compressionIndex + 2) : '';
  const parseGroups = (text: string): number[] => {
    if (!text) return [];
    const groups = text.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return [];
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const left = parseGroups(leftText);
  const right = parseGroups(rightText);
  if (left.length + right.length > 8) return null;
  if (compressionIndex < 0 && left.length !== 8) return null;
  const groups = compressionIndex >= 0
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
    : left;
  return groups.length === 8 ? groups : null;
}

function isIpv4Blocked(address: string): boolean {
  const value = parseIpv4(address);
  return value === null || IPV4_BLOCKED_RANGES.some(([start, end]) => value >= start && value <= end);
}

function isIpv6Blocked(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return true; // RFC 4193 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // RFC 4291 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return true; // documentation
  // IPv4-mapped, IPv4-compatible and NAT64 forms must not bypass the IPv4
  // policy by being represented as IPv6.
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isCompatible = groups.slice(0, 6).every((group) => group === 0);
  const isNat64 = groups[0] === 0x0064 && groups[1] === 0xff9b;
  if (isMapped || isCompatible || isNat64) {
    const embedded = ((groups[6] * 0x10000) + groups[7]);
    const ipv4 = `${embedded >>> 24}.${(embedded >>> 16) & 0xff}.${(embedded >>> 8) & 0xff}.${embedded & 0xff}`;
    return isIpv4Blocked(ipv4);
  }
  return false;
}

/** Return true only for an address that is suitable for an official target. */
export function isPublicTargetAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isIpv4Blocked(address);
  if (family === 6) return !isIpv6Blocked(address);
  return false;
}

function isBlockedTargetHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'ip6-localhost'
    || normalized === 'metadata'
    || normalized === 'metadata.google.internal'
    || normalized.endsWith('.metadata.google.internal')
    || normalized === 'instance-data.ec2.internal'
    || normalized.endsWith('.instance-data.ec2.internal');
}

interface ResolvedTargetAddress {
  address: string;
  family: 4 | 6;
}

async function resolveTargetAddress(host: string, allowPrivateAddresses: boolean): Promise<ResolvedTargetAddress> {
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (!allowPrivateAddresses && !isPublicTargetAddress(host)) {
      throw new Error('Target address is not publicly routable');
    }
    return { address: host, family: literalFamily as 4 | 6 };
  }
  if (isBlockedTargetHostname(host) && !allowPrivateAddresses) {
    throw new Error('Target hostname is reserved for local or metadata services');
  }
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (error: any) {
    throw new Error(`Target hostname resolution failed: ${error.code || 'DNS_ERROR'}`);
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('Target hostname has no address records');
  const addresses = records.map((record) => ({
    address: String(record.address),
    family: Number(record.family) as 4 | 6,
  }));
  if (addresses.some((record) => (record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family)) {
    throw new Error('Target hostname returned an invalid address');
  }
  // Reject the complete DNS answer if any record is private. This is stricter
  // than selecting a public record and prevents a rebinding/load-balancer
  // answer from using the bridge as a path into the local network.
  if (!allowPrivateAddresses && addresses.some((record) => !isPublicTargetAddress(record.address))) {
    throw new Error('Target hostname resolved to a non-public address');
  }
  return addresses[0];
}

function normalizeServer(server: any, index: number, allowPrivateAddresses = false): ServerTarget {
  if (!server || typeof server !== 'object') {
    throw new Error(`servers[${index}] must be an object`);
  }
  const id = String(server.id ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw new Error(`servers[${index}].id must contain only letters, numbers, dot, underscore, or dash`);
  }
  const host = String(server.host ?? '').trim();
  if (!host || host.length > 253 || /[\s/%]/.test(host)) {
    throw new Error(`servers[${index}].host must be a DNS name or IP address`);
  }
  if (isIP(host) !== 0 && !allowPrivateAddresses && !isPublicTargetAddress(host)) {
    throw new Error(`servers[${index}].host must be publicly routable`);
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
  const protocolVersion = String(server.protocolVersion ?? DEFAULT_BZFLAG_PROTOCOL);
  if (!/^\d{4}$/.test(protocolVersion)) {
    throw new Error(`servers[${index}].protocolVersion must contain exactly four digits`);
  }
  return Object.freeze({
    id,
    host,
    port,
    udpPort,
    kind,
    enabled: server.enabled !== false,
    protocolVersion,
    bzflagVersion: String(server.bzflagVersion ?? DEFAULT_BZFLAG_VERSION),
    label: String(server.label ?? id).slice(0, 120),
  });
}

export function normalizeConfig(input: Record<string, any> = {}): GatewayConfig {
  const defaults = cloneDefaultConfig();
  const source: Record<string, any> = input && typeof input === 'object' ? input : {};
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
  config.allowPrivateAddresses = config.allowPrivateAddresses === true;
  config.allowLegacyQueryToken = config.allowLegacyQueryToken !== false;
  config.trustProxy = config.trustProxy === true;
  config.trustedProxyPeers = normalizeProxyPeers(config.trustedProxyPeers);
  if (config.trustProxy && config.trustedProxyPeers.length === 0) {
    throw new Error('trustProxy requires at least one trustedProxyPeers IP address');
  }
  config.protocolVersion = String(config.protocolVersion || DEFAULT_BZFLAG_PROTOCOL);
  config.bzflagVersion = String(config.bzflagVersion || DEFAULT_BZFLAG_VERSION);
  if (!Array.isArray(config.servers)) {
    throw new Error('servers must be an array');
  }
  config.servers = config.servers.map((server, index) => normalizeServer(server, index, config.allowPrivateAddresses));
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
    handshakeTimeoutMs: asPositiveInteger(limits.handshakeTimeoutMs, 10 * 1000, 'limits.handshakeTimeoutMs'),
    parserTimeoutMs: asPositiveInteger(limits.parserTimeoutMs, 30 * 1000, 'limits.parserTimeoutMs'),
    maxFramesPerSecond: asPositiveInteger(limits.maxFramesPerSecond, 240, 'limits.maxFramesPerSecond'),
    maxControlFramesPerSecond: asPositiveInteger(limits.maxControlFramesPerSecond, 60, 'limits.maxControlFramesPerSecond'),
    maxContinuationFrames: asPositiveInteger(limits.maxContinuationFrames, 16, 'limits.maxContinuationFrames'),
    maxContinuationBytes: asPositiveInteger(limits.maxContinuationBytes, DEFAULT_MAX_FRAME_BYTES, 'limits.maxContinuationBytes'),
    targetHandshakeTimeoutMs: asPositiveInteger(limits.targetHandshakeTimeoutMs, 10 * 1000, 'limits.targetHandshakeTimeoutMs'),
  };
  if (config.limits.maxFrameBytes < 1024) {
    throw new Error('limits.maxFrameBytes must be at least 1024');
  }
  if (config.limits.maxSessionsPerIp > config.limits.maxSessions) {
    config.limits.maxSessionsPerIp = config.limits.maxSessions;
  }
  if (config.limits.maxContinuationBytes > config.limits.maxFrameBytes) {
    config.limits.maxContinuationBytes = config.limits.maxFrameBytes;
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

export function loadConfig({ path = process.env.BZFLAG_WEB_CONFIG || 'config.json', env = process.env }: { path?: string; env?: NodeJS.ProcessEnv } = {}): GatewayConfig {
  const fileConfig = path && existsSync(path) ? readJsonFile(path) : {};
  const input = { ...fileConfig };
  if (env.BZFLAG_WEB_HOST) input.host = env.BZFLAG_WEB_HOST;
  if (env.BZFLAG_WEB_PORT) input.port = env.BZFLAG_WEB_PORT;
  if (env.BZFLAG_WEB_SESSION_TOKEN) input.sessionToken = env.BZFLAG_WEB_SESSION_TOKEN;
  if (env.BZFLAG_WEB_ALLOWED_ORIGINS) {
    input.allowedOrigins = env.BZFLAG_WEB_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  if (env.BZFLAG_WEB_ALLOW_CUSTOM_SERVERS === 'true') input.allowCustomServers = true;
  if (env.BZFLAG_WEB_ALLOW_LEGACY_QUERY_TOKEN === 'false') input.allowLegacyQueryToken = false;
  if (env.BZFLAG_WEB_ALLOW_LEGACY_QUERY_TOKEN === 'true') input.allowLegacyQueryToken = true;
  if (env.BZFLAG_WEB_TRUST_PROXY === 'true') input.trustProxy = true;
  const config = normalizeConfig(input);
  config.configPath = path && existsSync(path) ? path : null;
  return config;
}

function tokenMatches(expected: string | undefined, received: string): boolean {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function parseWebSocketProtocols(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => typeof entry === 'string'
    ? entry.split(',').map((protocol) => protocol.trim()).filter(Boolean)
    : []);
}

function decodeTokenSubprotocol(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,704}$/.test(value)) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64url');
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > 512) return null;
  if (decoded.toString('base64url') !== value) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    return text.length > 0 && text.length <= 512 ? text : null;
  } catch {
    return null;
  }
}

function subprotocolTokenMatches(protocols: string[], expected: string | undefined): boolean {
  const tokenProtocols = protocols.filter((protocol) => protocol.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
  if (tokenProtocols.length !== 1) return false;
  const value = tokenProtocols[0].slice(TOKEN_SUBPROTOCOL_PREFIX.length);
  // Accept a raw token as well as the canonical base64url form during the
  // migration. The browser client always emits the canonical encoded form.
  return tokenMatches(expected, value) || tokenMatches(expected, decodeTokenSubprotocol(value) || '');
}

export function isOriginAllowed(origin: unknown, allowedOrigins: string[]): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}

export function encodeBridgeMessage(channel: BridgeChannel, payload: Buffer | Uint8Array | string, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
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

export function decodeBridgeMessage(input: Buffer | Uint8Array | string, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): BridgeMessage {
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

function splitBuffer(buffer: Buffer, size: number): Buffer[] {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  }
  return chunks;
}

function websocketFrame(payload: Buffer | Uint8Array | string, opcode = 2): Buffer {
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

function websocketCloseFrame(code: number, reason = ''): Buffer {
  const reasonBuffer = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const body = Buffer.allocUnsafe(2 + reasonBuffer.length);
  body.writeUInt16BE(code, 0);
  reasonBuffer.copy(body, 2);
  return websocketFrame(body, 8);
}

class FrameBudget {
  private readonly maxFramesPerSecond: number;
  private readonly maxControlFramesPerSecond: number;
  private windowStarted: number;
  private frames: number;
  private controlFrames: number;

  constructor(maxFramesPerSecond: number, maxControlFramesPerSecond: number) {
    this.maxFramesPerSecond = maxFramesPerSecond;
    this.maxControlFramesPerSecond = maxControlFramesPerSecond;
    this.windowStarted = Date.now();
    this.frames = 0;
    this.controlFrames = 0;
  }

  consume(control: boolean): void {
    const now = Date.now();
    if (now - this.windowStarted >= 1000) {
      this.windowStarted = now;
      this.frames = 0;
      this.controlFrames = 0;
    }
    if (this.frames + 1 > this.maxFramesPerSecond) {
      const error: Error & { code?: string } = new Error('WebSocket frame rate limit exceeded');
      error.code = 'WS_BUDGET';
      throw error;
    }
    if (control && this.controlFrames + 1 > this.maxControlFramesPerSecond) {
      const error: Error & { code?: string } = new Error('WebSocket control-frame rate limit exceeded');
      error.code = 'WS_BUDGET';
      throw error;
    }
    this.frames += 1;
    if (control) this.controlFrames += 1;
  }
}

export class WebSocketConnection {
  private readonly socket: Socket;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly parserTimeoutMs: number;
  private readonly maxContinuationFrames: number;
  private readonly maxContinuationBytes: number;
  private readonly frameBudget: FrameBudget;
  onMessage: ((payload: Buffer) => void) | null;
  onClose: (() => void) | null;
  private buffer: Buffer;
  private fragmentBuffer: Buffer | null;
  private fragmentFrames: number;
  private fragmentBytes: number;
  private parserTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  private closeSent: boolean;
  private lastActivity: number;

  constructor(socket: Socket, {
    maxFrameBytes,
    maxBufferedBytes,
    parserTimeoutMs = 30 * 1000,
    idleTimeoutMs = 15 * 60 * 1000,
    maxFramesPerSecond = 240,
    maxControlFramesPerSecond = 60,
    maxContinuationFrames = 16,
    maxContinuationBytes = maxFrameBytes,
    onMessage,
    onClose,
  }: {
    maxFrameBytes: number;
    maxBufferedBytes: number;
    parserTimeoutMs?: number;
    idleTimeoutMs?: number;
    maxFramesPerSecond?: number;
    maxControlFramesPerSecond?: number;
    maxContinuationFrames?: number;
    maxContinuationBytes?: number;
    onMessage: ((payload: Buffer) => void) | null;
    onClose: (() => void) | null;
  }) {
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;
    this.maxBufferedBytes = maxBufferedBytes;
    this.parserTimeoutMs = parserTimeoutMs;
    this.maxContinuationFrames = maxContinuationFrames;
    this.maxContinuationBytes = maxContinuationBytes;
    this.frameBudget = new FrameBudget(maxFramesPerSecond, maxControlFramesPerSecond);
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.fragmentBuffer = null;
    this.fragmentFrames = 0;
    this.fragmentBytes = 0;
    this.parserTimer = null;
    this.closed = false;
    this.closeSent = false;
    this.lastActivity = Date.now();
    // This is a real socket-level idle timeout. The parser deadline below is
    // separate and is not extended by a client that drips one partial frame.
    socket.setTimeout(idleTimeoutMs, () => this.close(1001, 'Idle timeout'));
    socket.on('data', (chunk: Buffer | string) => this.#onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('error', () => this.#finish());
    socket.on('close', () => this.#finish());
    socket.on('timeout', () => this.close(1001, 'Idle timeout'));
  }

  #onData(chunk: Buffer): void {
    if (this.closed) return;
    this.lastActivity = Date.now();
    const parserBufferLimit = this.maxFrameBytes + 14;
    if (this.parserTimer && this.buffer.length + chunk.length > parserBufferLimit) {
      this.close(1009, 'WebSocket parser buffer exceeds the configured limit');
      return;
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      const waitingForFrame = this.#parseFrames();
      // A waiting parser can contain at most one frame header, mask, and the
      // configured payload. Keep that invariant explicit so a malformed or
      // unexpectedly coalesced partial input cannot grow without a bound.
      if (waitingForFrame && this.buffer.length > parserBufferLimit) {
        const error: Error & { code?: string } = new Error('WebSocket parser buffer exceeds the configured limit');
        error.code = 'WS_TOO_LARGE';
        throw error;
      }
      this.#setParserDeadline(waitingForFrame);
    } catch (error: any) {
      const closeCode = error.code === 'WS_TOO_LARGE' ? 1009 : error.code === 'WS_BUDGET' ? 1008 : 1002;
      this.close(closeCode, error.message);
    }
  }

  #setParserDeadline(waitingForFrame: boolean): void {
    if (this.closed || !waitingForFrame) {
      if (this.parserTimer) clearTimeout(this.parserTimer);
      this.parserTimer = null;
      return;
    }
    if (this.parserTimer) return;
    this.parserTimer = setTimeout(() => {
      this.parserTimer = null;
      this.close(1002, 'WebSocket parser deadline exceeded');
    }, this.parserTimeoutMs);
  }

  #parseFrames(): boolean {
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
        if (this.buffer.length < 4) return true;
        length = this.buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return true;
        const extendedLength = this.buffer.readBigUInt64BE(2);
        if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame length is too large');
        length = Number(extendedLength);
        headerLength = 10;
      }
      if (length > this.maxFrameBytes) {
        const error: Error & { code?: string } = new Error('WebSocket frame exceeds the configured limit');
        error.code = 'WS_TOO_LARGE';
        throw error;
      }
      const control = opcode >= 8;
      if (control && (!fin || length > 125)) throw new Error('Invalid WebSocket control frame');
      const frameLength = headerLength + 4 + length;
      if (this.buffer.length < frameLength) return true;
      const mask = this.buffer.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(this.buffer.subarray(headerLength + 4, frameLength));
      this.buffer = this.buffer.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      this.frameBudget.consume(control);
      this.#handleFrame(opcode, fin, payload);
    }
    return this.buffer.length > 0;
  }

  #handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
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
        this.onMessage?.(payload);
      } else {
        this.fragmentBuffer = payload;
        this.fragmentFrames = 0;
        this.fragmentBytes = payload.length;
        this.#checkContinuationBytes();
      }
      return;
    }
    if (opcode === 0x0) {
      if (this.fragmentBuffer === null) throw new Error('Unexpected WebSocket continuation frame');
      this.fragmentFrames += 1;
      this.fragmentBytes += payload.length;
      this.#checkContinuationBudget();
      this.fragmentBuffer = Buffer.concat([this.fragmentBuffer, payload]);
      if (fin) {
        const completeMessage = this.fragmentBuffer;
        this.fragmentBuffer = null;
        this.fragmentFrames = 0;
        this.fragmentBytes = 0;
        this.onMessage?.(completeMessage);
      }
      return;
    }
    throw new Error(`Unsupported WebSocket opcode: ${opcode}`);
  }

  #checkContinuationBudget(): void {
    if (this.fragmentFrames > this.maxContinuationFrames) {
      const error: Error & { code?: string } = new Error('WebSocket continuation-frame budget exceeded');
      error.code = 'WS_BUDGET';
      throw error;
    }
    this.#checkContinuationBytes();
  }

  #checkContinuationBytes(): void {
    if (this.fragmentBytes > this.maxContinuationBytes || this.fragmentBytes > this.maxFrameBytes) {
      const error: Error & { code?: string } = new Error('Fragmented WebSocket message exceeds the configured limit');
      error.code = 'WS_TOO_LARGE';
      throw error;
    }
  }

  sendBinary(payload: Buffer): boolean {
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

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.closeSent && this.socket.writable) {
      this.closeSent = true;
      this.socket.write(websocketCloseFrame(code, reason));
    }
    this.socket.end();
    this.#finish();
  }

  #finish(): void {
    if (this.parserTimer) clearTimeout(this.parserTimer);
    this.parserTimer = null;
    if (!this.closed) this.closed = true;
    if (this.onClose) {
      const callback = this.onClose;
      this.onClose = null;
      callback();
    }
  }
}

class RateLimiter {
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private windowStarted: number;
  private messages: number;
  private bytes: number;

  constructor(maxMessages: number, maxBytes: number) {
    this.maxMessages = maxMessages;
    this.maxBytes = maxBytes;
    this.windowStarted = Date.now();
    this.messages = 0;
    this.bytes = 0;
  }

  consume(bytes: number): boolean {
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
  private readonly gateway: Gateway;
  private readonly ws: WebSocketConnection;
  private readonly target: ServerTarget;
  private readonly clientIp: string;
  private tcp: Socket | null;
  private udp: DatagramSocket | null;
  private targetEndpoint: ResolvedTargetAddress | null;
  private connecting: boolean;
  private udpReady: boolean;
  private targetHandshakeVerified: boolean;
  private targetHandshakeBuffer: Buffer;
  private targetHandshakeTimer: ReturnType<typeof setTimeout> | null;
  private pendingMessages: BridgeMessage[];
  private pendingBytes: number;
  private closed: boolean;
  private lastActivity: number;
  private readonly inboundLimiter: RateLimiter;
  private readonly outboundLimiter: RateLimiter;

  constructor(gateway: Gateway, ws: WebSocketConnection, target: ServerTarget, clientIp: string) {
    this.gateway = gateway;
    this.ws = ws;
    this.target = target;
    this.clientIp = clientIp;
    this.tcp = null;
    this.udp = null;
    this.targetEndpoint = null;
    this.connecting = true;
    this.udpReady = false;
    this.targetHandshakeVerified = false;
    this.targetHandshakeBuffer = Buffer.alloc(0);
    this.targetHandshakeTimer = null;
    this.pendingMessages = [];
    this.pendingBytes = 0;
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
    this.ws.onMessage = (payload: Buffer) => this.#handleClientMessage(payload);
    this.ws.onClose = () => this.close('websocket closed');
    gateway.sessions.add(this);
    gateway.incrementIp(clientIp);
    void this.#connect();
  }

  async #connect(): Promise<void> {
    try {
      // The deadline covers DNS resolution, TCP establishment, and the
      // complete BZFS identity greeting. It is cleared only after validation.
      this.targetHandshakeTimer = setTimeout(() => {
        this.#fail('Target did not complete the BZFS handshake before the deadline', 1003);
      }, this.gateway.config.limits.targetHandshakeTimeoutMs);
      // Resolve once and connect to the selected literal address. Passing the
      // literal to both transports pins the DNS answer for this session and
      // avoids a second lookup that could be changed by DNS rebinding.
      const endpoint = await resolveTargetAddress(this.target.host, this.gateway.config.allowPrivateAddresses);
      if (this.closed) return;
      this.targetEndpoint = endpoint;
      this.tcp = createConnection({ host: endpoint.address, port: this.target.port, family: endpoint.family });
      this.tcp.setNoDelay(true);
      this.tcp.setTimeout(this.gateway.config.limits.idleTimeoutMs, () => this.close('TCP idle timeout'));
      this.tcp.on('connect', () => {
        this.lastActivity = Date.now();
        this.tcp?.write(BZFLAG_CONNECT_HEADER);
      });
      this.tcp.on('data', (data: Buffer) => this.#handleTargetTcpData(data));
      this.tcp.on('error', (error: NodeJS.ErrnoException) => this.#fail(`TCP connection error: ${error.code || 'error'}`));
      this.tcp.on('close', () => {
        if (!this.closed) this.close('TCP connection closed');
      });

    } catch (error: any) {
      this.#fail(`Target connection setup failed: ${error.code || 'error'}`);
    }
  }

  #openUdpAfterHandshake(): void {
    if (this.closed || !this.targetHandshakeVerified || this.udp || !this.targetEndpoint) return;
    const endpoint = this.targetEndpoint;
    this.udp = createSocket(endpoint.family === 6 ? 'udp6' : 'udp4');
    this.udp.on('message', (data: Buffer, _remote: RemoteInfo) => this.#sendTargetData(CHANNEL_UDP, data));
    this.udp.on('error', (error: NodeJS.ErrnoException) => this.#fail(`UDP connection error: ${error.code || 'error'}`));
    this.udp.connect(this.target.udpPort, endpoint.address, () => {
      this.lastActivity = Date.now();
      this.udpReady = true;
      this.#maybeReady();
    });
  }

  #handleTargetTcpData(data: Buffer): void {
    if (this.closed) return;
    if (this.targetHandshakeVerified) {
      this.#sendTargetData(CHANNEL_TCP, data);
      return;
    }
    const expected = Buffer.from(`BZFS${this.target.protocolVersion}`, 'ascii');
    const required = BZFS_GREETING_BYTES - this.targetHandshakeBuffer.length;
    if (required > 0) {
      const prefix = data.subarray(0, required);
      this.targetHandshakeBuffer = Buffer.concat([this.targetHandshakeBuffer, prefix]);
      const prefixLength = Math.min(expected.length, this.targetHandshakeBuffer.length);
      if (!expected.subarray(0, prefixLength).equals(this.targetHandshakeBuffer.subarray(0, prefixLength))) {
        this.#fail('Target is not an allowed BZFS server', 1003);
        return;
      }
      data = data.subarray(prefix.length);
      if (this.targetHandshakeBuffer.length < BZFS_GREETING_BYTES) return;
    }
    const greeting = this.targetHandshakeBuffer;
    if (!greeting.subarray(0, expected.length).equals(expected)) {
      this.#fail('Target is not an allowed BZFS server', 1003);
      return;
    }
    if (greeting[8] === BZFS_NO_PLAYER) {
      this.#fail('Target BZFS server refused the player slot', 1003);
      return;
    }
    this.targetHandshakeVerified = true;
    this.targetHandshakeBuffer = Buffer.alloc(0);
    if (this.targetHandshakeTimer) {
      clearTimeout(this.targetHandshakeTimer);
      this.targetHandshakeTimer = null;
    }
    // Do not create or connect an outbound UDP socket until the same target
    // has proved its BZFS identity over TCP.
    this.#openUdpAfterHandshake();
    // Forward only the validated BZFS greeting and any bytes coalesced after it.
    this.#sendTargetData(CHANNEL_TCP, greeting);
    if (data.length > 0) this.#sendTargetData(CHANNEL_TCP, data);
    this.#maybeReady();
  }

  #maybeReady(): void {
    if (this.closed || this.connecting === false || !this.targetHandshakeVerified || !this.udpReady) return;
    this.connecting = false;
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    this.pendingBytes = 0;
    for (const message of pending) this.#forwardMessage(message);
  }

  #handleClientMessage(payload: Buffer): void {
    if (this.closed) return;
    this.lastActivity = Date.now();
    if (!this.inboundLimiter.consume(payload.length)) {
      this.#fail('Inbound rate limit exceeded', 1008);
      return;
    }
    let message;
    try {
      message = decodeBridgeMessage(payload, this.gateway.config.limits.maxFrameBytes);
    } catch (error: any) {
      this.#fail(error.message, 1003);
      return;
    }
    if (message.channel === CHANNEL_UDP && message.payload.length > DEFAULT_MAX_UDP_BYTES) {
      this.#fail('UDP datagram exceeds the protocol limit', 1009);
      return;
    }
    if (this.connecting) {
      if (this.pendingBytes + message.payload.length > this.gateway.config.limits.maxBufferedBytes) {
        return this.#fail('Target connection setup buffer is full', 1013);
      }
      this.pendingMessages.push(message);
      this.pendingBytes += message.payload.length;
      return;
    }
    this.#forwardMessage(message);
  }

  #forwardMessage(message: BridgeMessage): void {
    if (this.closed) return;
    if (message.channel === CHANNEL_TCP) {
      if (!this.tcp || this.tcp.destroyed || !this.tcp.writable) return this.#fail('TCP connection is unavailable');
      if (this.tcp.writableLength + message.payload.length > this.gateway.config.limits.maxBufferedBytes) {
        return this.#fail('TCP send buffer is full', 1013);
      }
      try {
        this.tcp.write(message.payload);
      } catch {
        this.#fail('TCP write failed');
      }
    } else {
      if (!this.udp) return this.#fail('UDP connection is unavailable');
      try {
        this.udp.send(message.payload);
      } catch {
        this.#fail('UDP write failed');
      }
    }
  }

  #sendTargetData(channel: BridgeChannel, data: Buffer): void {
    if (this.closed) return;
    // UDP can become readable before the TCP identity preflight completes.
    // Never expose datagrams from an unverified endpoint to the browser: the
    // target is relay-eligible only after its BZFS greeting has been checked.
    if (channel === CHANNEL_UDP && !this.targetHandshakeVerified) return;
    this.lastActivity = Date.now();
    if (channel === CHANNEL_UDP && data.length > DEFAULT_MAX_UDP_BYTES) {
      return this.#fail('UDP datagram exceeds the protocol limit', 1009);
    }
    const chunkSize = Math.max(1, this.gateway.config.limits.maxFrameBytes - 8);
    for (const chunk of splitBuffer(data, chunkSize)) {
      const envelope = encodeBridgeMessage(channel, chunk, this.gateway.config.limits.maxFrameBytes);
      if (!this.outboundLimiter.consume(envelope.length)) {
        return this.#fail('Outbound rate limit exceeded', 1008);
      }
      if (!this.ws.sendBinary(envelope)) return;
    }
  }

  #fail(reason: string, code = 1011): void {
    if (this.closed) return;
    this.ws.close(code, reason);
    this.close(reason);
  }

  tick(now: number): void {
    if (!this.closed && now - this.lastActivity > this.gateway.config.limits.idleTimeoutMs) {
      this.#fail('Session idle timeout', 1001);
    }
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.connecting = false;
    this.udpReady = false;
    if (this.targetHandshakeTimer) {
      clearTimeout(this.targetHandshakeTimer);
      this.targetHandshakeTimer = null;
    }
    this.pendingMessages = [];
    this.pendingBytes = 0;
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

function canonicalizeIp(address: unknown): string {
  const candidate = typeof address === 'string' ? address.trim() : '';
  // Node can expose an IPv4 peer as an IPv4-mapped IPv6 address. Keep the
  // allowlist ergonomic without accepting hostnames or arbitrary strings.
  if (candidate.startsWith('::ffff:') && isIP(candidate) === 6 && isIP(candidate.slice(7)) === 4) {
    return candidate.slice(7);
  }
  return candidate;
}

function clientIpForRequest(request: IncomingMessage, config: GatewayConfig): string {
  const directPeer = canonicalizeIp(request.socket.remoteAddress) || 'unknown';
  if (!config.trustProxy || !config.trustedProxyPeers.includes(directPeer)) return directPeer;
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return directPeer;
  const firstForwarded = canonicalizeIp(forwarded.split(',')[0]);
  return isIP(firstForwarded) !== 0 ? firstForwarded : directPeer;
}

function writeHttpResponse(response: ServerResponse, statusCode: number, body: string, contentType = 'application/json; charset=utf-8'): void {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(body);
}

function rejectUpgrade(socket: Socket, statusCode: number, message: string): void {
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

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function hasUpgradeHeader(value: unknown): boolean {
  return typeof value === 'string' && value.split(',').some((part) => part.trim().toLowerCase() === 'upgrade');
}

function serveHome(response: ServerResponse): void {
  const indexPath = INDEX_HTML_PATHS.find((path) => existsSync(path));
  const body = indexPath
    ? readFileSync(indexPath, 'utf8')
    : '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BZFlag Web Gateway</title></head><body><h1>BZFlag Web Gateway</h1><p>The gateway is running. Open the web client and configure its bridge URL.</p></body></html>';
  writeHttpResponse(response, 200, body, 'text/html; charset=utf-8');
}

export function createGateway(inputConfig: Record<string, any> = {}): Gateway {
  const config = normalizeConfig(inputConfig);
  const tlsOptions = config.tls && config.tls.keyFile && config.tls.certFile
    ? { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile) }
    : null;
  const server = tlsOptions ? createHttpsServer(tlsOptions) : createHttpServer();
  // Node's HTTP parser enforces the header deadline, while the explicit
  // connection timer also covers a client that never completes an upgrade
  // request at all. Both timers are cleared as soon as headers are parsed.
  server.headersTimeout = config.limits.handshakeTimeoutMs;
  server.requestTimeout = config.limits.handshakeTimeoutMs;
  const handshakeTimers = new WeakMap<Socket, ReturnType<typeof setTimeout>>();
  const clearHandshakeDeadline = (socket: Socket): void => {
    const timer = handshakeTimers.get(socket);
    if (timer) clearTimeout(timer);
    handshakeTimers.delete(socket);
  };
  server.on('connection', (socket: Socket) => {
    const timer = setTimeout(() => socket.destroy(), config.limits.handshakeTimeoutMs);
    timer.unref?.();
    handshakeTimers.set(socket, timer);
    socket.once('close', () => clearHandshakeDeadline(socket));
  });
  const gateway: Gateway = {
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
    start(): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => {
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
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('Gateway listener address is unavailable'));
          resolve(address);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.config.port, this.config.host);
      });
    },
    stop(): Promise<void> {
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const session of [...this.sessions]) session.close('Gateway shutdown');
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
  };

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    clearHandshakeDeadline(request.socket);
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

  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    clearHandshakeDeadline(socket);
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
    const protocols = parseWebSocketProtocols(headers['sec-websocket-protocol']);
    const hasBridgeProtocol = protocols.includes(WEBSOCKET_SUBPROTOCOL);
    const hasTokenProtocol = protocols.some((protocol) => protocol.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
    const subprotocolAuthenticated = hasBridgeProtocol && subprotocolTokenMatches(protocols, config.sessionToken);
    const legacyAuthenticated = !hasTokenProtocol && config.allowLegacyQueryToken
      && tokenMatches(config.sessionToken, url.searchParams.get('token') || '');
    if (!subprotocolAuthenticated && !legacyAuthenticated) return rejectUpgrade(socket, 403, 'Invalid session token');
    const targetId = url.searchParams.get('server') || '';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(targetId)) return rejectUpgrade(socket, 400, 'A valid server id is required');
    const target = gateway.findServer(targetId);
    if (!target) return rejectUpgrade(socket, 403, 'Server is not allowlisted');
    if (target.kind === 'custom' && !config.allowCustomServers) return rejectUpgrade(socket, 403, 'Custom servers are disabled');
    const clientIp = clientIpForRequest(request, config);
    if (gateway.sessions.size >= config.limits.maxSessions) return rejectUpgrade(socket, 503, 'Gateway session limit reached');
    if ((gateway.sessionsByIp.get(clientIp) || 0) >= config.limits.maxSessionsPerIp) return rejectUpgrade(socket, 429, 'Client session limit reached');

    const accept = websocketAccept(headers['sec-websocket-key']);
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      ...(hasBridgeProtocol ? [`Sec-WebSocket-Protocol: ${WEBSOCKET_SUBPROTOCOL}`] : []),
      '',
      '',
    ].join('\r\n'));
    socket.setNoDelay(true);
    const ws = new WebSocketConnection(socket, {
      maxFrameBytes: config.limits.maxFrameBytes,
      maxBufferedBytes: config.limits.maxBufferedBytes,
      parserTimeoutMs: config.limits.parserTimeoutMs,
      idleTimeoutMs: config.limits.idleTimeoutMs,
      maxFramesPerSecond: config.limits.maxFramesPerSecond,
      maxControlFramesPerSecond: config.limits.maxControlFramesPerSecond,
      maxContinuationFrames: config.limits.maxContinuationFrames,
      maxContinuationBytes: config.limits.maxContinuationBytes,
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

function printStartup(config: GatewayConfig, address: AddressInfo): void {
  const protocol = config.tls ? 'https' : 'http';
  const tokenSource = process.env.BZFLAG_WEB_SESSION_TOKEN ? 'environment' : config.configPath ? 'configuration file' : 'generated at startup';
  console.log(`BZFlag Web Gateway ${GATEWAY_VERSION} listening on ${protocol}://${address.address}:${address.port}`);
  console.log(`Allowlisted servers: ${config.servers.filter((server) => server.enabled).map((server) => server.id).join(', ') || 'none'}`);
  console.log(`Session token source: ${tokenSource}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<Gateway> {
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
