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

import { normalizeWorldGeometry, type WorldGeometrySnapshot } from "./world.js";

const MSG_ACCEPT = 0x6163;
const MSG_ALIVE = 0x616c;
const MSG_ADD_PLAYER = 0x6170;
const MSG_AUTO_PILOT = 0x6175;
const MSG_CAPTURE_FLAG = 0x6366;
const MSG_DROP_FLAG = 0x6466;
const MSG_FLAG_UPDATE = 0x6675;
const MSG_GRAB_FLAG = 0x6766;
const MSG_KILLED = 0x6b6c;
const MSG_MESSAGE = 0x6d67;
const MSG_NEW_RABBIT = 0x6e52;
const MSG_PAUSE = 0x7061;
const MSG_PLAYER_UPDATE = 0x7075;
const MSG_PLAYER_UPDATE_SMALL = 0x7073;
const MSG_REJECT = 0x726a;
const MSG_REMOVE_PLAYER = 0x7270;
const MSG_SHOT_BEGIN = 0x7362;
const MSG_SCORE = 0x7363;
const MSG_SHOT_END = 0x7365;
const MSG_TELEPORT = 0x7470;
const MSG_TRANSFER_FLAG = 0x7466;
const MSG_TEAM_UPDATE = 0x7475;
const PLAYER_ALIVE = 1;
const PLAYER_PAUSED = 1 << 1;
const PLAYER_TELEPORTING = 1 << 3;
const RABBIT_TEAM = 6;
const HUNTER_TEAM = 7;
const FLAG_NO_EXIST = 0;
const FLAG_ON_GROUND = 1;
const FLAG_ON_TANK = 2;
const FLAG_IN_AIR = 3;
const NO_PLAYER = 255;

const DEFAULT_LIMITS = Object.freeze({
  players: 216,
  shots: 512,
  flags: 256,
  messages: 128
});

type Vector3 = [number, number, number];
type StateData = {
  [key: string]: unknown;
  playerId?: number;
  id?: number;
  victim?: number;
  victimId?: number;
  killer?: number;
  killerId?: number | null;
  from?: number;
  fromId?: number;
  to?: number;
  toId?: number;
  targetPlayerId?: number;
  type?: number;
  team?: number;
  teamId?: number;
  size?: number;
  won?: number;
  lost?: number;
  wins?: number;
  losses?: number;
  tks?: number;
  nickname?: string;
  motto?: string;
  status?: number;
  order?: number;
  timestamp?: number;
  position?: unknown;
  velocity?: unknown;
  azimuth?: number;
  angularVelocity?: number;
  small?: boolean;
  jumpJetsScale?: number;
  physicsDriver?: number;
  userSpeed?: number;
  userAngularVelocity?: number;
  sounds?: number;
  alive?: boolean;
  paused?: boolean;
  autopilot?: boolean;
  enabled?: boolean;
  rabbit?: boolean;
  shotId?: number;
  killerShotId?: number;
  deathReason?: number | null;
  reason?: number;
  timeSent?: number;
  dt?: number;
  flag?: string;
  lifetime?: number;
  flagIndex?: number | null;
  flagType?: string;
  endurance?: number;
  owner?: number;
  launchPosition?: unknown;
  landingPosition?: unknown;
  flightTime?: number;
  flightEnd?: number;
  initialVelocity?: number;
  source?: number;
  destination?: number;
  message?: string;
  flagInfo?: StateData;
  flags?: StateData[];
  teams?: StateData[];
  scores?: StateData[];
  updates?: StateData[];
  score?: StateData;
};

type StateEvent = {
  code: number;
  valid?: boolean;
  data?: StateData;
  local?: boolean;
};

type StateLimits = {
  players?: number;
  shots?: number;
  flags?: number;
  messages?: number;
};

type PlayerState = {
  playerId: number;
  type: number;
  team: number;
  wins: number;
  losses: number;
  tks: number;
  nickname: string;
  motto: string;
  status: number;
  order: number;
  timestamp: number;
  position: Vector3;
  velocity: Vector3;
  azimuth: number;
  angularVelocity: number;
  small: boolean;
  jumpJetsScale: number;
  physicsDriver: number;
  userSpeed: number;
  userAngularVelocity: number;
  sounds: number;
  alive: boolean;
  flagIndex: number | null;
  flag: string;
  paused: boolean;
  autopilot: boolean;
  rabbit: boolean;
  killerId: number | null;
  deathReason: number | null;
  deathShotId: number | null;
  deathFlag: string;
  teleportFrom: number | null;
  teleportTo: number | null;
};

type TeamState = { team: number; size: number; wins: number; losses: number };
type ScoreState = { playerId: number; wins: number; losses: number; tks: number };

type ShotState = {
  playerId: number;
  shotId: number;
  timeSent: number;
  position: Vector3;
  velocity: Vector3;
  dt: number;
  team: number;
  flag: string;
  lifetime: number;
};

type FlagState = {
  flagIndex: number;
  flagType: string;
  status: number;
  endurance: number;
  owner: number;
  position: Vector3;
  launchPosition: Vector3;
  landingPosition: Vector3;
  flightTime: number;
  flightEnd: number;
  initialVelocity: number;
  captureTeam: number | null;
};

type MessageState = { source?: number; destination?: number; message: string };
type ConnectionState = { phase: "connecting" | "accepted" | "rejected"; accepted: boolean; rejected: StateData | null };

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
}

function finite(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function isRecord(value: unknown): value is StateData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(data: StateData, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function firstDefined(data: StateData, keys: string[]): unknown {
  for (const key of keys) {
    if (hasOwn(data, key)) return data[key];
  }
  return undefined;
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPlayerId(value: unknown): value is number {
  return validInteger(value, 0, 0xff);
}

function validFlagIndex(value: unknown): value is number {
  return validInteger(value, 0, 0xffff);
}

function validTeam(value: unknown): value is number {
  return validInteger(value, 0, 7);
}

function vectorLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as { length?: number };
    return typeof view.length === "number" ? view.length : 0;
  }
  return 0;
}

function validVector(value: unknown): boolean {
  if (vectorLength(value) < 3) return false;
  return validFinite(vectorComponent(value, 0)) && validFinite(vectorComponent(value, 1)) && validFinite(vectorComponent(value, 2));
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function readPlayerId(data: StateData, keys: string[]): number | null {
  const value = firstDefined(data, keys);
  return validPlayerId(value) ? value : null;
}

function readBoolean(data: StateData, keys: string[]): boolean | null {
  const value = firstDefined(data, keys);
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

function readFlagType(data: StateData): string | null | undefined {
  const value = firstDefined(data, ["flagType", "flag"]);
  if (value === undefined) return undefined;
  return validString(value, 2) ? value : null;
}

function flagPayload(data: StateData): StateData {
  return isRecord(data.flagInfo) ? { ...data.flagInfo, ...data } : data;
}

function validatePlayerPayload(data: StateData, requirePosition = false): boolean {
  const integerRanges: Record<string, [number, number]> = {
    playerId: [0, 0xff], type: [0, 0xffff], team: [-2, 0xffff], wins: [0, 0xffff], losses: [0, 0xffff],
    tks: [0, 0xffff], status: [-0x8000, 0x7fff], order: [0, 0x7fffffff], physicsDriver: [-0x80000000, 0x7fffffff], sounds: [0, 0xff]
  };
  for (const [key, [minimum, maximum]] of Object.entries(integerRanges)) {
    if (hasOwn(data, key) && !validInteger(data[key], minimum, maximum)) return false;
  }
  for (const key of ["timestamp", "azimuth", "angularVelocity", "jumpJetsScale", "userSpeed", "userAngularVelocity"]) {
    if (hasOwn(data, key) && !validFinite(data[key])) return false;
  }
  for (const key of ["nickname", "motto"]) {
    if (hasOwn(data, key) && !validString(data[key], key === "nickname" ? 31 : 127)) return false;
  }
  for (const key of ["small", "alive", "paused", "autopilot", "enabled", "rabbit"]) {
    if (hasOwn(data, key) && typeof data[key] !== "boolean") return false;
  }
  if (hasOwn(data, "position") && !validVector(data.position)) return false;
  if (hasOwn(data, "velocity") && !validVector(data.velocity)) return false;
  if (requirePosition && (!validVector(data.position) || !validVector(data.velocity))) return false;
  return true;
}

function validateFlagPayload(data: StateData, requireIndex = true): boolean {
  if (requireIndex && !validFlagIndex(data.flagIndex)) return false;
  const flagType = readFlagType(data);
  if (flagType === null) return false;
  if (hasOwn(data, "status") && !validInteger(data.status, FLAG_NO_EXIST, 5)) return false;
  if (hasOwn(data, "endurance") && !validInteger(data.endurance, 0, 2)) return false;
  if (hasOwn(data, "owner") && !validPlayerId(data.owner)) return false;
  for (const key of ["position", "launchPosition", "landingPosition"]) {
    if (hasOwn(data, key) && !validVector(data[key])) return false;
  }
  for (const key of ["flightTime", "flightEnd", "initialVelocity"]) {
    if (hasOwn(data, key) && !validFinite(data[key])) return false;
  }
  return true;
}

function recordArray(data: StateData, keys: string[], singleKeys: string[]): StateData[] | null {
  for (const key of keys) {
    if (hasOwn(data, key)) {
      return Array.isArray(data[key]) && data[key].every(isRecord) ? data[key] as StateData[] : null;
    }
  }
  return singleKeys.some((key) => hasOwn(data, key)) ? [data] : null;
}

function vectorComponent(value: unknown, index: number): unknown {
  if (Array.isArray(value)) {
    return value[index];
  }
  if (ArrayBuffer.isView(value)) {
    return (value as unknown as ArrayLike<unknown>)[index];
  }
  return 0;
}

function copyVector(value: unknown): Vector3 {
  return [
    Math.min(1_000_000, Math.max(-1_000_000, finite(vectorComponent(value, 0)))),
    Math.min(1_000_000, Math.max(-1_000_000, finite(vectorComponent(value, 1)))),
    Math.min(1_000_000, Math.max(-1_000_000, finite(vectorComponent(value, 2)))),
  ];
}

function copyPlayer(data: StateData): PlayerState {
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
    alive: Boolean(data.alive),
    flagIndex: validFlagIndex(data.flagIndex) ? data.flagIndex : null,
    flag: typeof data.flag === "string" ? data.flag.slice(0, 2) : "",
    paused: data.paused === true,
    autopilot: data.autopilot === true || data.enabled === true,
    rabbit: data.rabbit === true,
    killerId: validPlayerId(data.killerId) ? data.killerId : null,
    deathReason: validInteger(data.deathReason, -0x8000, 0x7fff) ? data.deathReason : null,
    deathShotId: validInteger(data.deathShotId, -0x8000, 0xffff) ? data.deathShotId : null,
    deathFlag: typeof data.deathFlag === "string" ? data.deathFlag.slice(0, 2) : "",
    teleportFrom: validInteger(data.teleportFrom, 0, 0xffff) ? data.teleportFrom : null,
    teleportTo: validInteger(data.teleportTo, 0, 0xffff) ? data.teleportTo : null
  };
}

function playerOrder(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff
    ? value
    : null;
}

function copyShot(data: StateData): ShotState {
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

function copyFlag(data: StateData): FlagState {
  return {
    flagIndex: boundedInteger(data.flagIndex, 0, 0xffff, 0),
    flagType: String(data.flagType || "").slice(0, 2),
    status: boundedInteger(data.status, 0, 0xffff, 0),
    endurance: boundedInteger(data.endurance, 0, 0xffff, 0),
    owner: validPlayerId(data.owner) ? data.owner : NO_PLAYER,
    position: copyVector(data.position),
    launchPosition: copyVector(data.launchPosition),
    landingPosition: copyVector(data.landingPosition),
    flightTime: finite(data.flightTime),
    flightEnd: finite(data.flightEnd),
    initialVelocity: finite(data.initialVelocity),
    captureTeam: validTeam(data.captureTeam) ? data.captureTeam : null
  };
}

function copyTeam(data: StateData): TeamState {
  return {
    team: boundedInteger(firstDefined(data, ["team", "teamId"]), 0, 7, 0),
    size: boundedInteger(data.size, 0, 0xffff, 0),
    wins: boundedInteger(data.wins, 0, 0xffff, 0),
    losses: boundedInteger(data.losses, 0, 0xffff, 0)
  };
}

function copyScore(data: StateData): ScoreState {
  return {
    playerId: boundedInteger(firstDefined(data, ["playerId", "id"]), 0, 0xff, 0),
    wins: boundedInteger(data.wins, 0, 0xffff, 0),
    losses: boundedInteger(data.losses, 0, 0xffff, 0),
    tks: boundedInteger(data.tks, 0, 0xffff, 0)
  };
}

function mergeFlag(existing: FlagState | undefined, data: StateData, flagIndex: number): FlagState {
  const base: StateData = existing ? { ...existing } : { flagIndex, owner: NO_PLAYER, status: FLAG_ON_GROUND };
  return copyFlag({ ...base, ...flagPayload(data), flagIndex });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class WorldState {
  private readonly limits: Required<StateLimits>;
  private readonly players: Map<number, PlayerState>;
  private readonly playerOrders: Map<number, number>;
  private readonly teams: Map<number, TeamState>;
  private readonly scores: Map<number, ScoreState>;
  private readonly shots: Map<string, ShotState>;
  private readonly flags: Map<number, FlagState>;
  private readonly messages: MessageState[];
  private localPlayerId: number | null;
  private rabbitPlayerId: number | null;
  private connection: ConnectionState;
  private worldGeometry: WorldGeometrySnapshot | null;
  private revision: number;
  private lastPacketAt: number;

  constructor(options: StateLimits = {}) {
    this.limits = {
      players: boundedInteger(options.players, 1, DEFAULT_LIMITS.players, DEFAULT_LIMITS.players),
      shots: boundedInteger(options.shots, 1, DEFAULT_LIMITS.shots, DEFAULT_LIMITS.shots),
      flags: boundedInteger(options.flags, 1, DEFAULT_LIMITS.flags, DEFAULT_LIMITS.flags),
      messages: boundedInteger(options.messages, 1, DEFAULT_LIMITS.messages, DEFAULT_LIMITS.messages)
    };
    this.players = new Map();
    this.playerOrders = new Map();
    this.teams = new Map();
    this.scores = new Map();
    this.shots = new Map();
    this.flags = new Map();
    this.messages = [];
    this.localPlayerId = null;
    this.rabbitPlayerId = null;
    this.connection = { phase: "connecting", accepted: false, rejected: null };
    this.worldGeometry = null;
    this.revision = 0;
    this.lastPacketAt = 0;
  }

  #touch() {
    this.revision += 1;
    this.lastPacketAt = Date.now();
  }

  #ensurePlayer(playerId: number): PlayerState | null {
    if (this.players.has(playerId)) return this.players.get(playerId) ?? null;
    if (this.players.size >= this.limits.players) return null;
    const player = copyPlayer({ playerId });
    this.players.set(playerId, player);
    return player;
  }

  #boundedMapInsert<K, V>(map: Map<K, V>, key: K, value: V, limit: number): K | undefined {
    let evicted: K | undefined;
    if (!map.has(key) && map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        evicted = oldest;
        map.delete(oldest);
      }
    }
    map.set(key, value);
    return evicted;
  }

  #clearPlayerFlag(playerId: number, flagIndex?: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const currentIndex = player.flagIndex;
    if (currentIndex === null || (flagIndex !== undefined && currentIndex !== flagIndex)) return;
    player.flagIndex = null;
    player.flag = "";
    const flag = this.flags.get(currentIndex);
    if (flag && flag.owner === playerId) {
      flag.owner = NO_PLAYER;
      if (flag.status === FLAG_ON_TANK) flag.status = FLAG_ON_GROUND;
    }
  }

  #clearFlagCarrier(flagIndex: number): void {
    for (const player of this.players.values()) {
      if (player.flagIndex === flagIndex) {
        player.flagIndex = null;
        player.flag = "";
      }
    }
    const flag = this.flags.get(flagIndex);
    if (flag && flag.status === FLAG_ON_TANK) flag.status = FLAG_ON_GROUND;
    if (flag) flag.owner = NO_PLAYER;
  }

  #setFlagCarrier(playerId: number, flagIndex: number, flagType: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    if (player.flagIndex !== null && player.flagIndex !== flagIndex) this.#clearPlayerFlag(playerId);
    this.#clearFlagCarrier(flagIndex);
    player.flagIndex = flagIndex;
    player.flag = flagType.slice(0, 2);
    return true;
  }

  #removePlayerReferences(playerId: number): void {
    for (const [key, shot] of this.shots) {
      if (shot.playerId === playerId) this.shots.delete(key);
    }
    for (const flag of this.flags.values()) {
      if (flag.owner === playerId) {
        flag.owner = NO_PLAYER;
        if (flag.status === FLAG_ON_TANK) flag.status = FLAG_ON_GROUND;
      }
    }
    for (const player of this.players.values()) {
      if (player.flagIndex !== null) {
        const flag = this.flags.get(player.flagIndex);
        if (player.playerId === playerId || flag?.owner !== player.playerId) {
          player.flagIndex = null;
          player.flag = "";
        }
      }
    }
    this.scores.delete(playerId);
    if (this.rabbitPlayerId === playerId) this.rabbitPlayerId = null;
  }

  apply(event: StateEvent): { applied: boolean; reason?: string; code?: number; revision: number; localPlayerId: number | null } {
    if (!event || event.valid === false || !Number.isInteger(event.code)) {
      return { applied: false, reason: "invalid-event", revision: this.revision, localPlayerId: this.localPlayerId };
    }
    const data = event.data;
    let applied = true;
    let reason: string | undefined;
    switch (event.code) {
      case MSG_ACCEPT:
        if (data !== undefined && !isRecord(data)) { applied = false; break; }
        this.connection = { phase: "accepted", accepted: true, rejected: null };
        break;
      case MSG_REJECT:
        if (data !== undefined && !isRecord(data)) { applied = false; break; }
        this.connection = { phase: "rejected", accepted: false, rejected: data ? clone(data) : null };
        break;
      case MSG_ADD_PLAYER: {
        if (!data || !validPlayerId(data.playerId) || !validatePlayerPayload(data)) { applied = false; break; }
        const playerId = data.playerId;
        const hadPlayer = this.players.has(playerId);
        if (!hadPlayer && this.players.size >= this.limits.players) { applied = false; break; }
        if (hadPlayer) this.#removePlayerReferences(playerId);
        const player = copyPlayer({ ...data, playerId, order: 0 });
        this.#boundedMapInsert(this.players, playerId, player, this.limits.players);
        this.playerOrders.delete(playerId);
        this.#boundedMapInsert(this.scores, playerId, { playerId, wins: player.wins, losses: player.losses, tks: player.tks }, 0x100);
        if (this.rabbitPlayerId === playerId) this.rabbitPlayerId = null;
        if (event.local) this.localPlayerId = playerId;
        break;
      }
      case MSG_REMOVE_PLAYER: {
        if (!data || !validPlayerId(data.playerId) || !this.players.has(data.playerId)) { applied = false; break; }
        const playerId = data.playerId;
        this.players.delete(playerId);
        this.playerOrders.delete(playerId);
        this.#removePlayerReferences(playerId);
        if (playerId === this.localPlayerId) this.localPlayerId = null;
        break;
      }
      case MSG_PLAYER_UPDATE:
      case MSG_PLAYER_UPDATE_SMALL: {
        if (!data || !validPlayerId(data.playerId) || !validatePlayerPayload(data)) { applied = false; break; }
        const order = playerOrder(data.order);
        if (order === null) {
          applied = false;
          reason = "invalid-player-order";
          break;
        }
        const lastOrder = this.playerOrders.get(data.playerId);
        if (lastOrder !== undefined && order <= lastOrder) {
          applied = false;
          reason = "stale-player-order";
          break;
        }
        const player = this.#ensurePlayer(data.playerId);
        if (!player) { applied = false; break; }
        Object.assign(player, copyPlayer({ ...player, ...data, playerId: data.playerId, order }));
        this.playerOrders.set(data.playerId, order);
        break;
      }
      case MSG_ALIVE: {
        if (!data || !validPlayerId(data.playerId) || !validVector(data.position) || !validFinite(data.azimuth)) { applied = false; break; }
        if (hasOwn(data, "velocity") && !validVector(data.velocity)) { applied = false; break; }
        const player = this.#ensurePlayer(data.playerId);
        if (!player) { applied = false; break; }
        this.#clearPlayerFlag(data.playerId);
        Object.assign(player, {
          position: copyVector(data.position),
          velocity: [0, 0, 0],
          azimuth: finite(data.azimuth),
          status: (player.status | PLAYER_ALIVE) & ~PLAYER_TELEPORTING,
          alive: true,
          paused: false,
          killerId: null,
          deathReason: null,
          deathShotId: null,
          deathFlag: ""
        });
        break;
      }
      case MSG_SHOT_BEGIN: {
        if (!data || !validPlayerId(data.playerId) || !validInteger(data.shotId, 0, 0xffff) || !validVector(data.position) || !validVector(data.velocity)) { applied = false; break; }
        if (hasOwn(data, "timeSent") && !validFinite(data.timeSent)) { applied = false; break; }
        if (hasOwn(data, "dt") && !validFinite(data.dt)) { applied = false; break; }
        if (hasOwn(data, "lifetime") && !validFinite(data.lifetime)) { applied = false; break; }
        if (hasOwn(data, "team") && !validInteger(data.team, -1, 7)) { applied = false; break; }
        if (hasOwn(data, "flag") && !validString(data.flag, 2)) { applied = false; break; }
        const shot = copyShot(data);
        this.#boundedMapInsert(this.shots, `${shot.playerId}:${shot.shotId}`, shot, this.limits.shots);
        break;
      }
      case MSG_SHOT_END:
        if (!data || !validPlayerId(data.playerId) || !validInteger(data.shotId, 0, 0xffff) || !this.shots.delete(`${data.playerId}:${data.shotId}`)) applied = false;
        break;
      case MSG_TEAM_UPDATE: {
        if (!data) { applied = false; break; }
        const records = recordArray(data, ["teams", "updates"], ["team", "teamId"]);
        if (records === null || (hasOwn(data, "count") && (!validInteger(data.count, 0, 8) || data.count !== records.length))) { applied = false; break; }
        const updates: TeamState[] = [];
        const seen = new Set<number>();
        for (const record of records) {
          const teamValue = firstDefined(record, ["team", "teamId"]);
          const sizeValue = firstDefined(record, ["size"]);
          const winsValue = firstDefined(record, ["wins", "won"]);
          const lossesValue = firstDefined(record, ["losses", "lost"]);
          if (!validTeam(teamValue) || !validInteger(sizeValue, 0, 0xffff) || !validInteger(winsValue, 0, 0xffff) || !validInteger(lossesValue, 0, 0xffff) || seen.has(teamValue)) {
            applied = false;
            break;
          }
          seen.add(teamValue);
          updates.push(copyTeam({ ...record, team: teamValue, size: sizeValue, wins: winsValue, losses: lossesValue }));
        }
        if (!applied) break;
        for (const team of updates) this.teams.set(team.team, team);
        break;
      }
      case MSG_SCORE: {
        if (!data) { applied = false; break; }
        const records = recordArray(data, ["scores", "updates"], ["playerId", "id"]);
        if (records === null || (hasOwn(data, "count") && (!validInteger(data.count, 0, 0xff) || data.count !== records.length))) { applied = false; break; }
        const updates: ScoreState[] = [];
        const seen = new Set<number>();
        for (const record of records) {
          const playerId = firstDefined(record, ["playerId", "id"]);
          if (!validPlayerId(playerId) || !validInteger(record.wins, 0, 0xffff) || !validInteger(record.losses, 0, 0xffff) || !validInteger(record.tks, 0, 0xffff) || seen.has(playerId)) {
            applied = false;
            break;
          }
          seen.add(playerId);
          updates.push(copyScore({ ...record, playerId }));
        }
        if (!applied) break;
        for (const score of updates) {
          this.#boundedMapInsert(this.scores, score.playerId, score, 0x100);
          const player = this.players.get(score.playerId);
          if (player) {
            player.wins = score.wins;
            player.losses = score.losses;
            player.tks = score.tks;
          }
        }
        break;
      }
      case MSG_KILLED: {
        if (!data) { applied = false; break; }
        const victim = readPlayerId(data, ["victim", "victimId", "playerId", "id"]);
        if (victim === null || !this.players.has(victim)) { applied = false; break; }
        const killerRaw = firstDefined(data, ["killer", "killerId", "source"]);
        const killer = killerRaw === undefined ? NO_PLAYER : (validPlayerId(killerRaw) ? killerRaw : null);
        const reasonValue = firstDefined(data, ["reason", "deathReason"]);
        const shotValue = firstDefined(data, ["shotId", "killerShotId"]);
        const flagType = readFlagType(data);
        if (killer === null || (reasonValue !== undefined && !validInteger(reasonValue, -0x8000, 0x7fff)) || (shotValue !== undefined && !validInteger(shotValue, -0x8000, 0xffff)) || flagType === null) { applied = false; break; }
        if (hasOwn(data, "physicsDriver") && !validInteger(data.physicsDriver, -0x80000000, 0x7fffffff)) { applied = false; break; }
        const player = this.players.get(victim);
        if (!player) { applied = false; break; }
        this.#clearPlayerFlag(victim);
        Object.assign(player, {
          status: player.status & ~(PLAYER_ALIVE | PLAYER_TELEPORTING),
          alive: false,
          killerId: killer,
          deathReason: reasonValue === undefined ? 0 : reasonValue,
          deathShotId: shotValue === undefined ? -1 : shotValue,
          deathFlag: flagType === undefined ? "" : flagType,
          ...(hasOwn(data, "physicsDriver") ? { physicsDriver: data.physicsDriver } : {})
        });
        break;
      }
      case MSG_GRAB_FLAG: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "grabber", "id"]);
        const flagIndex = data.flagIndex;
        const payload = flagPayload(data);
        const flagType = readFlagType(payload);
        if (playerId === null || !this.players.has(playerId) || !validFlagIndex(flagIndex) || !validateFlagPayload(payload) || flagType === null) { applied = false; break; }
        const flag = mergeFlag(this.flags.get(flagIndex), payload, flagIndex);
        flag.status = FLAG_ON_TANK;
        flag.owner = playerId;
        flag.captureTeam = null;
        this.#boundedMapInsert(this.flags, flagIndex, flag, this.limits.flags);
        this.#setFlagCarrier(playerId, flagIndex, flagType ?? flag.flagType);
        const stored = this.flags.get(flagIndex);
        if (stored) {
          stored.status = FLAG_ON_TANK;
          stored.owner = playerId;
          stored.flagType = flagType ?? stored.flagType;
        }
        break;
      }
      case MSG_DROP_FLAG: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "dropper", "id"]);
        const flagIndex = data.flagIndex;
        const payload = flagPayload(data);
        const flagType = readFlagType(payload);
        const statusValue = firstDefined(payload, ["status"]);
        if (playerId === null || !this.players.has(playerId) || !validFlagIndex(flagIndex) || !validateFlagPayload(payload) || flagType === null || (statusValue !== undefined && !validInteger(statusValue, FLAG_NO_EXIST, 5))) { applied = false; break; }
        this.#clearPlayerFlag(playerId, flagIndex);
        this.#clearFlagCarrier(flagIndex);
        const flag = mergeFlag(this.flags.get(flagIndex), payload, flagIndex);
        flag.status = statusValue === undefined ? FLAG_IN_AIR : statusValue;
        flag.owner = NO_PLAYER;
        flag.captureTeam = null;
        this.#boundedMapInsert(this.flags, flagIndex, flag, this.limits.flags);
        break;
      }
      case MSG_CAPTURE_FLAG: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "capturer", "id"]);
        const flagIndex = data.flagIndex;
        const teamValue = firstDefined(data, ["team", "teamId"]);
        const payload = flagPayload(data);
        if (playerId === null || !this.players.has(playerId) || !validFlagIndex(flagIndex) || !validTeam(teamValue) || !validateFlagPayload(payload)) { applied = false; break; }
        this.#clearPlayerFlag(playerId);
        this.#clearFlagCarrier(flagIndex);
        const flag = mergeFlag(this.flags.get(flagIndex), payload, flagIndex);
        flag.status = FLAG_ON_GROUND;
        flag.owner = NO_PLAYER;
        flag.captureTeam = teamValue;
        this.#boundedMapInsert(this.flags, flagIndex, flag, this.limits.flags);
        break;
      }
      case MSG_TELEPORT: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "id"]);
        const from = firstDefined(data, ["from", "teleportFrom"]);
        const to = firstDefined(data, ["to", "teleportTo"]);
        if (playerId === null || !this.players.has(playerId) || !validInteger(from, 0, 0xffff) || !validInteger(to, 0, 0xffff) || (hasOwn(data, "position") && !validVector(data.position))) { applied = false; break; }
        const player = this.players.get(playerId);
        if (!player) { applied = false; break; }
        Object.assign(player, {
          teleportFrom: from,
          teleportTo: to,
          status: player.status | PLAYER_TELEPORTING,
          ...(hasOwn(data, "position") ? { position: copyVector(data.position) } : {})
        });
        break;
      }
      case MSG_TRANSFER_FLAG: {
        if (!data) { applied = false; break; }
        const from = readPlayerId(data, ["from", "fromId", "playerId", "source"]);
        const to = readPlayerId(data, ["to", "toId", "targetPlayerId", "destination"]);
        const flagIndex = data.flagIndex;
        const payload = flagPayload(data);
        const flagType = readFlagType(payload);
        if (from === null || to === null || !validFlagIndex(flagIndex) || !validateFlagPayload(payload) || flagType === null) { applied = false; break; }
        const target = this.players.get(to);
        if (target) this.#clearPlayerFlag(to);
        this.#clearFlagCarrier(flagIndex);
        const flag = mergeFlag(this.flags.get(flagIndex), payload, flagIndex);
        flag.captureTeam = null;
        if (target) {
          flag.status = FLAG_ON_TANK;
          flag.owner = to;
        } else {
          flag.owner = to;
        }
        this.#boundedMapInsert(this.flags, flagIndex, flag, this.limits.flags);
        if (target) {
          this.#setFlagCarrier(to, flagIndex, flagType ?? flag.flagType);
          const stored = this.flags.get(flagIndex);
          if (stored) {
            stored.status = FLAG_ON_TANK;
            stored.owner = to;
          }
        }
        break;
      }
      case MSG_PAUSE: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "id"]);
        const paused = readBoolean(data, ["paused", "pause", "value"]);
        if (playerId === null || paused === null || !this.players.has(playerId)) { applied = false; break; }
        const player = this.players.get(playerId);
        if (!player) { applied = false; break; }
        player.paused = paused;
        player.status = paused ? player.status | PLAYER_PAUSED : player.status & ~PLAYER_PAUSED;
        break;
      }
      case MSG_AUTO_PILOT: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "id"]);
        const autopilot = readBoolean(data, ["autopilot", "enabled", "value"]);
        if (playerId === null || autopilot === null || !this.players.has(playerId)) { applied = false; break; }
        const player = this.players.get(playerId);
        if (!player) { applied = false; break; }
        player.autopilot = autopilot;
        break;
      }
      case MSG_NEW_RABBIT: {
        if (!data) { applied = false; break; }
        const playerId = readPlayerId(data, ["playerId", "id"]);
        if (playerId === null || !this.players.has(playerId)) { applied = false; break; }
        for (const player of this.players.values()) {
          if (player.playerId === playerId) {
            player.team = RABBIT_TEAM;
            player.rabbit = true;
          } else {
            player.rabbit = false;
            if (player.team !== 5 && player.team !== -1 && player.team !== -2) player.team = HUNTER_TEAM;
          }
        }
        this.rabbitPlayerId = playerId;
        break;
      }
      case MSG_FLAG_UPDATE: {
        if (!data || !Array.isArray(data.flags)) { applied = false; break; }
        const updates: FlagState[] = [];
        const seen = new Set<number>();
        for (const flagData of data.flags) {
          if (!isRecord(flagData) || !validFlagIndex(flagData.flagIndex) || !validateFlagPayload(flagData) || seen.has(flagData.flagIndex)) { applied = false; break; }
          seen.add(flagData.flagIndex);
          updates.push(mergeFlag(this.flags.get(flagData.flagIndex), flagData, flagData.flagIndex));
        }
        if (!applied) break;
        for (const flag of updates) {
          this.#boundedMapInsert(this.flags, flag.flagIndex, flag, this.limits.flags);
          if (flag.status === FLAG_ON_TANK && validPlayerId(flag.owner) && this.players.has(flag.owner)) {
            this.#setFlagCarrier(flag.owner, flag.flagIndex, flag.flagType);
            const stored = this.flags.get(flag.flagIndex);
            if (stored) {
              stored.status = FLAG_ON_TANK;
              stored.owner = flag.owner;
            }
          } else if (flag.status !== FLAG_ON_TANK) {
            this.#clearFlagCarrier(flag.flagIndex);
          }
        }
        break;
      }
      case MSG_MESSAGE:
        if (!data || !validString(data.message, 0xffff) || (hasOwn(data, "source") && !validPlayerId(data.source)) || (hasOwn(data, "destination") && !validPlayerId(data.destination))) { applied = false; break; }
        this.messages.push({ source: data.source, destination: data.destination, message: data.message.slice(0, 127) });
        while (this.messages.length > this.limits.messages) this.messages.shift();
        break;
      default:
        applied = false;
        break;
    }
    if (applied) this.#touch();
    return { applied, ...(reason ? { reason } : {}), code: event.code, revision: this.revision, localPlayerId: this.localPlayerId };
  }

  /**
   * Apply geometry emitted by the optional native/WASM world decoder.
   *
   * The network protocol delivers the packed world database separately from
   * entity packets.  Keeping this explicit prevents an incomplete decoder from
   * being mistaken for an authoritative map while still allowing the renderer
   * to consume validated boxes, walls, bases, and teleporters.
   */
  setWorldGeometry(input: unknown): { applied: boolean; objectCount: number; revision: number } {
    const geometry = normalizeWorldGeometry(input);
    if (!geometry) return { applied: false, objectCount: 0, revision: this.revision };
    this.worldGeometry = geometry;
    this.#touch();
    return { applied: true, objectCount: geometry.objectCount, revision: this.revision };
  }

  clearWorldGeometry(): { applied: boolean; revision: number } {
    if (this.worldGeometry === null) return { applied: false, revision: this.revision };
    this.worldGeometry = null;
    this.#touch();
    return { applied: true, revision: this.revision };
  }

  snapshot(): {
    revision: number;
    lastPacketAt: number;
    connection: ConnectionState;
    localPlayerId: number | null;
    rabbitPlayerId: number | null;
    worldGeometry: WorldGeometrySnapshot | null;
    players: PlayerState[];
    teams: TeamState[];
    scores: ScoreState[];
    shots: ShotState[];
    flags: FlagState[];
    messages: MessageState[];
  } {
    return clone({
      revision: this.revision,
      lastPacketAt: this.lastPacketAt,
      connection: this.connection,
      localPlayerId: this.localPlayerId,
      rabbitPlayerId: this.rabbitPlayerId,
      worldGeometry: this.worldGeometry,
      players: [...this.players.values()],
      teams: [...this.teams.values()],
      scores: [...this.scores.values()],
      shots: [...this.shots.values()],
      flags: [...this.flags.values()],
      messages: this.messages
    });
  }
}

export function createWorldState(options: StateLimits = {}): WorldState {
  return new WorldState(options);
}

export const WORLD_STATE_LIMITS = Object.freeze({ ...DEFAULT_LIMITS });

const api = { WorldState, createWorldState, WORLD_STATE_LIMITS };
if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & { BZFlagWebState?: typeof api }).BZFlagWebState = api;
}
