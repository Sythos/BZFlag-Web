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
  const MSG_KILLED = 0x6b6c;
  const MSG_MESSAGE = 0x6d67;
  const MSG_PAUSE = 0x7061;
  const MSG_PLAYER_UPDATE = 0x7075;
  const MSG_PLAYER_UPDATE_SMALL = 0x7073;
  const MSG_REJECT = 0x726a;
  const MSG_REMOVE_PLAYER = 0x7270;
  const MSG_SHOT_BEGIN = 0x7362;
  const MSG_SHOT_END = 0x7365;
  const MSG_TELEPORT = 0x7470;
  const TANK_PLAYER = 0;
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
  const ADD_PLAYER_PAYLOAD_BYTES = 1 + 2 + 2 + CALLSIGN_BYTES + MOTTO_BYTES;
  const PLAYER_UPDATE_FIXED_BYTES = 4 + 1 + 4 + 2 + 12 + 12 + 4 + 4;
  const FIRE_PAYLOAD_BYTES = 4 + 1 + 2 + 12 + 12 + 4 + 2 + 2 + 4;
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
    const playerId = clampInteger(state.playerId, 0, 255, -1);
    if (playerId < 0) return null;
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
    const playerId = clampInteger(firing.playerId, 0, 255, -1);
    if (playerId < 0) return null;
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
    const packet = new Uint8Array(2);
    new DataView(packet.buffer).setUint16(0, clampInteger(flagIndex, 0, 0xffff, 0));
    return encodePacket(MSG_GRAB_FLAG, packet);
  }

  function encodeMessage(target = ALL_PLAYERS, message = "") {
    const packet = new Uint8Array(2 + MESSAGE_BYTES);
    const view = new DataView(packet.buffer);
    view.setUint8(0, clampInteger(target, 0, 0xff, ALL_PLAYERS));
    writeFixedString(view, 1, MESSAGE_BYTES, message);
    return encodePacket(MSG_MESSAGE, packet);
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
    if (command === "drop-flag" && phase === "start") return state.position ? encodeDropFlag(state.position) : null;
    if (command === "grab-flag" && phase === "start") return encodeGrabFlag(state.flagIndex);
    if (command === "alive" && phase === "start") return encodePacket(MSG_ALIVE);
    if (command === "exit" && phase === "start") return encodePacket(MSG_EXIT);
    if (command === "pause" && phase === "start") {
      const packet = new Uint8Array([state.paused ? 1 : 0]);
      return encodePacket(MSG_PAUSE, packet);
    }
    // Scoreboard, chat and menu are local UI actions until their respective
    // stateful protocol adapters are connected.
    return null;
  }

  function decodeAddPlayer(packetPayload) {
    const payload = toUint8Array(packetPayload);
    if (payload.byteLength < ADD_PLAYER_PAYLOAD_BYTES) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return {
      playerId: view.getUint8(0),
      type: view.getUint16(1),
      team: view.getInt16(3),
      nickname: readFixedString(payload, 5, CALLSIGN_BYTES),
      motto: readFixedString(payload, 5 + CALLSIGN_BYTES, MOTTO_BYTES)
    };
  }

  function consume(channel, payload, context = {}) {
    const packet = readPacketCode(payload);
    if (!packet) return { channel, code: null, bytes: payload?.byteLength || 0, malformed: true };
    const labels = {
      [MSG_ACCEPT]: "server accepted the player",
      [MSG_REJECT]: "server rejected the player",
      [MSG_ADD_PLAYER]: "player state received",
      [MSG_REMOVE_PLAYER]: "player removed",
      [MSG_MESSAGE]: "server message received",
      [MSG_ALIVE]: "player spawned",
      [MSG_SHOT_BEGIN]: "shot fired"
    };
    const label = labels[packet.code] || `BZFlag packet 0x${packet.code.toString(16)}`;
    const detail = { channel, ...packet, label };
    if (packet.code === MSG_ADD_PLAYER) {
      detail.player = decodeAddPlayer(packet.payload);
      detail.local = Boolean(detail.player && context.nickname && detail.player.nickname === context.nickname);
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
    MSG_MESSAGE,
    MSG_PAUSE,
    MSG_PLAYER_UPDATE,
    MSG_PLAYER_UPDATE_SMALL,
    MSG_REJECT,
    MSG_REMOVE_PLAYER,
    MSG_SHOT_BEGIN,
    ENTER_PAYLOAD_BYTES,
    FIRE_PAYLOAD_BYTES,
    ADD_PLAYER_PAYLOAD_BYTES,
    CALLSIGN_BYTES,
    MOTTO_BYTES,
    TOKEN_BYTES,
    VERSION_BYTES,
    MESSAGE_BYTES,
    ALL_PLAYERS,
    NO_PLAYER,
    PLAYER_STATUS,
    TEAM_BY_NAME,
    encodePacket,
    encodeEnter,
    encodePlayerUpdate,
    encodeShotBegin,
    encodeDropFlag,
    encodeGrabFlag,
    encodeMessage,
    encodeInput,
    readPacketCode,
    PacketStream,
    decodeAddPlayer,
    consume
  };
})();
