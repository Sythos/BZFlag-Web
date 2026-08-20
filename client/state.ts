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

const MSG_ACCEPT = 0x6163;
const MSG_ALIVE = 0x616c;
const MSG_ADD_PLAYER = 0x6170;
const MSG_FLAG_UPDATE = 0x6675;
const MSG_MESSAGE = 0x6d67;
const MSG_PLAYER_UPDATE = 0x7075;
const MSG_PLAYER_UPDATE_SMALL = 0x7073;
const MSG_REJECT = 0x726a;
const MSG_REMOVE_PLAYER = 0x7270;
const MSG_SHOT_BEGIN = 0x7362;
const MSG_SHOT_END = 0x7365;
const PLAYER_ALIVE = 1;

const DEFAULT_LIMITS = Object.freeze({
  players: 216,
  shots: 512,
  flags: 256,
  messages: 128
});

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
}

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function copyVector(value) {
  const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [0, 0, 0];
  return [
    Math.min(1_000_000, Math.max(-1_000_000, finite(source[0]))),
    Math.min(1_000_000, Math.max(-1_000_000, finite(source[1]))),
    Math.min(1_000_000, Math.max(-1_000_000, finite(source[2]))),
  ];
}

function copyPlayer(data) {
  return {
    playerId: boundedInteger(data.playerId, 0, 255, 0),
    type: boundedInteger(data.type, 0, 0xffff, 0),
    team: boundedInteger(data.team, -1, 0xffff, 0),
    wins: boundedInteger(data.wins, 0, 0xffff, 0),
    losses: boundedInteger(data.losses, 0, 0xffff, 0),
    tks: boundedInteger(data.tks, 0, 0xffff, 0),
    nickname: String(data.nickname || "").slice(0, 31),
    motto: String(data.motto || "").slice(0, 127),
    status: boundedInteger(data.status, -0x8000, 0x7fff, 0),
    order: boundedInteger(data.order, 0, 0x7fffffff, 0),
    timestamp: finite(data.timestamp),
    position: copyVector(data.position),
    velocity: copyVector(data.velocity),
    azimuth: finite(data.azimuth),
    angularVelocity: finite(data.angularVelocity),
    small: Boolean(data.small),
    jumpJetsScale: finite(data.jumpJetsScale),
    physicsDriver: boundedInteger(data.physicsDriver, -0x80000000, 0x7fffffff, -1),
    userSpeed: finite(data.userSpeed),
    userAngularVelocity: finite(data.userAngularVelocity),
    sounds: boundedInteger(data.sounds, 0, 0xff, 0),
    alive: Boolean(data.alive)
  };
}

function copyShot(data) {
  return {
    playerId: boundedInteger(data.playerId, 0, 255, 0),
    shotId: boundedInteger(data.shotId, 0, 0xffff, 0),
    timeSent: finite(data.timeSent),
    position: copyVector(data.position),
    velocity: copyVector(data.velocity),
    dt: Math.min(120, Math.max(0, finite(data.dt))),
    team: boundedInteger(data.team, -1, 7, 0),
    flag: String(data.flag || "").slice(0, 2),
    lifetime: Math.min(120, Math.max(0, finite(data.lifetime)))
  };
}

function copyFlag(data) {
  return {
    flagIndex: boundedInteger(data.flagIndex, 0, 0xffff, 0),
    flagType: String(data.flagType || "").slice(0, 2),
    status: boundedInteger(data.status, 0, 0xffff, 0),
    endurance: boundedInteger(data.endurance, 0, 0xffff, 0),
    owner: boundedInteger(data.owner, 0, 0xff, 0),
    position: copyVector(data.position),
    launchPosition: copyVector(data.launchPosition),
    landingPosition: copyVector(data.landingPosition),
    flightTime: finite(data.flightTime),
    flightEnd: finite(data.flightEnd),
    initialVelocity: finite(data.initialVelocity)
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class WorldState {
  constructor(options = {}) {
    this.limits = {
      players: boundedInteger(options.players, 1, DEFAULT_LIMITS.players, DEFAULT_LIMITS.players),
      shots: boundedInteger(options.shots, 1, DEFAULT_LIMITS.shots, DEFAULT_LIMITS.shots),
      flags: boundedInteger(options.flags, 1, DEFAULT_LIMITS.flags, DEFAULT_LIMITS.flags),
      messages: boundedInteger(options.messages, 1, DEFAULT_LIMITS.messages, DEFAULT_LIMITS.messages)
    };
    this.players = new Map();
    this.shots = new Map();
    this.flags = new Map();
    this.messages = [];
    this.localPlayerId = null;
    this.connection = { phase: "connecting", accepted: false, rejected: null };
    this.revision = 0;
    this.lastPacketAt = 0;
  }

  #touch() {
    this.revision += 1;
    this.lastPacketAt = Date.now();
  }

  #ensurePlayer(playerId) {
    if (this.players.has(playerId)) return this.players.get(playerId);
    if (this.players.size >= this.limits.players) return null;
    const player = copyPlayer({ playerId });
    this.players.set(playerId, player);
    return player;
  }

  #boundedMapInsert(map, key, value, limit) {
    if (!map.has(key) && map.size >= limit) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    map.set(key, value);
  }

  apply(event) {
    if (!event || event.valid === false || !Number.isInteger(event.code)) {
      return { applied: false, reason: "invalid-event", revision: this.revision };
    }
    const data = event.data;
    let applied = true;
    switch (event.code) {
      case MSG_ACCEPT:
        this.connection = { phase: "accepted", accepted: true, rejected: null };
        break;
      case MSG_REJECT:
        this.connection = { phase: "rejected", accepted: false, rejected: data ? clone(data) : null };
        break;
      case MSG_ADD_PLAYER: {
        if (!data) { applied = false; break; }
        if (!this.players.has(data.playerId) && this.players.size >= this.limits.players) { applied = false; break; }
        const player = copyPlayer(data);
        this.#boundedMapInsert(this.players, player.playerId, player, this.limits.players);
        if (event.local) this.localPlayerId = player.playerId;
        break;
      }
      case MSG_REMOVE_PLAYER:
        if (!data || !this.players.delete(data.playerId)) applied = false;
        if (data && data.playerId === this.localPlayerId) this.localPlayerId = null;
        break;
      case MSG_PLAYER_UPDATE:
      case MSG_PLAYER_UPDATE_SMALL: {
        if (!data) { applied = false; break; }
        const player = this.#ensurePlayer(data.playerId);
        if (!player) { applied = false; break; }
        Object.assign(player, copyPlayer({ ...player, ...data }));
        break;
      }
      case MSG_ALIVE: {
        if (!data) { applied = false; break; }
        const player = this.#ensurePlayer(data.playerId);
        if (!player) { applied = false; break; }
        Object.assign(player, {
          position: copyVector(data.position),
          velocity: [0, 0, 0],
          azimuth: finite(data.azimuth),
          status: player.status | PLAYER_ALIVE,
          alive: true
        });
        break;
      }
      case MSG_SHOT_BEGIN: {
        if (!data) { applied = false; break; }
        const shot = copyShot(data);
        this.#boundedMapInsert(this.shots, `${shot.playerId}:${shot.shotId}`, shot, this.limits.shots);
        break;
      }
      case MSG_SHOT_END:
        if (!data || !this.shots.delete(`${data.playerId}:${data.shotId}`)) applied = false;
        break;
      case MSG_FLAG_UPDATE:
        if (!data || !Array.isArray(data.flags)) { applied = false; break; }
        for (const flagData of data.flags) {
          const flag = copyFlag(flagData);
          this.#boundedMapInsert(this.flags, flag.flagIndex, flag, this.limits.flags);
        }
        break;
      case MSG_MESSAGE:
        if (!data) { applied = false; break; }
        this.messages.push({ source: data.source, destination: data.destination, message: String(data.message || "").slice(0, 127) });
        while (this.messages.length > this.limits.messages) this.messages.shift();
        break;
      default:
        applied = false;
        break;
    }
    if (applied) this.#touch();
    return { applied, code: event.code, revision: this.revision, localPlayerId: this.localPlayerId };
  }

  snapshot() {
    return clone({
      revision: this.revision,
      lastPacketAt: this.lastPacketAt,
      connection: this.connection,
      localPlayerId: this.localPlayerId,
      players: [...this.players.values()],
      shots: [...this.shots.values()],
      flags: [...this.flags.values()],
      messages: this.messages
    });
  }
}

export function createWorldState(options = {}) {
  return new WorldState(options);
}

export const WORLD_STATE_LIMITS = Object.freeze({ ...DEFAULT_LIMITS });

const api = { WorldState, createWorldState, WORLD_STATE_LIMITS };
if (typeof globalThis !== "undefined") globalThis.BZFlagWebState = api;
