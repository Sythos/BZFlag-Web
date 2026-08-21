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

import { createWorldState } from "../dist/state.js";

const MSG_PLAYER_UPDATE = 0x7075;
const MSG_PLAYER_UPDATE_SMALL = 0x7073;
const MSG_ALIVE = 0x616c;
const MSG_AUTO_PILOT = 0x6175;
const MSG_CAPTURE_FLAG = 0x6366;
const MSG_DROP_FLAG = 0x6466;
const MSG_FLAG_UPDATE = 0x6675;
const MSG_GRAB_FLAG = 0x6766;
const MSG_KILLED = 0x6b6c;
const MSG_NEW_RABBIT = 0x6e52;
const MSG_PAUSE = 0x7061;
const MSG_SCORE = 0x7363;
const MSG_TELEPORT = 0x7470;
const MSG_TRANSFER_FLAG = 0x7466;
const MSG_TEAM_UPDATE = 0x7475;
const MSG_ADD_PLAYER = 0x6170;
const MSG_REMOVE_PLAYER = 0x7270;
const PLAYER_ALIVE = 1;
const PLAYER_PAUSED = 1 << 1;
const PLAYER_TELEPORTING = 1 << 3;
const FLAG_ON_GROUND = 1;
const FLAG_ON_TANK = 2;
const FLAG_IN_AIR = 3;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const state = createWorldState({ players: 4 });
const rejected = state.setWorldGeometry({ source: "wasm-decoder", objects: [{ kind: "not-a-world-object" }] });
assert(rejected.applied && rejected.objectCount === 0, "empty decoded geometry should remain a valid state boundary");
const geometry = state.setWorldGeometry({
  source: "native-adapter",
  mapVersion: 3,
  objects: [
    { kind: "box", position: [4, 5, 1], size: [2, 3, 4] },
    { kind: "teleporter", position: [8, 2, 0], size: [1, 1, 5], rotation: 1.25 }
  ]
});
assert(geometry.applied && geometry.objectCount === 2, "decoded geometry was not applied to WorldState");
const snapshot = state.snapshot();
assert(snapshot.worldGeometry?.objectCount === 2, "WorldState snapshot omitted decoded geometry");
assert(snapshot.worldGeometry?.objects[1].kind === "teleporter", "WorldState snapshot changed geometry kind");
snapshot.worldGeometry.objects[0].position[0] = 999;
assert(state.snapshot().worldGeometry?.objects[0].position[0] === 4, "WorldState geometry snapshot is not isolated");
assert(state.clearWorldGeometry().applied, "WorldState did not clear decoded geometry");
assert(state.snapshot().worldGeometry === null, "WorldState retained cleared geometry");

function playerUpdate(code, playerId, order, x) {
  return {
    code,
    data: {
      playerId,
      order,
      position: [x, 0, 0],
      velocity: [0, 0, 0],
      timestamp: order
    }
  };
}

const ordered = createWorldState({ players: 4 });
const first = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 0, 7));
assert(first.applied, "the first player update must be preserved even with order zero");
assert(ordered.snapshot().players[0].position[0] === 7, "the first player update was not stored");
const next = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE_SMALL, 7, 15, 15));
assert(next.applied, "a strictly newer small player update was rejected");
const revisionAfterNew = ordered.snapshot().revision;
const stale = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 14, 14));
assert(!stale.applied && stale.reason === "stale-player-order", "an out-of-order player update was accepted");
assert(ordered.snapshot().revision === revisionAfterNew, "a stale player update changed the world revision");
assert(ordered.snapshot().players[0].order === 15 && ordered.snapshot().players[0].position[0] === 15, "a stale player update replaced newer state");
const newer = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 16, 16));
assert(newer.applied && ordered.snapshot().players[0].order === 16, "a strictly newer player update was rejected");
const duplicate = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 16, 20));
assert(!duplicate.applied, "an equal player order was accepted");
const independent = ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 8, 1, 8));
assert(independent.applied, "player order tracking was not scoped per entity");

assert(ordered.apply({ code: 0x7270, data: { playerId: 7 } }).applied, "player removal was rejected");
assert(ordered.apply({ code: 0x6170, data: { playerId: 7 } }).applied, "player rejoin was rejected");
assert(ordered.apply(playerUpdate(MSG_PLAYER_UPDATE, 7, 0, 70)).applied, "a re-added entity did not preserve its first update");

console.log("Client state checks passed (validated world geometry isolation and ordered player updates).");

const m2 = createWorldState({ players: 4, flags: 4 });
assert(m2.apply({ code: MSG_ADD_PLAYER, data: { playerId: 1, team: 1 }, local: true }).applied, "M2 player one was not added");
assert(m2.apply({ code: MSG_ADD_PLAYER, data: { playerId: 2, team: 2 } }).applied, "M2 player two was not added");
const teamRevision = m2.snapshot().revision;
assert(m2.apply({
  code: MSG_TEAM_UPDATE,
  data: { count: 2, teams: [{ team: 1, size: 2, wins: 8, losses: 3 }, { team: 2, size: 1, wins: 4, losses: 1 }] }
}).applied, "team update was not reduced");
let m2Snapshot = m2.snapshot();
assert(m2Snapshot.teams.find((team) => team.team === 1)?.wins === 8, "team score was not stored");
assert(m2Snapshot.localPlayerId === 1, "local player identity was not retained");
assert(m2Snapshot.revision === teamRevision + 1, "a valid team update did not advance revision once");

assert(m2.apply({
  code: MSG_SCORE,
  data: { count: 2, scores: [{ playerId: 1, wins: 12, losses: 2, tks: 1 }, { playerId: 2, wins: 7, losses: 3, tks: 0 }] }
}).applied, "score update was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.players.find((player) => player.playerId === 1)?.wins === 12, "player score was not copied into player state");
assert(m2Snapshot.scores.find((score) => score.playerId === 2)?.losses === 3, "score snapshot was not retained");

assert(m2.apply({ code: MSG_ALIVE, data: { playerId: 1, position: [2, 3, 0], azimuth: 0.5 } }).applied, "respawn was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.players.find((player) => player.playerId === 1)?.alive, "respawn did not mark player alive");
assert((m2Snapshot.players.find((player) => player.playerId === 1)?.status & PLAYER_ALIVE) !== 0, "respawn alive status bit was not set");
assert(m2.apply({ code: MSG_KILLED, data: { victim: 1, killer: 2, reason: 4, shotId: 9, flagType: "SW" } }).applied, "killed event was not reduced");
m2Snapshot = m2.snapshot();
const killed = m2Snapshot.players.find((player) => player.playerId === 1);
assert(killed && !killed.alive && killed.killerId === 2 && killed.deathReason === 4 && killed.deathFlag === "SW", "killed metadata was not stored");
const malformedKilledRevision = m2Snapshot.revision;
assert(!m2.apply({ code: MSG_KILLED, data: { victim: "bad", killer: 2 } }).applied, "malformed killed event was accepted");
assert(m2.snapshot().revision === malformedKilledRevision, "malformed killed event changed revision");
assert(m2.apply({ code: MSG_ALIVE, data: { playerId: 1, position: [4, 5, 0], azimuth: 1 } }).applied, "second respawn was not reduced");
m2Snapshot = m2.snapshot();
const respawned = m2Snapshot.players.find((player) => player.playerId === 1);
assert(respawned?.alive && respawned.killerId === null && respawned.deathFlag === "", "respawn did not clear death metadata");

assert(m2.apply({ code: MSG_GRAB_FLAG, data: { playerId: 2, flagIndex: 3, flagType: "SW" } }).applied, "grab flag event was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.players.find((player) => player.playerId === 2)?.flagIndex === 3, "grab did not attach flag to player");
assert(m2Snapshot.flags.find((flag) => flag.flagIndex === 3)?.status === FLAG_ON_TANK, "grab did not set tank flag status");
assert(m2.apply({ code: MSG_TRANSFER_FLAG, data: { from: 2, to: 1, flagIndex: 3, flagType: "SW" } }).applied, "transfer flag event was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.players.find((player) => player.playerId === 2)?.flagIndex === null, "transfer did not clear source carrier");
assert(m2Snapshot.players.find((player) => player.playerId === 1)?.flagIndex === 3, "transfer did not set destination carrier");
assert(m2.apply({ code: MSG_DROP_FLAG, data: { playerId: 1, flagIndex: 3, flagType: "SW" } }).applied, "drop flag event was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.players.find((player) => player.playerId === 1)?.flagIndex === null, "drop did not clear carrier");
assert(m2Snapshot.flags.find((flag) => flag.flagIndex === 3)?.status === FLAG_IN_AIR, "drop did not set in-air flag status");
assert(m2.apply({ code: MSG_GRAB_FLAG, data: { playerId: 1, flagIndex: 3, flagType: "SW" } }).applied, "flag could not be re-grabbed");
assert(m2.apply({ code: MSG_CAPTURE_FLAG, data: { playerId: 1, flagIndex: 3, team: 2 } }).applied, "capture flag event was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.players.find((player) => player.playerId === 1)?.flagIndex === null, "capture did not clear carrier");
assert(m2Snapshot.flags.find((flag) => flag.flagIndex === 3)?.captureTeam === 2 && m2Snapshot.flags.find((flag) => flag.flagIndex === 3)?.status === FLAG_ON_GROUND, "capture state was not stored");

assert(m2.apply({ code: MSG_TELEPORT, data: { playerId: 1, from: 2, to: 5 } }).applied, "teleport event was not reduced");
m2Snapshot = m2.snapshot();
const teleported = m2Snapshot.players.find((player) => player.playerId === 1);
assert(teleported?.teleportFrom === 2 && teleported.teleportTo === 5 && (teleported.status & PLAYER_TELEPORTING) !== 0, "teleport metadata was not stored");
assert(m2.apply({ code: MSG_PAUSE, data: { playerId: 1, paused: true } }).applied, "pause event was not reduced");
assert((m2.snapshot().players.find((player) => player.playerId === 1)?.status & PLAYER_PAUSED) !== 0, "pause status bit was not set");
assert(m2.apply({ code: MSG_PAUSE, data: { playerId: 1, paused: false } }).applied, "pause clear event was not reduced");
assert(m2.apply({ code: MSG_AUTO_PILOT, data: { playerId: 1, enabled: true } }).applied, "autopilot event was not reduced");
assert(m2.snapshot().players.find((player) => player.playerId === 1)?.autopilot, "autopilot state was not stored");
assert(m2.apply({ code: MSG_NEW_RABBIT, data: { playerId: 2 } }).applied, "rabbit event was not reduced");
m2Snapshot = m2.snapshot();
assert(m2Snapshot.rabbitPlayerId === 2 && m2Snapshot.players.find((player) => player.playerId === 2)?.team === 6, "rabbit state was not stored");
assert(m2Snapshot.players.find((player) => player.playerId === 1)?.team === 7, "hunter team was not assigned");

assert(m2.apply({ code: MSG_GRAB_FLAG, data: { playerId: 2, flagIndex: 1, flagType: "L" } }).applied, "second flag grab was not reduced");
assert(m2.apply({ code: MSG_REMOVE_PLAYER, data: { playerId: 2 } }).applied, "player removal was not reduced");
m2Snapshot = m2.snapshot();
assert(!m2Snapshot.players.some((player) => player.playerId === 2) && m2Snapshot.rabbitPlayerId === null, "remove did not clear player and rabbit state");
assert(m2Snapshot.flags.find((flag) => flag.flagIndex === 1)?.owner === 255, "remove did not release carried flag");
assert(m2.apply({ code: MSG_ADD_PLAYER, data: { playerId: 2, team: 0 } }).applied, "player rejoin was not reduced");
assert(m2.apply({ code: MSG_PLAYER_UPDATE, data: { playerId: 2, order: 0, position: [0, 0, 0], velocity: [0, 0, 0] } }).applied, "rejoined player did not accept first server order");
const invalidTeamRevision = m2.snapshot().revision;
assert(!m2.apply({ code: MSG_TEAM_UPDATE, data: { teams: [{ team: 1, size: 1, wins: 1, losses: 1 }, { team: 8, size: 1, wins: 1, losses: 1 }] } }).applied, "malformed team batch was accepted");
assert(m2.snapshot().revision === invalidTeamRevision, "malformed team batch changed revision");
assert(!m2.apply({ code: MSG_FLAG_UPDATE, data: { flags: [{ flagIndex: 2, status: 99 }] } }).applied, "malformed flag update was accepted");
assert(m2.snapshot().revision === invalidTeamRevision, "malformed flag update changed revision");
