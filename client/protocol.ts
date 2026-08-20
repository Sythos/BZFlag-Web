// @ts-nocheck
/*
 * SPDX-License-Identifier: MIT
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

(() => {
  "use strict";

  // These values mirror BZFlag 2.4.31's include/Protocol.h and global.h.
  // The browser only ever sends packets through the gateway's binary envelope.
  const MAX_PACKET_BYTES = 1024;
  const MAX_PACKET_PAYLOAD_BYTES = MAX_PACKET_BYTES - 4;
  const MAX_STREAM_BYTES = 64 * 1024;
  const MAX_PACKETS_PER_PUSH = 256;
  const PACKET_HEADER_BYTES = 4;
  const MSG_ACCEPT = 0x6163;
  const MSG_ADMIN_INFO = 0x6169;
  const MSG_ALIVE = 0x616c;
  const MSG_ADD_PLAYER = 0x6170;
  const MSG_AUTO_PILOT = 0x6175;
  const MSG_CAPTURE_FLAG = 0x6366;
  const MSG_DROP_FLAG = 0x6466;
  const MSG_ENTER = 0x656e;
  const MSG_EXIT = 0x6578;
  const MSG_FLAG_UPDATE = 0x6675;
  const MSG_GRAB_FLAG = 0x6766;
  const MSG_GET_WORLD = 0x6777;
  const MSG_GAME_SETTINGS = 0x6773;
  const MSG_KILLED = 0x6b6c;
  const MSG_MESSAGE = 0x6d67;
  const MSG_NEW_RABBIT = 0x6e52;
  const MSG_NEGOTIATE_FLAGS = 0x6e66;
  const MSG_PAUSE = 0x7061;
  const MSG_PLAYER_UPDATE = 0x7075;
  const MSG_PLAYER_UPDATE_SMALL = 0x7073;
  const MSG_QUERY_GAME = 0x7167;
  const MSG_QUERY_PLAYERS = 0x7170;
  const MSG_REJECT = 0x726a;
  const MSG_REMOVE_PLAYER = 0x7270;
  const MSG_SHOT_BEGIN = 0x7362;
  const MSG_SHOT_END = 0x7365;
  const MSG_SUPER_KILL = 0x736b;
  const MSG_TELEPORT = 0x7470;
  const MSG_TRANSFER_FLAG = 0x7466;
  const MSG_TEAM_UPDATE = 0x7475;
  const MSG_UDP_LINK_REQUEST = 0x6f66;
  const MSG_UDP_LINK_ESTABLISHED = 0x6f67;
  const MSG_WANT_W_HASH = 0x7768;
  const MSG_WANT_SETTINGS = 0x7773;
  const CONNECT_HEADER_TEXT = "BZFLAG\r\n\r\n";
  const SERVER_VERSION_BYTES = 8;
  const SERVER_GREETING_BYTES = SERVER_VERSION_BYTES + 1;
  const DEFAULT_SERVER_VERSION = "BZFS0221";
  const MAX_WORLD_BYTES = 64 * 1024 * 1024;
  const TANK_PLAYER = 0;
  const SERVER_PLAYER = 253;
  const ADMIN_PLAYERS = 252;
  const FIRST_TEAM = 251;
  const ALL_PLAYERS = 254;
  const NO_PLAYER = 255;
  const TEAM_BY_NAME = Object.freeze({
    automatic: -2,
    noTeam: -1,
    rogue: 0,
    red: 1,
    green: 2,
    blue: 3,
    purple: 4,
    observer: 5,
    rabbit: 6,
    hunter: 7
  });
  const PLAYER_STATUS = Object.freeze({
    dead: 0,
    alive: 1 << 0,
    paused: 1 << 1,
    exploding: 1 << 2,
    teleporting: 1 << 3,
    flagActive: 1 << 4,
    crossingWall: 1 << 5,
    falling: 1 << 6,
    onDriver: 1 << 7,
    userInputs: 1 << 8,
    jumpJets: 1 << 9,
    playSound: 1 << 10
  });
  const CALLSIGN_BYTES = 32;
  const MOTTO_BYTES = 128;
  const TOKEN_BYTES = 22;
  const VERSION_BYTES = 60;
  const MESSAGE_BYTES = 128;
  const ENTER_PAYLOAD_BYTES = 1 + 4 + CALLSIGN_BYTES + MOTTO_BYTES + TOKEN_BYTES + VERSION_BYTES;
  // MsgAddPlayer includes the score triplet between team and callsign.
  const ADD_PLAYER_PAYLOAD_BYTES = 1 + 2 + 2 + 2 + 2 + 2 + CALLSIGN_BYTES + MOTTO_BYTES;
  const REMOVE_PLAYER_PAYLOAD_BYTES = 1;
  const ALIVE_PAYLOAD_BYTES = 1 + 12 + 4;
  const FLAG_PAYLOAD_BYTES = 55;
  const FLAG_UPDATE_HEADER_BYTES = 2;
  // A client-to-server MsgMessage contains only the destination and a fixed
  // message buffer.  A server-to-client message adds the source and message
  // type bytes to that payload.  Keep the two layouts distinct: using the
  // server layout for an outgoing packet sends one extra byte and is rejected
  // by native BZFS clients.
  const MESSAGE_OUTGOING_PAYLOAD_BYTES = 1 + MESSAGE_BYTES;
  const MESSAGE_SERVER_HEADER_BYTES = 3;
  const MESSAGE_PAYLOAD_BYTES = MESSAGE_SERVER_HEADER_BYTES + MESSAGE_BYTES;
  const SHOT_END_PAYLOAD_BYTES = 1 + 2 + 2;
  const CAPTURE_FLAG_PAYLOAD_BYTES = 2;
  const TRANSFER_FLAG_PAYLOAD_BYTES = 2;
  const TELEPORT_PAYLOAD_BYTES = 4;
  const BOOLEAN_PAYLOAD_BYTES = 1;
  const PLAYER_UPDATE_FIXED_BYTES = 4 + 1 + 4 + 2 + 12 + 12 + 4 + 4;
  const FIRE_PAYLOAD_BYTES = 4 + 1 + 2 + 12 + 12 + 4 + 2 + 2 + 4;
  const GAME_SETTINGS_PAYLOAD_BYTES = 30;
  const QUERY_GAME_PAYLOAD_BYTES = 44;
  const WORLD_OFFSET_BYTES = 4;
  const FLAG_ABBREVIATIONS = Object.freeze([
    "R*", "G*", "B*", "P*", "V", "QT", "OO", "F", "MG", "GM", "L", "R", "SB", "IB", "ST", "T", "N", "SH", "SR", "SW", "PZ", "G", "JP", "ID", "CL", "US", "MQ", "SE", "TH", "BU", "WG", "A", "RC", "CB", "O", "LT", "RT", "FO", "RO", "M", "B", "JM", "WA", "NJ", "TR", "BY"
  ]);
  const SMALL_SCALE = 32766;
  const SMALL_MAX_VELOCITY = 0.01 * SMALL_SCALE;
  const SMALL_MAX_ANGULAR_VELOCITY = 0.001 * SMALL_SCALE;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Expected an ArrayBuffer or Uint8Array");
  }

  function clamp(value, minimum, maximum, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function clampInteger(value, minimum, maximum, fallback = minimum) {
    return Math.trunc(clamp(value, minimum, maximum, fallback));
  }

  // Unlike the display/UI sanitizers above, wire-level input fields must not
  // silently turn an absent or malformed value into a real player/flag ID.
  // Returning null lets encodeInput suppress an unsafe command instead.
  function boundedInteger(value, minimum, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
  }

  function boundedPlayerId(value) {
    return boundedInteger(value, 0, NO_PLAYER - 1);
  }

  function resolveTeam(value) {
    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(TEAM_BY_NAME, value)) {
      return TEAM_BY_NAME[value];
    }
    return boundedInteger(value, TEAM_BY_NAME.automatic, TEAM_BY_NAME.hunter);
  }

  function hasVector(value) {
    return (Array.isArray(value) || ArrayBuffer.isView(value)) && value.length >= 3 &&
      Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1])) && Number.isFinite(Number(value[2]));
  }

  function vector(value, fallback = [0, 0, 0]) {
    const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value : fallback;
    return [
      clamp(source[0], -1_000_000, 1_000_000),
      clamp(source[1], -1_000_000, 1_000_000),
      clamp(source[2], -1_000_000, 1_000_000)
    ];
  }

  function writeVector(view, offset, value) {
    const values = vector(value);
    view.setFloat32(offset, values[0]);
    view.setFloat32(offset + 4, values[1]);
    view.setFloat32(offset + 8, values[2]);
    return offset + 12;
  }

  function writeFixedString(view, offset, length, value) {
    const bytes = encoder.encode(String(value || ""));
    const copyLength = Math.min(bytes.length, Math.max(0, length - 1));
    const target = new Uint8Array(view.buffer, view.byteOffset + offset, length);
    target.fill(0);
    target.set(bytes.subarray(0, copyLength));
  }

  function readFixedString(bytes, offset, length) {
    const end = Math.min(bytes.byteLength, offset + length);
    let zero = offset;
    while (zero < end && bytes[zero] !== 0) zero += 1;
    return decoder.decode(bytes.subarray(offset, zero));
  }

  function readVector(view, offset) {
    const values = [view.getFloat32(offset), view.getFloat32(offset + 4), view.getFloat32(offset + 8)];
    return values.every(Number.isFinite) ? { value: values, offset: offset + 12 } : null;
  }

  function readPacketFloat(view, offset) {
    const value = view.getFloat32(offset);
    return Number.isFinite(value) ? { value, offset: offset + 4 } : null;
  }

  function packetHasBytes(payload, offset, length) {
    return offset >= 0 && length >= 0 && offset + length <= payload.byteLength;
  }

  function encodePacket(code, payload = new Uint8Array()) {
    const body = toUint8Array(payload);
    if (!Number.isInteger(code) || code < 0 || code > 0xffff) {
      throw new RangeError("BZFlag packet code must be an unsigned 16-bit integer");
    }
    if (body.byteLength > MAX_PACKET_PAYLOAD_BYTES) {
      throw new RangeError("BZFlag packet payload exceeds the protocol limit");
    }
    const packet = new Uint8Array(PACKET_HEADER_BYTES + body.byteLength);
    const view = new DataView(packet.buffer);
    view.setUint16(0, body.byteLength);
    view.setUint16(2, code);
    packet.set(body, PACKET_HEADER_BYTES);
    return packet;
  }

  function readPacketCode(payload, maxPacketBytes = MAX_PACKET_BYTES) {
    let bytes;
    try {
      bytes = toUint8Array(payload);
    } catch {
      return null;
    }
    if (bytes.byteLength < PACKET_HEADER_BYTES) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint16(0);
    const packetBytes = PACKET_HEADER_BYTES + length;
    if (packetBytes > maxPacketBytes || packetBytes > bytes.byteLength) return null;
    return {
      length,
      code: view.getUint16(2),
      payload: bytes.slice(PACKET_HEADER_BYTES, packetBytes),
      bytes: packetBytes
    };
  }

  /**
   * Reassembles the length-prefixed BZFlag TCP stream. The Node gateway is a
   * byte bridge, so a WebSocket message is not guaranteed to equal one packet.
   */
  class PacketStream {
    constructor(options = {}) {
      this.maxBytes = clampInteger(options.maxBytes, MAX_PACKET_BYTES, MAX_STREAM_BYTES, MAX_STREAM_BYTES);
      this.maxPacketBytes = clampInteger(options.maxPacketBytes, PACKET_HEADER_BYTES, MAX_PACKET_BYTES, MAX_PACKET_BYTES);
      this.maxPacketsPerPush = clampInteger(options.maxPacketsPerPush, 1, MAX_PACKETS_PER_PUSH, MAX_PACKETS_PER_PUSH);
      this.buffer = new Uint8Array();
    }

    push(payload) {
      const incoming = toUint8Array(payload);
      if (incoming.byteLength === 0) return [];
      if (this.buffer.byteLength + incoming.byteLength > this.maxBytes) {
        this.reset();
        throw new RangeError("BZFlag packet stream buffer exceeds the protocol limit");
      }
      const joined = new Uint8Array(this.buffer.byteLength + incoming.byteLength);
      joined.set(this.buffer);
      joined.set(incoming, this.buffer.byteLength);
      const packets = [];
      let offset = 0;
      while (joined.byteLength - offset >= PACKET_HEADER_BYTES) {
        const view = new DataView(joined.buffer, joined.byteOffset + offset, joined.byteLength - offset);
        const length = view.getUint16(0);
        const packetBytes = PACKET_HEADER_BYTES + length;
        if (packetBytes > this.maxPacketBytes) {
          this.reset();
          throw new RangeError("BZFlag packet exceeds the configured limit");
        }
        if (joined.byteLength - offset < packetBytes) break;
        packets.push(joined.slice(offset, offset + packetBytes));
        offset += packetBytes;
        if (packets.length > this.maxPacketsPerPush) {
          this.reset();
          throw new RangeError("BZFlag packet batch exceeds the configured limit");
        }
      }
      this.buffer = joined.slice(offset);
      return packets;
    }

    reset() {
      this.buffer = new Uint8Array();
    }

    get bufferedBytes() {
      return this.buffer.byteLength;
    }
  }

  function encodeConnectHeader() {
    return encoder.encode(CONNECT_HEADER_TEXT);
  }

  /**
   * Consumes the unframed nine-byte greeting that BZFS sends immediately after
   * the BZFLAG connect header. The TCP bridge may fragment this greeting or
   * append the first length-prefixed packet to the same WebSocket message.
   */
  class ServerHandshake {
    constructor(options = {}) {
      this.expectedVersion = String(options.expectedVersion || DEFAULT_SERVER_VERSION);
      if (this.expectedVersion.length !== SERVER_VERSION_BYTES) {
        throw new RangeError("BZFS server version must contain exactly eight bytes");
      }
      this.maxBytes = clampInteger(options.maxBytes, SERVER_GREETING_BYTES, MAX_STREAM_BYTES, MAX_STREAM_BYTES);
      this.buffer = new Uint8Array();
      this.phase = "awaiting-greeting";
      this.serverVersion = null;
      this.playerId = null;
    }

    push(payload) {
      const incoming = toUint8Array(payload);
      if (this.phase === "ready") {
        return {
          ready: true,
          version: this.serverVersion,
          playerId: this.playerId,
          payload: incoming.slice()
        };
      }
      if (this.phase !== "awaiting-greeting") {
        throw new Error("BZFS server handshake is no longer usable");
      }
      if (this.buffer.byteLength + incoming.byteLength > this.maxBytes) {
        this.phase = "failed";
        this.buffer = new Uint8Array();
        throw new RangeError("BZFS server greeting exceeds the protocol limit");
      }
      const joined = new Uint8Array(this.buffer.byteLength + incoming.byteLength);
      joined.set(this.buffer);
      joined.set(incoming, this.buffer.byteLength);
      this.buffer = joined;
      if (this.buffer.byteLength < SERVER_VERSION_BYTES) {
        return { ready: false, payload: new Uint8Array() };
      }
      const version = decoder.decode(this.buffer.slice(0, SERVER_VERSION_BYTES));
      if (version === "REFUSED:") {
        this.phase = "rejected";
        this.buffer = new Uint8Array();
        throw new Error("BZFS refused the connection");
      }
      if (version !== this.expectedVersion) {
        this.phase = "failed";
        this.buffer = new Uint8Array();
        throw new Error(`Incompatible BZFS protocol version: ${version}`);
      }
      if (this.buffer.byteLength < SERVER_GREETING_BYTES) {
        return { ready: false, payload: new Uint8Array() };
      }
      const playerId = this.buffer[SERVER_VERSION_BYTES];
      if (playerId === NO_PLAYER) {
        this.phase = "rejected";
        this.buffer = new Uint8Array();
        throw new Error("BZFS server is full");
      }
      this.serverVersion = version;
      this.playerId = playerId;
      this.phase = "ready";
      const remainder = this.buffer.slice(SERVER_GREETING_BYTES);
      this.buffer = new Uint8Array();
      return { ready: true, version, playerId, payload: remainder };
    }

    reset() {
      this.buffer = new Uint8Array();
      this.phase = "awaiting-greeting";
      this.serverVersion = null;
      this.playerId = null;
    }

    get bufferedBytes() {
      return this.buffer.byteLength;
    }
  }

  function encodeNoPayload(code) {
    return encodePacket(code);
  }

  function encodeFlagNegotiation(flags = FLAG_ABBREVIATIONS) {
    const source = Array.isArray(flags) ? flags : FLAG_ABBREVIATIONS;
    const unique = [];
    const seen = new Set();
    for (const value of source) {
      const abbreviation = String(value || "").slice(0, 2);
      if (!/^[A-Za-z*]{1,2}$/.test(abbreviation) || seen.has(abbreviation)) continue;
      seen.add(abbreviation);
      unique.push(abbreviation);
    }
    const payload = new Uint8Array(unique.length * 2);
    unique.forEach((abbreviation, index) => {
      const bytes = encoder.encode(abbreviation);
      payload[index * 2] = bytes[0] || 0;
      payload[index * 2 + 1] = bytes[1] || 0;
    });
    return encodePacket(MSG_NEGOTIATE_FLAGS, payload);
  }

  function decodeFlagNegotiation(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength % 2 !== 0 || payload.byteLength > MAX_PACKET_PAYLOAD_BYTES) return null;
    const flags = [];
    for (let offset = 0; offset < payload.byteLength; offset += 2) {
      const value = decoder.decode(payload.slice(offset, offset + 2)).replace(/\0+$/g, "");
      if (!value) return null;
      flags.push(value);
    }
    return { flags, missing: flags.length > 0 };
  }

  function encodeGetWorld(offset = 0) {
    const value = clampInteger(offset, 0, MAX_WORLD_BYTES, 0);
    const payload = new Uint8Array(WORLD_OFFSET_BYTES);
    new DataView(payload.buffer).setUint32(0, value);
    return encodePacket(MSG_GET_WORLD, payload);
  }

  function encodeQueryGame() {
    return encodeNoPayload(MSG_QUERY_GAME);
  }

  function encodeQueryPlayers() {
    return encodeNoPayload(MSG_QUERY_PLAYERS);
  }

  function encodeUDPLinkRequest(playerId) {
    const id = boundedPlayerId(playerId);
    if (id === null) return null;
    return encodePacket(MSG_UDP_LINK_REQUEST, new Uint8Array([id]));
  }

  function encodeUDPLinkEstablished() {
    return encodeNoPayload(MSG_UDP_LINK_ESTABLISHED);
  }

  function decodeWorldChunk(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < WORLD_OFFSET_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const bytesLeft = view.getUint32(0);
    const chunk = payload.slice(WORLD_OFFSET_BYTES);
    if (bytesLeft > MAX_WORLD_BYTES || bytesLeft + chunk.byteLength > MAX_WORLD_BYTES) return null;
    return { bytesLeft, chunk, chunkBytes: chunk.byteLength };
  }

  function decodeGameSettings(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < GAME_SETTINGS_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      worldSize: view.getFloat32(0),
      gameType: view.getUint16(4),
      gameOptions: view.getUint16(6),
      playerSlot: view.getUint16(8),
      maxShots: view.getUint16(10),
      maxFlags: view.getUint16(12),
      linearAcceleration: view.getFloat32(14),
      angularAcceleration: view.getFloat32(18),
      shakeTimeout: view.getUint16(22),
      shakeWins: view.getUint16(24),
      syncTime: view.getUint32(26)
    };
  }

  function decodeWorldHash(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength === 0 || payload.byteLength > MAX_PACKET_PAYLOAD_BYTES) return null;
    const value = readFixedString(payload, 0, payload.byteLength);
    if (!value) return null;
    return { value, temporary: value[0] === "t", digest: value.slice(1) };
  }

  function decodeQueryGame(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < QUERY_GAME_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const values = [];
    for (let offset = 0; offset < QUERY_GAME_PAYLOAD_BYTES; offset += 2) values.push(view.getUint16(offset));
    return {
      gameType: values[0],
      gameOptions: values[1],
      maxPlayers: values[2],
      maxShots: values[3],
      teamSizes: values.slice(4, 10),
      teamMaxima: values.slice(10, 16),
      shakeWins: values[16],
      shakeTimeout: values[17],
      maxPlayerScore: values[18],
      maxTeamScore: values[19],
      maxTime: values[20],
      timeElapsed: values[21]
    };
  }

  function encodeEnter(connection = {}) {
    const packet = new Uint8Array(ENTER_PAYLOAD_BYTES);
    const view = new DataView(packet.buffer);
    view.setUint16(0, TANK_PLAYER);
    view.setInt16(2, TEAM_BY_NAME[connection.team] ?? TEAM_BY_NAME.automatic);
    writeFixedString(view, 4, CALLSIGN_BYTES, connection.nickname);
    writeFixedString(view, 4 + CALLSIGN_BYTES, MOTTO_BYTES, connection.motto);
    // The gateway session token must never be forwarded to BZFS as a player
    // token. Only an explicitly supplied BZFS token is eligible here.
    writeFixedString(view, 4 + CALLSIGN_BYTES + MOTTO_BYTES, TOKEN_BYTES, connection.bzfsToken || connection.playerToken);
    writeFixedString(
      view,
      4 + CALLSIGN_BYTES + MOTTO_BYTES + TOKEN_BYTES,
      VERSION_BYTES,
      connection.clientVersion || "2.4.31 BZFlag Web Client"
    );
    return encodePacket(MSG_ENTER, packet);
  }

  function encodePlayerUpdate(state = {}) {
    const playerId = boundedPlayerId(state.playerId);
    if (playerId === null) return null;
    const status = clampInteger(state.status, 0, 0x07ff, PLAYER_STATUS.alive);
    const packet = new Uint8Array(PLAYER_UPDATE_FIXED_BYTES +
      (status & PLAYER_STATUS.jumpJets ? 2 : 0) +
      (status & PLAYER_STATUS.onDriver ? 4 : 0) +
      (status & PLAYER_STATUS.userInputs ? 4 : 0) +
      (status & PLAYER_STATUS.playSound ? 1 : 0));
    const view = new DataView(packet.buffer);
    let offset = 0;
    view.setFloat32(offset, clamp(state.timestamp, -1_000_000_000, 1_000_000_000, 0));
    offset += 4;
    view.setUint8(offset, playerId);
    offset += 1;
    view.setInt32(offset, clampInteger(state.order, 0, 0x7fffffff, 0));
    offset += 4;
    view.setInt16(offset, status);
    offset += 2;
    offset = writeVector(view, offset, state.position);
    offset = writeVector(view, offset, state.velocity);
    view.setFloat32(offset, clamp(state.azimuth, -Math.PI * 2, Math.PI * 2, 0));
    offset += 4;
    view.setFloat32(offset, clamp(state.angularVelocity, -32.766, 32.766, 0));
    offset += 4;
    if (status & PLAYER_STATUS.jumpJets) {
      view.setInt16(offset, clampInteger(Number(state.jumpJetsScale) * SMALL_SCALE, -SMALL_SCALE, SMALL_SCALE, 0));
      offset += 2;
    }
    if (status & PLAYER_STATUS.onDriver) {
      view.setInt32(offset, clampInteger(state.physicsDriver, -0x80000000, 0x7fffffff, -1));
      offset += 4;
    }
    if (status & PLAYER_STATUS.userInputs) {
      view.setInt16(offset, clampInteger(Number(state.userSpeed) * SMALL_SCALE / SMALL_MAX_VELOCITY, -SMALL_SCALE, SMALL_SCALE, 0));
      offset += 2;
      view.setInt16(offset, clampInteger(Number(state.userAngularVelocity) * SMALL_SCALE / SMALL_MAX_ANGULAR_VELOCITY, -SMALL_SCALE, SMALL_SCALE, 0));
      offset += 2;
    }
    if (status & PLAYER_STATUS.playSound) view.setUint8(offset, clampInteger(state.sounds, 0, 0xff, 0));
    return encodePacket(MSG_PLAYER_UPDATE, packet);
  }

  function encodeShotBegin(firing = {}) {
    const playerId = boundedPlayerId(firing.playerId);
    if (playerId === null) return null;
    const packet = new Uint8Array(FIRE_PAYLOAD_BYTES);
    const view = new DataView(packet.buffer);
    let offset = 0;
    view.setFloat32(offset, clamp(firing.timeSent, -1_000_000_000, 1_000_000_000, 0));
    offset += 4;
    view.setUint8(offset, playerId);
    offset += 1;
    view.setUint16(offset, clampInteger(firing.shotId, 0, 0xffff, 0));
    offset += 2;
    offset = writeVector(view, offset, firing.position);
    offset = writeVector(view, offset, firing.velocity);
    view.setFloat32(offset, clamp(firing.dt, 0, 120, 0));
    offset += 4;
    view.setInt16(offset, clampInteger(firing.team, -1, 7, TEAM_BY_NAME.rogue));
    offset += 2;
    const flag = String(firing.flag || "").slice(0, 2);
    const flagBytes = encoder.encode(flag);
    view.setUint8(offset, flagBytes[0] || 0);
    view.setUint8(offset + 1, flagBytes[1] || 0);
    offset += 2;
    view.setFloat32(offset, clamp(firing.lifetime, 0, 120, 0));
    return encodePacket(MSG_SHOT_BEGIN, packet);
  }

  function encodeDropFlag(position) {
    const packet = new Uint8Array(12);
    writeVector(new DataView(packet.buffer), 0, position);
    return encodePacket(MSG_DROP_FLAG, packet);
  }

  function encodeGrabFlag(flagIndex) {
    const index = boundedInteger(flagIndex, 0, 0xffff);
    if (index === null) return null;
    const packet = new Uint8Array(2);
    new DataView(packet.buffer).setUint16(0, index);
    return encodePacket(MSG_GRAB_FLAG, packet);
  }

  function encodeMessage(target = ALL_PLAYERS, message = "") {
    const destination = boundedInteger(target, 0, 0xff);
    if (destination === null) return null;
    const packet = new Uint8Array(MESSAGE_OUTGOING_PAYLOAD_BYTES);
    const view = new DataView(packet.buffer);
    view.setUint8(0, destination);
    writeFixedString(view, 1, MESSAGE_BYTES, message);
    return encodePacket(MSG_MESSAGE, packet);
  }

  function encodeShotEnd(shot = {}) {
    const playerId = boundedPlayerId(shot.playerId ?? shot.source);
    const shotId = boundedInteger(shot.shotId, -0x8000, 0x7fff);
    const reason = boundedInteger(shot.reason, 0, 0xffff);
    if (playerId === null || shotId === null || reason === null) return null;
    const packet = new Uint8Array(SHOT_END_PAYLOAD_BYTES);
    const view = new DataView(packet.buffer);
    view.setUint8(0, playerId);
    view.setInt16(1, shotId);
    view.setUint16(3, reason);
    return encodePacket(MSG_SHOT_END, packet);
  }

  function encodeCaptureFlag(team) {
    const value = resolveTeam(team);
    if (value === null) return null;
    const packet = new Uint8Array(CAPTURE_FLAG_PAYLOAD_BYTES);
    new DataView(packet.buffer).setUint16(0, value & 0xffff);
    return encodePacket(MSG_CAPTURE_FLAG, packet);
  }

  function encodeTeleport(from, to) {
    const source = boundedInteger(from, 0, 0xffff);
    const destination = boundedInteger(to, 0, 0xffff);
    if (source === null || destination === null) return null;
    const packet = new Uint8Array(TELEPORT_PAYLOAD_BYTES);
    const view = new DataView(packet.buffer);
    view.setUint16(0, source);
    view.setUint16(2, destination);
    return encodePacket(MSG_TELEPORT, packet);
  }

  function encodeTransferFlag(from, to) {
    const source = boundedPlayerId(from);
    const destination = boundedPlayerId(to);
    if (source === null || destination === null) return null;
    return encodePacket(MSG_TRANSFER_FLAG, new Uint8Array([source, destination]));
  }

  function encodeNewRabbit() {
    return encodeNoPayload(MSG_NEW_RABBIT);
  }

  function encodeAutoPilot(enabled) {
    return encodePacket(MSG_AUTO_PILOT, new Uint8Array([enabled ? 1 : 0]));
  }

  function encodePause(paused) {
    return encodePacket(MSG_PAUSE, new Uint8Array([paused ? 1 : 0]));
  }

  function messageTargetForCommand(command, state) {
    if (command === "send-all") return ALL_PLAYERS;
    if (command === "send-admin") return ADMIN_PLAYERS;
    if (command === "send-team") {
      const team = resolveTeam(state.team);
      return team === null || team === TEAM_BY_NAME.noTeam ? null : FIRST_TEAM - team;
    }
    if (command === "send-nemesis" || command === "send-recipient") {
      return boundedPlayerId(state.target ?? state.targetPlayerId);
    }
    return boundedInteger(state.target ?? state.targetPlayerId ?? ALL_PLAYERS, 0, 0xff);
  }

  function encodeInput(command, phase = "start", key = "", state = {}) {
    // BZFlag has no key-down wire message. Movement is represented by a
    // complete, server-validated PlayerState and therefore stays disabled until
    // the renderer/physics layer supplies an assigned player and snapshot.
    if (["move-forward", "move-backward", "turn-left", "turn-right"].includes(command)) {
      if (phase !== "start" && phase !== "end") return null;
      return encodePlayerUpdate(state);
    }
    if (command === "fire" && phase === "start") return state.firing ? encodeShotBegin(state.firing) : null;
    if ((command === "drop" || command === "drop-flag") && phase === "start") {
      return hasVector(state.position) ? encodeDropFlag(state.position) : null;
    }
    if ((command === "grab" || command === "grab-flag") && phase === "start") {
      return encodeGrabFlag(state.flagIndex);
    }
    if ((command === "capture" || command === "capture-flag") && phase === "start") {
      return encodeCaptureFlag(state.team);
    }
    if (command === "chat" || command === "message" || command.startsWith("send-")) {
      if (phase !== "start" || typeof state.message !== "string" || state.message.length === 0) return null;
      const target = messageTargetForCommand(command, state);
      return target === null ? null : encodeMessage(target, state.message);
    }
    if ((command === "alive" && phase === "start") || (command === "restart" && phase === "end")) {
      return encodePacket(MSG_ALIVE);
    }
    if (command === "exit" && phase === "start") return encodePacket(MSG_EXIT);
    if ((command === "pause" || command === "auto-pilot" || command === "autopilot") && phase === "start") {
      return command === "pause" ? encodePause(state.paused) : encodeAutoPilot(state.autopilot ?? state.enabled);
    }
    if (command === "new-rabbit" && phase === "start") return encodeNewRabbit();
    if (command === "teleport" && phase === "start") return encodeTeleport(state.from, state.to);
    if (command === "transfer-flag" && phase === "start") {
      const localPlayerId = boundedPlayerId(state.playerId);
      if (localPlayerId === null) return null;
      if (state.from !== undefined && state.from !== null) {
        const requestedSource = boundedPlayerId(state.from);
        if (requestedSource === null || requestedSource !== localPlayerId) return null;
      }
      return encodeTransferFlag(localPlayerId, state.to ?? state.targetPlayerId);
    }
    if (command === "shot-end" && phase === "start") return encodeShotEnd(state);
    // Jump, scoreboard, chat opener and menu actions remain local UI/physics
    // actions. Their native wire commands are emitted only after a complete
    // stateful payload is available.
    return null;
  }

  function decodeAddPlayer(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < ADD_PLAYER_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      playerId: view.getUint8(0),
      type: view.getUint16(1),
      team: view.getUint16(3),
      wins: view.getUint16(5),
      losses: view.getUint16(7),
      tks: view.getUint16(9),
      nickname: readFixedString(payload, 11, CALLSIGN_BYTES),
      motto: readFixedString(payload, 11 + CALLSIGN_BYTES, MOTTO_BYTES)
    };
  }

  function decodeRemovePlayer(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < REMOVE_PLAYER_PAYLOAD_BYTES) return null;
    return { playerId: payload[0] };
  }

  function decodePlayerUpdate(packetPayload, small = false) {
    const payload = toUint8Array(packetPayload);
    const baseBytes = small ? 27 : PLAYER_UPDATE_FIXED_BYTES;
    if (payload.byteLength < baseBytes) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 0;
    const timestamp = readPacketFloat(view, offset);
    if (!timestamp) return null;
    offset = timestamp.offset;
    const playerId = view.getUint8(offset);
    offset += 1;
    const order = view.getInt32(offset);
    offset += 4;
    const status = view.getInt16(offset);
    offset += 2;
    const state = { timestamp: timestamp.value, playerId, order, status, small };
    if (small) {
      const position = [];
      const velocity = [];
      for (let index = 0; index < 3; index += 1) position.push(view.getInt16(offset + index * 2) * 0.02);
      offset += 6;
      for (let index = 0; index < 3; index += 1) velocity.push(view.getInt16(offset + index * 2) * 0.01);
      offset += 6;
      state.position = position;
      state.velocity = velocity;
      state.azimuth = view.getInt16(offset) * Math.PI / SMALL_SCALE;
      offset += 2;
      state.angularVelocity = view.getInt16(offset) * 0.001;
      offset += 2;
    } else {
      const position = readVector(view, offset);
      if (!position) return null;
      state.position = position.value;
      offset = position.offset;
      const velocity = readVector(view, offset);
      if (!velocity) return null;
      state.velocity = velocity.value;
      offset = velocity.offset;
      const azimuth = readPacketFloat(view, offset);
      if (!azimuth) return null;
      state.azimuth = azimuth.value;
      offset = azimuth.offset;
      const angularVelocity = readPacketFloat(view, offset);
      if (!angularVelocity) return null;
      state.angularVelocity = angularVelocity.value;
      offset = angularVelocity.offset;
    }
    if (status & PLAYER_STATUS.jumpJets) {
      if (!packetHasBytes(payload, offset, 2)) return null;
      state.jumpJetsScale = view.getInt16(offset) / SMALL_SCALE;
      offset += 2;
    }
    if (status & PLAYER_STATUS.onDriver) {
      if (!packetHasBytes(payload, offset, 4)) return null;
      state.physicsDriver = view.getInt32(offset);
      offset += 4;
    }
    if (status & PLAYER_STATUS.userInputs) {
      if (!packetHasBytes(payload, offset, 4)) return null;
      state.userSpeed = view.getInt16(offset) * 0.01;
      offset += 2;
      state.userAngularVelocity = view.getInt16(offset) * 0.001;
      offset += 2;
    }
    if (status & PLAYER_STATUS.playSound) {
      if (!packetHasBytes(payload, offset, 1)) return null;
      state.sounds = view.getUint8(offset);
      offset += 1;
    }
    state.bytes = offset;
    return state;
  }

  function decodeShotBegin(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < FIRE_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let offset = 0;
    const timeSent = readPacketFloat(view, offset);
    if (!timeSent) return null;
    offset = timeSent.offset;
    const playerId = view.getUint8(offset);
    offset += 1;
    const shotId = view.getUint16(offset);
    offset += 2;
    const position = readVector(view, offset);
    if (!position) return null;
    offset = position.offset;
    const velocity = readVector(view, offset);
    if (!velocity) return null;
    offset = velocity.offset;
    const dt = readPacketFloat(view, offset);
    if (!dt) return null;
    offset = dt.offset;
    const team = view.getInt16(offset);
    offset += 2;
    const flag = decoder.decode(payload.slice(offset, offset + 2)).replace(/\0/g, "");
    offset += 2;
    const lifetime = readPacketFloat(view, offset);
    if (!lifetime) return null;
    return { timeSent: timeSent.value, playerId, shotId, position: position.value, velocity: velocity.value, dt: dt.value, team, flag, lifetime: lifetime.value, bytes: lifetime.offset };
  }

  function decodeShotEnd(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < SHOT_END_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return { playerId: view.getUint8(0), shotId: view.getInt16(1), reason: view.getUint16(3) };
  }

  function decodeFlagUpdate(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < FLAG_UPDATE_HEADER_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const count = view.getUint16(0);
    const maxEntries = Math.floor((payload.byteLength - FLAG_UPDATE_HEADER_BYTES) / (2 + FLAG_PAYLOAD_BYTES));
    if (count > maxEntries || count > 64) return null;
    const flags = [];
    let offset = FLAG_UPDATE_HEADER_BYTES;
    for (let index = 0; index < count; index += 1) {
      if (!packetHasBytes(payload, offset, 2 + FLAG_PAYLOAD_BYTES)) return null;
      const flagIndex = view.getUint16(offset);
      offset += 2;
      const flagType = decoder.decode(payload.slice(offset, offset + 2)).replace(/\0/g, "");
      offset += 2;
      const status = view.getUint16(offset);
      offset += 2;
      const endurance = view.getUint16(offset);
      offset += 2;
      const owner = view.getUint8(offset);
      offset += 1;
      const position = readVector(view, offset);
      if (!position) return null;
      offset = position.offset;
      const launchPosition = readVector(view, offset);
      if (!launchPosition) return null;
      offset = launchPosition.offset;
      const landingPosition = readVector(view, offset);
      if (!landingPosition) return null;
      offset = landingPosition.offset;
      const flightTime = readPacketFloat(view, offset);
      if (!flightTime) return null;
      offset = flightTime.offset;
      const flightEnd = readPacketFloat(view, offset);
      if (!flightEnd) return null;
      offset = flightEnd.offset;
      const initialVelocity = readPacketFloat(view, offset);
      if (!initialVelocity) return null;
      offset = initialVelocity.offset;
      flags.push({ flagIndex, flagType, status, endurance, owner, position: position.value, launchPosition: launchPosition.value, landingPosition: landingPosition.value, flightTime: flightTime.value, flightEnd: flightEnd.value, initialVelocity: initialVelocity.value });
    }
    return { count, flags, bytes: offset };
  }

  function decodeMessage(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < MESSAGE_SERVER_HEADER_BYTES) return null;
    return {
      source: payload[0],
      destination: payload[1],
      type: payload[2],
      message: readFixedString(payload, MESSAGE_SERVER_HEADER_BYTES, MESSAGE_BYTES)
    };
  }

  function decodeAlive(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < ALIVE_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const position = readVector(view, 1);
    if (!position) return null;
    const azimuth = readPacketFloat(view, position.offset);
    if (!azimuth) return null;
    return { playerId: payload[0], position: position.value, azimuth: azimuth.value };
  }

  function decodeReject(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < 2) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return { reasonCode: view.getUint16(0), reason: readFixedString(payload, 2, Math.min(MESSAGE_BYTES, payload.byteLength - 2)) };
  }

  function decodePacketData(code, payload) {
    switch (code) {
      case MSG_ACCEPT: return toUint8Array(payload).byteLength === 0 ? {} : null;
      case MSG_REJECT: return decodeReject(payload);
      case MSG_NEGOTIATE_FLAGS: return decodeFlagNegotiation(payload);
      case MSG_GAME_SETTINGS: return decodeGameSettings(payload);
      case MSG_GET_WORLD: return decodeWorldChunk(payload);
      case MSG_WANT_W_HASH: return decodeWorldHash(payload);
      case MSG_QUERY_GAME: return decodeQueryGame(payload);
      case MSG_ADD_PLAYER: return decodeAddPlayer(payload);
      case MSG_REMOVE_PLAYER: return decodeRemovePlayer(payload);
      case MSG_PLAYER_UPDATE: return decodePlayerUpdate(payload, false);
      case MSG_PLAYER_UPDATE_SMALL: return decodePlayerUpdate(payload, true);
      case MSG_SHOT_BEGIN: return decodeShotBegin(payload);
      case MSG_SHOT_END: return decodeShotEnd(payload);
      case MSG_SUPER_KILL: return toUint8Array(payload).byteLength === 0 ? {} : null;
      case MSG_FLAG_UPDATE: return decodeFlagUpdate(payload);
      case MSG_MESSAGE: return decodeMessage(payload);
      case MSG_ALIVE: return decodeAlive(payload);
      default: return undefined;
    }
  }

  function consume(channel, payload, context = {}) {
    const packet = readPacketCode(payload);
    if (!packet) return { channel, code: null, bytes: payload?.byteLength || 0, malformed: true };
    const labels = {
      [MSG_ACCEPT]: "server accepted the player",
      [MSG_REJECT]: "server rejected the player",
      [MSG_NEGOTIATE_FLAGS]: "server reported flag capabilities",
      [MSG_GAME_SETTINGS]: "game settings received",
      [MSG_GET_WORLD]: "world chunk received",
      [MSG_WANT_W_HASH]: "world hash received",
      [MSG_QUERY_GAME]: "game query result received",
      [MSG_UDP_LINK_REQUEST]: "server requested UDP confirmation",
      [MSG_UDP_LINK_ESTABLISHED]: "UDP link established",
      [MSG_ADD_PLAYER]: "player state received",
      [MSG_REMOVE_PLAYER]: "player removed",
      [MSG_MESSAGE]: "server message received",
      [MSG_ALIVE]: "player spawned",
      [MSG_SHOT_BEGIN]: "shot fired"
    };
    const label = labels[packet.code] || `BZFlag packet 0x${packet.code.toString(16)}`;
    const detail = { channel, ...packet, label };
    const data = decodePacketData(packet.code, packet.payload);
    detail.data = data;
    detail.valid = data !== null;
    if (packet.code === MSG_ADD_PLAYER && data) {
      detail.player = data;
      detail.local = Boolean(context.nickname && detail.player.nickname === context.nickname);
    }
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent("bzflag:packet", { detail }));
      const feed = document.getElementById("event-feed");
      if (feed) {
        const line = document.createElement("p");
        line.textContent = `${label} (${packet.length} bytes)`;
        feed.replaceChildren(line);
      }
    }
    return detail;
  }

  window.BZFlagWebProtocol = {
    MAX_PACKET_BYTES,
    MAX_PACKET_PAYLOAD_BYTES,
    MAX_STREAM_BYTES,
    PACKET_HEADER_BYTES,
    MSG_ACCEPT,
    MSG_ADD_PLAYER,
    MSG_ALIVE,
    MSG_DROP_FLAG,
    MSG_ENTER,
    MSG_EXIT,
    MSG_GRAB_FLAG,
    MSG_GET_WORLD,
    MSG_GAME_SETTINGS,
    MSG_MESSAGE,
    MSG_NEGOTIATE_FLAGS,
    MSG_PAUSE,
    MSG_PLAYER_UPDATE,
    MSG_PLAYER_UPDATE_SMALL,
    MSG_QUERY_GAME,
    MSG_QUERY_PLAYERS,
    MSG_REJECT,
    MSG_REMOVE_PLAYER,
    MSG_SHOT_BEGIN,
    MSG_SHOT_END,
    MSG_SUPER_KILL,
    MSG_AUTO_PILOT,
    MSG_CAPTURE_FLAG,
    MSG_NEW_RABBIT,
    MSG_TELEPORT,
    MSG_TRANSFER_FLAG,
    MSG_FLAG_UPDATE,
    MSG_TEAM_UPDATE,
    MSG_UDP_LINK_REQUEST,
    MSG_UDP_LINK_ESTABLISHED,
    MSG_WANT_W_HASH,
    MSG_WANT_SETTINGS,
    CONNECT_HEADER_TEXT,
    SERVER_VERSION_BYTES,
    SERVER_GREETING_BYTES,
    DEFAULT_SERVER_VERSION,
    MAX_WORLD_BYTES,
    FLAG_ABBREVIATIONS,
    ENTER_PAYLOAD_BYTES,
    FIRE_PAYLOAD_BYTES,
    ADD_PLAYER_PAYLOAD_BYTES,
    CALLSIGN_BYTES,
    MOTTO_BYTES,
    TOKEN_BYTES,
    VERSION_BYTES,
    MESSAGE_BYTES,
    MESSAGE_OUTGOING_PAYLOAD_BYTES,
    MESSAGE_SERVER_HEADER_BYTES,
    ALIVE_PAYLOAD_BYTES,
    FLAG_PAYLOAD_BYTES,
    MESSAGE_PAYLOAD_BYTES,
    SHOT_END_PAYLOAD_BYTES,
    CAPTURE_FLAG_PAYLOAD_BYTES,
    TRANSFER_FLAG_PAYLOAD_BYTES,
    TELEPORT_PAYLOAD_BYTES,
    BOOLEAN_PAYLOAD_BYTES,
    SERVER_PLAYER,
    ADMIN_PLAYERS,
    FIRST_TEAM,
    ALL_PLAYERS,
    NO_PLAYER,
    PLAYER_STATUS,
    TEAM_BY_NAME,
    encodeConnectHeader,
    ServerHandshake,
    encodePacket,
    encodeEnter,
    encodeNoPayload,
    encodeFlagNegotiation,
    encodeGetWorld,
    encodeQueryGame,
    encodeQueryPlayers,
    encodeUDPLinkRequest,
    encodeUDPLinkEstablished,
    encodePlayerUpdate,
    encodeShotBegin,
    encodeShotEnd,
    encodeDropFlag,
    encodeGrabFlag,
    encodeCaptureFlag,
    encodeTeleport,
    encodeTransferFlag,
    encodeNewRabbit,
    encodeAutoPilot,
    encodePause,
    encodeMessage,
    encodeInput,
    readPacketCode,
    PacketStream,
    decodeAddPlayer,
    decodeRemovePlayer,
    decodePlayerUpdate,
    decodeShotBegin,
    decodeShotEnd,
    decodeFlagUpdate,
    decodeMessage,
    decodeAlive,
    decodeReject,
    decodeFlagNegotiation,
    decodeGameSettings,
    decodeWorldChunk,
    decodeWorldHash,
    decodeQueryGame,
    decodePacketData,
    consume
  };
})();
