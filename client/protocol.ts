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

  // BZFlag 2.4.31 wire identifiers. The values are kept in this small adapter
  // so the browser never has to load the native C++ client or expose a socket.
  const MSG_ACCEPT = 0x6163;
  const MSG_REJECT = 0x726a;
  const MSG_ENTER = 0x656e;
  const MSG_ADD_PLAYER = 0x6170;
  const MSG_REMOVE_PLAYER = 0x7270;
  const MSG_MESSAGE = 0x6d67;
  const TANK_PLAYER = 0;
  const TEAM_BY_NAME = {
    automatic: -2,
    rogue: 0,
    red: 1,
    green: 2,
    blue: 3,
    purple: 4,
    observer: 5
  };
  const CALLSIGN_BYTES = 32;
  const MOTTO_BYTES = 128;
  const TOKEN_BYTES = 22;
  const VERSION_BYTES = 60;
  const ENTER_PAYLOAD_BYTES = 1 + 4 + CALLSIGN_BYTES + MOTTO_BYTES + TOKEN_BYTES + VERSION_BYTES;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function writeFixedString(view, offset, length, value) {
    const bytes = encoder.encode(String(value || ""));
    const copyLength = Math.min(bytes.length, Math.max(0, length - 1));
    new Uint8Array(view.buffer, view.byteOffset + offset, length).set(bytes.subarray(0, copyLength));
  }

  function encodeEnter(connection = {}) {
    const packet = new Uint8Array(4 + ENTER_PAYLOAD_BYTES);
    const view = new DataView(packet.buffer);
    view.setUint16(0, ENTER_PAYLOAD_BYTES);
    view.setUint16(2, MSG_ENTER);
    view.setUint16(4, TANK_PLAYER);
    view.setInt16(6, TEAM_BY_NAME[connection.team] ?? TEAM_BY_NAME.automatic);
    writeFixedString(view, 8, CALLSIGN_BYTES, connection.nickname);
    writeFixedString(view, 8 + CALLSIGN_BYTES, MOTTO_BYTES, connection.motto);
    // Password authentication is intentionally not guessed here. BZFlag uses
    // an authentication token, not the raw password; a future auth adapter can
    // supply the TOKEN_BYTES field without exposing credentials to the gateway.
    writeFixedString(view, 8 + CALLSIGN_BYTES + MOTTO_BYTES, TOKEN_BYTES, "");
    writeFixedString(view, 8 + CALLSIGN_BYTES + MOTTO_BYTES + TOKEN_BYTES, VERSION_BYTES, "BZFlag Web Client 0.1.0");
    return packet;
  }

  function readPacketCode(payload) {
    if (!(payload instanceof Uint8Array) || payload.byteLength < 4) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return { length: view.getUint16(0), code: view.getUint16(2) };
  }

  function consume(channel, payload) {
    const packet = readPacketCode(payload);
    if (!packet) return { channel, code: null, bytes: payload?.byteLength || 0 };
    const labels = {
      [MSG_ACCEPT]: "server accepted the player",
      [MSG_REJECT]: "server rejected the player",
      [MSG_ADD_PLAYER]: "player state received",
      [MSG_REMOVE_PLAYER]: "player removed",
      [MSG_MESSAGE]: "server message received"
    };
    const label = labels[packet.code] || `BZFlag packet 0x${packet.code.toString(16)}`;
    document.dispatchEvent(new CustomEvent("bzflag:packet", { detail: { channel, ...packet, label } }));
    const feed = document.getElementById("event-feed");
    if (feed) {
      const line = document.createElement("p");
      line.textContent = `${label} (${packet.length} bytes)`;
      feed.replaceChildren(line);
    }
    return { channel, ...packet, label };
  }

  // Movement packets require the server-assigned player id and timestamps;
  // return null until the complete native state encoder is available.
  function encodeInput() {
    return null;
  }

  window.BZFlagWebProtocol = {
    MSG_ACCEPT,
    MSG_REJECT,
    MSG_ENTER,
    ENTER_PAYLOAD_BYTES,
    encodeEnter,
    encodeInput,
    consume,
    readPacketCode,
    TEAM_BY_NAME
  };
})();
