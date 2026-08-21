// @ts-nocheck
/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Sythos (https://www.sythos.net)
 *
 * MIT License
 *
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

  const TEAM_COLORS = Object.freeze({
    [-1]: [0.45, 0.48, 0.52],
    0: [0.82, 0.84, 0.88],
    1: [0.90, 0.16, 0.16],
    2: [0.18, 0.85, 0.30],
    3: [0.18, 0.42, 0.95],
    4: [0.72, 0.24, 0.88],
    5: [0.45, 0.48, 0.52],
    6: [0.96, 0.76, 0.12],
    7: [0.94, 0.56, 0.18]
  });

  const WORLD_KIND_COLORS = Object.freeze({
    box: [0.32, 0.38, 0.46, 1],
    wall: [0.26, 0.32, 0.40, 1],
    pyramid: [0.42, 0.35, 0.25, 1],
    base: [0.32, 0.45, 0.56, 1],
    teleporter: [0.16, 0.72, 0.76, 0.9],
    sphere: [0.48, 0.40, 0.62, 1],
    cone: [0.56, 0.38, 0.28, 1],
    arc: [0.36, 0.46, 0.56, 1],
    mesh: [0.30, 0.36, 0.42, 1],
    zone: [0.16, 0.42, 0.48, 0.58]
  });

  const FLAG_COLORS = Object.freeze({
    "R*": [0.90, 0.16, 0.16, 1],
    "G*": [0.18, 0.85, 0.30, 1],
    "B*": [0.18, 0.42, 0.95, 1],
    "P*": [0.72, 0.24, 0.88, 1],
    "V": [0.78, 0.18, 0.74, 1],
    "SW": [0.95, 0.78, 0.18, 1],
    "L": [0.18, 0.82, 0.92, 1]
  });

  const MAX_WORLD_OBJECTS = 4096;
  const MAX_RENDER_OBJECTS = 2048;
  const MAX_PLAYERS = 216;
  const MAX_SHOTS = 512;
  const MAX_FLAGS = 256;
  const MAX_MESSAGES = 128;
  const PLAYER_ALIVE = 1;

  const DEFAULT_SNAPSHOT = Object.freeze({
    revision: 0,
    localPlayerId: null,
    players: [],
    shots: [],
    flags: [],
    messages: [],
    worldGeometry: null,
    water: null
  });

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function vector(value) {
    const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [0, 0, 0];
    return [finite(source[0]), finite(source[1]), finite(source[2])];
  }

  function bounded(value, minimum, maximum, fallback = minimum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function sizeVector(value, fallback = [1, 1, 1]) {
    const source = vector(value || fallback);
    return source.map((entry, index) => bounded(Math.abs(entry), 0.01, 1_000_000, fallback[index]));
  }

  function color(value, fallback = [1, 1, 1, 1]) {
    const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value : fallback;
    return [
      bounded(source[0], 0, 1, fallback[0]),
      bounded(source[1], 0, 1, fallback[1]),
      bounded(source[2], 0, 1, fallback[2]),
      bounded(source[3], 0, 1, fallback[3])
    ];
  }

  function teamColor(team, alpha = 1) {
    const color = TEAM_COLORS[Number(team)] || TEAM_COLORS[-1];
    return [color[0], color[1], color[2], alpha];
  }

  function flagColor(flagType) {
    const value = String(flagType || "").slice(0, 2).toUpperCase();
    const color = FLAG_COLORS[value] || [0.94, 0.86, 0.25, 1];
    return color.slice();
  }

  function geometryColor(object) {
    if (Array.isArray(object?.color) || ArrayBuffer.isView(object?.color)) {
      const color = object.color;
      return [finite(color[0], 0.4), finite(color[1], 0.45), finite(color[2], 0.5), finite(color[3], 1)];
    }
    if (Number.isFinite(Number(object?.team))) return teamColor(object.team, object.kind === "zone" ? 0.55 : 1);
    const fallback = WORLD_KIND_COLORS[object?.kind] || WORLD_KIND_COLORS.mesh;
    return fallback.slice();
  }

  const WORLD_PRIMITIVES = Object.freeze({
    box: "box",
    wall: "box",
    pyramid: "pyramid",
    base: "box",
    teleporter: "teleporter",
    sphere: "sphere",
    cone: "cone",
    arc: "ring",
    mesh: "box",
    zone: "plane"
  });

  function geometryObjects(snapshot) {
    const source = snapshot?.worldGeometry || snapshot?.geometry;
    const records = Array.isArray(source?.objects) ? source.objects.slice(0, MAX_WORLD_OBJECTS) : [];
    const objects = [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const position = vector(record.position);
      const size = sizeVector(record.size);
      const kind = String(record.kind || "mesh").toLowerCase();
      objects.push({
        id: record.id,
        position: [position[0], position[2], position[1]],
        size: [size[0], size[2], size[1]],
        rotation: finite(record.rotation),
        color: geometryColor({ ...record, kind }),
        kind: `world-${kind}`,
        primitive: WORLD_PRIMITIVES[kind] || "box",
        layer: "world",
        material: record.material
      });
      if (kind === "teleporter") {
        objects.push({
          position: [position[0], position[2] + size[2] * 0.55, position[1]],
          size: [size[0] * 1.35, Math.max(0.08, size[2] * 0.08), size[1] * 1.35],
          rotation: finite(record.rotation),
          color: [0.28, 0.92, 0.96, 0.72],
          kind: "world-teleporter-ring",
          primitive: "ring",
          layer: "teleporter",
          id: record.id ? `${record.id}:ring` : undefined
        });
        objects.push({
          position: [position[0], position[2] + size[2] * 0.62, position[1]],
          size: [size[0] * 0.38, Math.max(0.3, size[2] * 0.72), size[1] * 0.38],
          rotation: finite(record.rotation),
          color: [0.20, 0.82, 0.94, 0.26],
          kind: "world-teleporter-beam",
          primitive: "beam",
          layer: "teleporter",
          id: record.id ? `${record.id}:beam` : undefined
        });
      }
    }
    return objects;
  }

  function waterObjects(snapshot) {
    const world = snapshot?.worldGeometry || snapshot?.geometry || {};
    const source = snapshot?.water || snapshot?.worldWater || world?.water;
    const waterLevel = finite(source?.level ?? snapshot?.waterLevel ?? world?.waterLevel, NaN);
    if (!Number.isFinite(waterLevel)) return [];
    const rawSize = source?.size || snapshot?.worldBounds || world?.bounds;
    const size = Array.isArray(rawSize) || ArrayBuffer.isView(rawSize) ? rawSize : null;
    const width = bounded(source?.width ?? size?.[0] ?? snapshot?.worldSize, 1, 1_000_000, NaN);
    const depth = bounded(source?.depth ?? size?.[1] ?? size?.[2] ?? snapshot?.worldSize, 1, 1_000_000, NaN);
    if (!Number.isFinite(width) || !Number.isFinite(depth)) return [];
    const center = vector(source?.position || source?.center);
    return [{
      position: [center[0], waterLevel, center[1]],
      size: [width, 0.04, depth],
      rotation: 0,
      color: color(source?.color, [0.08, 0.42, 0.58, 0.64]),
      kind: "water",
      primitive: "water",
      layer: "water",
      id: source?.id || "world-water"
    }];
  }

  function resizeCanvas(canvas) {
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect?.() || { width: canvas.clientWidth || 640, height: canvas.clientHeight || 360 };
    const ratio = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2);
    const width = Math.max(1, Math.floor((rect.width || canvas.clientWidth || 640) * ratio));
    const height = Math.max(1, Math.floor((rect.height || canvas.clientHeight || 360) * ratio));
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  }

  function identity() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  function multiply(a, b) {
    const result = new Float32Array(16);
    for (let column = 0; column < 4; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        result[column * 4 + row] = a[row] * b[column * 4]
          + a[4 + row] * b[column * 4 + 1]
          + a[8 + row] * b[column * 4 + 2]
          + a[12 + row] * b[column * 4 + 3];
      }
    }
    return result;
  }

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const range = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * range, -1,
      0, 0, 2 * far * near * range, 0
    ]);
  }

  function translate(x, y, z) {
    const matrix = identity();
    matrix[12] = x;
    matrix[13] = y;
    matrix[14] = z;
    return matrix;
  }

  function scale(x, y, z) {
    const matrix = identity();
    matrix[0] = x;
    matrix[5] = y;
    matrix[10] = z;
    return matrix;
  }

  function rotateY(angle) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return new Float32Array([
      cosine, 0, -sine, 0,
      0, 1, 0, 0,
      sine, 0, cosine, 0,
      0, 0, 0, 1
    ]);
  }

  function cameraMatrix(canvas, time) {
    const aspect = Math.max(0.1, canvas.width / Math.max(1, canvas.height));
    const view = multiply(translate(0, -3.4, -22), rotateY(Math.sin(time * 0.00008) * 0.08));
    return multiply(perspective(Math.PI / 3, aspect, 0.1, 200), view);
  }

  function snapshotOrDefault(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return DEFAULT_SNAPSHOT;
    return {
      ...DEFAULT_SNAPSHOT,
      ...snapshot,
      players: Array.isArray(snapshot.players) ? snapshot.players.slice(0, MAX_PLAYERS) : [],
      shots: Array.isArray(snapshot.shots) ? snapshot.shots.slice(0, MAX_SHOTS) : [],
      flags: Array.isArray(snapshot.flags) ? snapshot.flags.slice(0, MAX_FLAGS) : [],
      messages: Array.isArray(snapshot.messages) ? snapshot.messages.slice(-MAX_MESSAGES) : [],
      worldGeometry: snapshot.worldGeometry && Array.isArray(snapshot.worldGeometry.objects)
        ? { ...snapshot.worldGeometry, objects: snapshot.worldGeometry.objects.slice(0, MAX_WORLD_OBJECTS) }
        : null,
      water: snapshot.water && typeof snapshot.water === "object" ? { ...snapshot.water } : null
    };
  }

  function snapshotFromState(state) {
    const snapshot = typeof state?.snapshot === "function" ? state.snapshot() : state;
    return snapshotOrDefault(snapshot);
  }

  function createSceneObjectCache() {
    let revision = -1;
    let objects = [];
    return (snapshot, time) => {
      const nextRevision = Number.isInteger(snapshot?.revision) ? snapshot.revision : -1;
      // Rebuild only when the authoritative revision changes; revision zero is
      // intentionally recomputed because it is the initial no-packet snapshot.
      if (nextRevision === 0 || nextRevision !== revision) {
        objects = sceneObjects(snapshot, time);
        revision = nextRevision;
      }
      return objects;
    };
  }

  function sceneObjects(snapshot, time) {
    const objects = [];
    objects.push(...geometryObjects(snapshot));
    objects.push(...waterObjects(snapshot));
    for (const player of snapshot.players) {
      const position = vector(player.position);
      const hasStatus = player.status !== undefined && player.status !== null;
      const alive = player.alive !== false && (!hasStatus || (Number(player.status) & PLAYER_ALIVE) !== 0);
      if (!alive) continue;
      const color = teamColor(player.team);
      const rotation = finite(player.azimuth);
      const lateralX = Math.cos(rotation) * 0.52;
      const lateralZ = -Math.sin(rotation) * 0.52;
      objects.push({
        position: [position[0], Math.max(0.15, position[2] + 0.55), position[1]],
        size: [1.15, 0.65, 1.55],
        rotation,
        color,
        kind: "tank-body",
        primitive: "box",
        layer: "entity",
        playerId: player.playerId
      });
      objects.push({
        position: [position[0], Math.max(0.75, position[2] + 1.1), position[1]],
        size: [0.46, 0.28, 0.78],
        rotation,
        color: [0.66, 0.73, 0.78, 1],
        kind: "tank-turret",
        primitive: "box",
        layer: "entity",
        playerId: player.playerId
      });
      objects.push({
        position: [position[0], Math.max(0.86, position[2] + 1.25), position[1]],
        size: [0.18, 0.18, 1.0],
        rotation,
        color: [0.75, 0.82, 0.86, 1],
        kind: "tank-barrel",
        primitive: "box",
        layer: "entity",
        playerId: player.playerId
      });
      for (const side of [-1, 1]) {
        objects.push({
          position: [position[0] + lateralX * side, Math.max(0.18, position[2] + 0.38), position[1] + lateralZ * side],
          size: [0.20, 0.42, 1.40],
          rotation,
          color: [0.12, 0.16, 0.20, 1],
          kind: "tank-track",
          primitive: "box",
          layer: "entity",
          playerId: player.playerId
        });
      }
    }
    for (const shot of snapshot.shots) {
      const position = vector(shot.position);
      const color = String(shot.flag || "").length > 0 ? flagColor(shot.flag) : teamColor(shot.team);
      objects.push({ position: [position[0], position[2] + 0.2, position[1]], size: [0.18, 0.18, 0.55], color, kind: "shot", primitive: "sphere", layer: "entity", shotId: shot.shotId, playerId: shot.playerId });
      objects.push({ position: [position[0], position[2] + 0.2, position[1]], size: [0.34, 0.34, 0.34], color: [color[0], color[1], color[2], 0.22], kind: "shot-glow", primitive: "sphere", layer: "effects", shotId: shot.shotId, playerId: shot.playerId });
    }
    for (const flag of snapshot.flags) {
      const position = vector(flag.position || flag.landingPosition);
      const color = flagColor(flag.flagType);
      objects.push({ position: [position[0], position[2] + 0.9, position[1]], size: [0.12, 1.8, 0.12], color: [0.80, 0.80, 0.84, 1], kind: "flag-pole", primitive: "cylinder", layer: "entity", flagIndex: flag.flagIndex });
      objects.push({ position: [position[0] + 0.32, position[2] + 1.5, position[1]], size: [0.65, 0.35, 0.08], color, kind: "flag-cloth", primitive: "box", layer: "entity", flagIndex: flag.flagIndex });
      objects.push({ position: [position[0], position[2] + 0.08, position[1]], size: [0.42, 0.08, 0.42], color: [color[0], color[1], color[2], 0.72], kind: "flag-base", primitive: "cylinder", layer: "entity", flagIndex: flag.flagIndex });
    }
    const layerOrder = { world: 0, water: 1, teleporter: 2, entity: 3, effects: 4 };
    objects.sort((a, b) => (layerOrder[a.layer] ?? 3) - (layerOrder[b.layer] ?? 3));
    return objects.slice(0, MAX_RENDER_OBJECTS);
  }

  function cubeVertices() {
    const faces = [
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]
    ];
    const values = [];
    for (const face of faces) {
      const indices = [0, 1, 2, 0, 2, 3];
      for (const index of indices) values.push(...face[index]);
    }
    return new Float32Array(values);
  }

  function pyramidVertices() {
    const base = [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]];
    const apex = [0, 1, 0];
    const values = [];
    values.push(...base[0], ...base[1], ...base[2], ...base[0], ...base[2], ...base[3]);
    for (let index = 0; index < 4; index += 1) {
      const next = (index + 1) % 4;
      values.push(...base[index], ...base[next], ...apex);
    }
    return new Float32Array(values);
  }

  function cylinderVertices(segments = 16, topRadius = 1, bottomRadius = 1) {
    const values = [];
    const top = [0, 1, 0];
    const bottom = [0, -1, 0];
    for (let index = 0; index < segments; index += 1) {
      const a = index / segments * Math.PI * 2;
      const b = (index + 1) / segments * Math.PI * 2;
      const topA = [Math.cos(a) * topRadius, 1, Math.sin(a) * topRadius];
      const topB = [Math.cos(b) * topRadius, 1, Math.sin(b) * topRadius];
      const bottomA = [Math.cos(a) * bottomRadius, -1, Math.sin(a) * bottomRadius];
      const bottomB = [Math.cos(b) * bottomRadius, -1, Math.sin(b) * bottomRadius];
      values.push(...bottomA, ...bottomB, ...topB, ...bottomA, ...topB, ...topA);
      values.push(...top, ...topB, ...topA);
      values.push(...bottom, ...bottomA, ...bottomB);
    }
    return new Float32Array(values);
  }

  function sphereVertices(rows = 8, columns = 16) {
    const values = [];
    for (let row = 0; row < rows; row += 1) {
      const phiA = row / rows * Math.PI;
      const phiB = (row + 1) / rows * Math.PI;
      for (let column = 0; column < columns; column += 1) {
        const thetaA = column / columns * Math.PI * 2;
        const thetaB = (column + 1) / columns * Math.PI * 2;
        const point = (phi, theta) => [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
        const a = point(phiA, thetaA);
        const b = point(phiB, thetaA);
        const c = point(phiB, thetaB);
        const d = point(phiA, thetaB);
        values.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
    return new Float32Array(values);
  }

  function planeVertices() {
    return new Float32Array([
      -1, 0, -1, 1, 0, -1, 1, 0, 1,
      -1, 0, -1, 1, 0, 1, -1, 0, 1
    ]);
  }

  function ringVertices(segments = 24, innerRadius = 0.62) {
    const values = [];
    for (let index = 0; index < segments; index += 1) {
      const a = index / segments * Math.PI * 2;
      const b = (index + 1) / segments * Math.PI * 2;
      const outerA = [Math.cos(a), 0, Math.sin(a)];
      const outerB = [Math.cos(b), 0, Math.sin(b)];
      const innerA = [Math.cos(a) * innerRadius, 0, Math.sin(a) * innerRadius];
      const innerB = [Math.cos(b) * innerRadius, 0, Math.sin(b) * innerRadius];
      values.push(...outerA, ...outerB, ...innerB, ...outerA, ...innerB, ...innerA);
    }
    return new Float32Array(values);
  }

  function meshVertices(primitive = "box") {
    switch (String(primitive || "box")) {
      case "pyramid": return pyramidVertices();
      case "sphere": return sphereVertices();
      case "cylinder": return cylinderVertices();
      case "cone": return cylinderVertices(16, 0, 1);
      case "ring": return ringVertices();
      case "plane":
      case "water": return planeVertices();
      case "teleporter":
      case "beam": return cylinderVertices();
      default: return cubeVertices();
    }
  }

  function createWebGLShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "Unknown WebGL shader error";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function animationHost() {
    return typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {});
  }

  function requestFrame(callback) {
    const host = animationHost();
    return typeof host.requestAnimationFrame === "function" ? host.requestAnimationFrame(callback) : 0;
  }

  function cancelFrame(frame) {
    const host = animationHost();
    if (typeof host.cancelAnimationFrame === "function" && frame) host.cancelAnimationFrame(frame);
  }

  function localPlayer(snapshot) {
    const players = Array.isArray(snapshot?.players) ? snapshot.players : [];
    const requested = Number(snapshot?.localPlayerId);
    return players.find((player) => Number(player?.playerId) === requested) || (players.length === 1 ? players[0] : null);
  }

  function createUiState(snapshot, mode, status, error, worldData, stats = {}, fallbackReason = null) {
    const player = localPlayer(snapshot);
    const score = finite(player?.wins) - finite(player?.losses);
    const health = bounded(player?.health ?? player?.endurance ?? 100, 0, 100, 100);
    const geometry = snapshot?.worldGeometry;
    const worldObjectCount = Array.isArray(geometry?.objects) ? geometry.objects.length : 0;
    return {
      mode,
      status,
      error: error ? String(error.message || error) : null,
      fallbackReason: fallbackReason ? String(fallbackReason.message || fallbackReason) : null,
      revision: Number.isInteger(snapshot?.revision) ? snapshot.revision : 0,
      worldReady: worldObjectCount > 0,
      worldObjectCount,
      worldDataReady: Boolean(worldData?.geometryReady || worldData?.ready),
      players: Array.isArray(snapshot?.players) ? snapshot.players.length : 0,
      shots: Array.isArray(snapshot?.shots) ? snapshot.shots.length : 0,
      flags: Array.isArray(snapshot?.flags) ? snapshot.flags.length : 0,
      score,
      kills: Math.max(0, finite(player?.wins)),
      health,
      objectCount: finite(stats.objectCount),
      drawCalls: finite(stats.drawCalls),
      droppedObjects: finite(stats.droppedObjects)
    };
  }

  function updateRendererUI(canvas, state) {
    if (!canvas || !state) return;
    if (canvas.dataset) {
      canvas.dataset.rendererMode = state.mode;
      canvas.dataset.rendererStatus = state.status;
      canvas.dataset.worldData = state.worldReady ? "ready" : "pending";
      if (state.error) canvas.dataset.rendererError = state.error;
      else if (canvas.dataset.rendererError) delete canvas.dataset.rendererError;
    }
    const label = state.status === "error"
      ? `Renderer error: ${state.error || "unavailable"}`
      : `${state.mode} renderer, ${state.objectCount} scene objects`;
    canvas.setAttribute?.("aria-label", label);
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    const score = document.getElementById("score-value");
    if (score) score.textContent = String(state.score);
    const kills = document.getElementById("kills-value");
    if (kills) kills.textContent = String(state.kills);
    const health = document.getElementById("health-value");
    if (health) {
      health.style && (health.style.width = `${state.health}%`);
      health.parentElement?.setAttribute?.("aria-label", `Health ${state.health} percent`);
    }
    const connection = document.getElementById("connection-status");
    if (connection?.dataset) {
      connection.dataset.rendererMode = state.mode;
      connection.dataset.rendererStatus = state.status;
      if (state.error) connection.dataset.rendererError = state.error;
      else if (connection.dataset.rendererError) delete connection.dataset.rendererError;
    }
  }

  function observeCanvas(canvas, onResize) {
    if (typeof ResizeObserver === "undefined" || !canvas) return null;
    try {
      const observer = new ResizeObserver(onResize);
      observer.observe(canvas);
      return observer;
    } catch {
      return null;
    }
  }

  function makeWebGLRenderer(canvas, options = {}) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is not available");
    const vertex = createWebGLShader(gl, gl.VERTEX_SHADER, `#version 300 es
      uniform mat4 u_matrix;
      uniform vec3 u_scale;
      uniform vec3 u_position;
      uniform float u_rotation;
      in vec3 a_position;
      void main() {
        float c = cos(u_rotation); float s = sin(u_rotation);
        vec3 local = a_position * u_scale;
        local = vec3(c * local.x - s * local.z, local.y, s * local.x + c * local.z);
        gl_Position = u_matrix * vec4(local + u_position, 1.0);
      }
    `);
    const fragment = createWebGLShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform vec4 u_color;
      out vec4 color;
      void main() { color = u_color; }
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Unable to link WebGL2 renderer");
    const positionLocation = gl.getAttribLocation(program, "a_position");
    const matrixLocation = gl.getUniformLocation(program, "u_matrix");
    const scaleLocation = gl.getUniformLocation(program, "u_scale");
    const objectPositionLocation = gl.getUniformLocation(program, "u_position");
    const rotationLocation = gl.getUniformLocation(program, "u_rotation");
    const colorLocation = gl.getUniformLocation(program, "u_color");
    const meshes = new Map();
    const meshFor = (primitive) => {
      const key = String(primitive || "box");
      const cached = meshes.get(key);
      if (cached) return cached;
      const values = meshVertices(key);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
      const mesh = { buffer, count: values.length / 3 };
      meshes.set(key, mesh);
      return mesh;
    };
    let snapshot = DEFAULT_SNAPSHOT;
    let worldData = options.worldData || null;
    const getSceneObjects = createSceneObjectCache();
    const input = new Set();
    let stopped = false;
    let cleaned = false;
    let frame = 0;
    let lifecycle = "ready";
    let error = null;
    const stats = { objectCount: 0, drawCalls: 0, droppedObjects: 0 };
    let lastUi = createUiState(snapshot, "webgl2", lifecycle, error, worldData, stats, options.fallbackReason);
    const publish = () => {
      lastUi = createUiState(snapshot, "webgl2", lifecycle, error, worldData, stats, options.fallbackReason);
      updateRendererUI(canvas, lastUi);
      return lastUi;
    };
    const fail = (cause) => {
      if (lifecycle === "error") return;
      lifecycle = "error";
      error = cause instanceof Error ? cause : new Error(String(cause || "WebGL2 renderer failure"));
      stopped = true;
      cancelFrame(frame);
      publish();
      try { options.onError?.(error); } catch { /* consumer errors must not mask renderer failure */ }
    };
    const setWorldState = (state) => { snapshot = snapshotFromState(state); publish(); };
    const setWorldData = (data) => { worldData = data && typeof data === "object" ? { ...data } : null; publish(); };
    const handleInput = (command, phase) => { if (phase === "start") input.add(command); else input.delete(command); };
    const onContextLost = (event) => {
      event?.preventDefault?.();
      fail(new Error("WebGL2 context lost"));
    };
    canvas.addEventListener?.("webglcontextlost", onContextLost, false);
    const resizeObserver = observeCanvas(canvas, () => {
      if (stopped) return;
      resizeCanvas(canvas);
    });
    const draw = (time) => {
      if (stopped) return;
      try {
        resizeCanvas(canvas);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(0.008, 0.025, 0.04, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniformMatrix4fv(matrixLocation, false, cameraMatrix(canvas, time));
        const objects = getSceneObjects(snapshot, time);
        stats.objectCount = objects.length;
        stats.drawCalls = 0;
        for (const object of objects) {
          const mesh = meshFor(object.primitive);
          const size = object.size || [1, 1, 1];
          gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
          gl.enableVertexAttribArray(positionLocation);
          gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
          gl.uniform3f(scaleLocation, size[0] / 2, size[1] / 2, size[2] / 2);
          gl.uniform3f(objectPositionLocation, object.position[0], object.position[1], object.position[2]);
          gl.uniform1f(rotationLocation, object.rotation || 0);
          gl.uniform4fv(colorLocation, object.color || [1, 1, 1, 1]);
          gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
          stats.drawCalls += 1;
        }
        publish();
        frame = requestFrame(draw);
      } catch (cause) {
        fail(cause);
      }
    };
    publish();
    frame = requestFrame(draw);
    return {
      mode: "webgl2",
      get status() { return lifecycle; },
      setWorldState,
      setWorldData,
      handleInput,
      getUiState: () => lastUi,
      getStats: () => ({ ...stats }),
      stop() {
        if (cleaned) return;
        stopped = true;
        lifecycle = lifecycle === "error" ? lifecycle : "stopped";
        cancelFrame(frame);
        resizeObserver?.disconnect?.();
        canvas.removeEventListener?.("webglcontextlost", onContextLost, false);
        for (const mesh of meshes.values()) gl.deleteBuffer(mesh.buffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        cleaned = true;
      }
    };
  }

  async function makeWebGPURenderer(canvas, options = {}) {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav?.gpu) throw new Error("WebGPU is not available");
    const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas context is not available");
    const format = nav.gpu.getPreferredCanvasFormat();
    const bufferUsage = typeof GPUBufferUsage !== "undefined"
      ? GPUBufferUsage
      : { COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
    const textureUsage = typeof GPUTextureUsage !== "undefined"
      ? GPUTextureUsage
      : { RENDER_ATTACHMENT: 16 };
    const shaderStage = typeof GPUShaderStage !== "undefined"
      ? GPUShaderStage
      : { VERTEX: 1, FRAGMENT: 2 };
    const cameraBuffer = device.createBuffer({ size: 64, usage: bufferUsage.UNIFORM | bufferUsage.COPY_DST });
    const objectFloats = 12;
    const objectBytes = objectFloats * Float32Array.BYTES_PER_ELEMENT;
    const maxObjects = MAX_RENDER_OBJECTS;
    const objectBuffer = device.createBuffer({
      size: maxObjects * objectBytes,
      usage: bufferUsage.STORAGE | bufferUsage.COPY_DST
    });
    const cameraData = new Float32Array(16);
    const objectData = new Float32Array(maxObjects * objectFloats);
    const shader = device.createShaderModule({ code: `
      struct Camera { matrix: mat4x4f };
      struct ObjectData { scaleRotation: vec4f, position: vec4f, color: vec4f };
      @group(0) @binding(0) var<uniform> camera: Camera;
      @group(0) @binding(1) var<storage, read> objects: array<ObjectData>;
      struct Output { @builtin(position) position: vec4f, @location(0) color: vec4f };
      @vertex fn vertexMain(@location(0) input: vec3f, @builtin(instance_index) instance: u32) -> Output {
        let object = objects[instance];
        let c = cos(object.scaleRotation.w);
        let s = sin(object.scaleRotation.w);
        var local = input * object.scaleRotation.xyz;
        local = vec3f(c * local.x - s * local.z, local.y, s * local.x + c * local.z);
        var output: Output;
        output.position = camera.matrix * vec4f(local + object.position.xyz, 1.0);
        output.color = object.color;
        return output;
      }
      @fragment fn fragmentMain(@location(0) color: vec4f) -> @location(0) vec4f { return color; }
    ` });
    const bindGroupLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: shaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: shaderStage.VERTEX, buffer: { type: "read-only-storage" } }
    ] });
    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shader, entryPoint: "vertexMain", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: shader, entryPoint: "fragmentMain", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" }
    });
    const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 1, resource: { buffer: objectBuffer } }
    ] });
    const meshes = new Map();
    const meshFor = (primitive) => {
      const key = String(primitive || "box");
      const cached = meshes.get(key);
      if (cached) return cached;
      const values = meshVertices(key);
      const buffer = device.createBuffer({ size: values.byteLength, usage: bufferUsage.VERTEX | bufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, values);
      const mesh = { buffer, count: values.length / 3 };
      meshes.set(key, mesh);
      return mesh;
    };
    let depthTexture;
    const configure = () => {
      resizeCanvas(canvas);
      context.configure({ device, format, alphaMode: "opaque" });
      depthTexture?.destroy();
      depthTexture = device.createTexture({
        size: [canvas.width, canvas.height, 1],
        format: "depth24plus",
        usage: textureUsage.RENDER_ATTACHMENT
      });
    };
    configure();
    let snapshot = DEFAULT_SNAPSHOT;
    let worldData = options.worldData || null;
    const getSceneObjects = createSceneObjectCache();
    let stopped = false;
    let cleaned = false;
    let lifecycle = "ready";
    let error = null;
    let frame = 0;
    const stats = { objectCount: 0, drawCalls: 0, droppedObjects: 0 };
    let lastUi = createUiState(snapshot, "webgpu", lifecycle, error, worldData, stats, options.fallbackReason);
    const publish = () => {
      lastUi = createUiState(snapshot, "webgpu", lifecycle, error, worldData, stats, options.fallbackReason);
      updateRendererUI(canvas, lastUi);
      return lastUi;
    };
    const fail = (cause) => {
      if (lifecycle === "error") return;
      lifecycle = "error";
      error = cause instanceof Error ? cause : new Error(String(cause || "WebGPU renderer failure"));
      stopped = true;
      cancelFrame(frame);
      publish();
      try { options.onError?.(error); } catch { /* consumer errors must not mask renderer failure */ }
    };
    const setWorldState = (state) => { snapshot = snapshotFromState(state); publish(); };
    const setWorldData = (data) => { worldData = data && typeof data === "object" ? { ...data } : null; publish(); };
    const handleInput = () => {};
    const draw = (time) => {
      if (stopped) return;
      try {
        if (resizeCanvas(canvas)) configure();
        const matrix = cameraMatrix(canvas, time);
        cameraData.set(matrix);
        const objects = getSceneObjects(snapshot, time);
        const instanceCount = Math.min(objects.length, maxObjects);
        stats.objectCount = instanceCount;
        stats.droppedObjects = Math.max(0, objects.length - instanceCount);
        stats.drawCalls = 0;
        for (let index = 0; index < instanceCount; index += 1) {
          const object = objects[index];
          const offset = index * objectFloats;
          const size = object.size || [1, 1, 1];
          const position = object.position || [0, 0, 0];
          const color = object.color || [1, 1, 1, 1];
          objectData[offset] = (size[0] || 1) / 2;
          objectData[offset + 1] = (size[1] || 1) / 2;
          objectData[offset + 2] = (size[2] || 1) / 2;
          objectData[offset + 3] = finite(object.rotation);
          objectData[offset + 4] = position[0];
          objectData[offset + 5] = position[1];
          objectData[offset + 6] = position[2];
          objectData[offset + 7] = 0;
          objectData[offset + 8] = color[0];
          objectData[offset + 9] = color[1];
          objectData[offset + 10] = color[2];
          objectData[offset + 11] = color[3];
        }
        device.queue.writeBuffer(cameraBuffer, 0, cameraData);
        device.queue.writeBuffer(objectBuffer, 0, objectData, 0, instanceCount * objectBytes);
        const command = device.createCommandEncoder();
        const pass = command.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0.008, g: 0.025, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "store" }], depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
        for (let index = 0; index < instanceCount; index += 1) {
          const mesh = meshFor(objects[index].primitive);
          pass.setVertexBuffer(0, mesh.buffer);
          pass.draw(mesh.count, 1, 0, index);
          stats.drawCalls += 1;
        }
        pass.end();
        device.queue.submit([command.finish()]);
        publish();
        frame = requestFrame(draw);
      } catch (cause) {
        fail(cause);
      }
    };
    publish();
    frame = requestFrame(draw);
    if (device.lost && typeof device.lost.then === "function") {
      Promise.resolve(device.lost).then((info) => {
        if (!stopped) fail(new Error(`WebGPU device lost${info?.message ? `: ${info.message}` : ""}`));
      }).catch((cause) => {
        if (!stopped) fail(cause);
      });
    }
    const resizeObserver = observeCanvas(canvas, () => {
      if (stopped) return;
      resizeCanvas(canvas);
    });
    return {
      mode: "webgpu",
      get status() { return lifecycle; },
      setWorldState,
      setWorldData,
      handleInput,
      getUiState: () => lastUi,
      getStats: () => ({ ...stats }),
      stop() {
        if (cleaned) return;
        stopped = true;
        lifecycle = lifecycle === "error" ? lifecycle : "stopped";
        cancelFrame(frame);
        resizeObserver?.disconnect?.();
        depthTexture?.destroy();
        cameraBuffer.destroy();
        objectBuffer.destroy();
        for (const mesh of meshes.values()) mesh.buffer.destroy?.();
        device.destroy?.();
        cleaned = true;
      }
    };
  }

  async function createRenderer(canvas, options = {}) {
    const preferWebGPU = options.preferWebGPU !== false;
    let webGpuError = null;
    if (preferWebGPU) {
      try {
        return await makeWebGPURenderer(canvas, options);
      } catch (error) {
        webGpuError = error;
        console.info("WebGPU renderer unavailable; trying WebGL2", error);
      }
    }
    try {
      return makeWebGLRenderer(canvas, { ...options, fallbackReason: webGpuError || options.fallbackReason });
    } catch (error) {
      const rendererError = new Error(`No supported browser renderer is available${error?.message ? `: ${error.message}` : ""}`);
      console.warn(rendererError);
      const state = createUiState(DEFAULT_SNAPSHOT, "unavailable", "error", rendererError, null, {}, webGpuError);
      updateRendererUI(canvas, state);
      return {
        mode: "unavailable",
        status: "error",
        error: rendererError.message,
        setWorldState() {},
        setWorldData() {},
        handleInput() {},
        getUiState: () => state,
        getStats: () => ({ objectCount: 0, drawCalls: 0, droppedObjects: 0 }),
        stop() {}
      };
    }
  }

  window.BZFlagWebRenderer = {
    createRenderer,
    makeWebGLRenderer,
    makeWebGPURenderer,
    resizeCanvas,
    sceneObjects,
    geometryObjects,
    waterObjects,
    meshVertices,
    createUiState,
    MAX_RENDER_OBJECTS,
    MAX_WORLD_OBJECTS
  };
})();
