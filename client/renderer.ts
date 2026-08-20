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

  const DEFAULT_SNAPSHOT = Object.freeze({
    revision: 0,
    localPlayerId: 0,
    players: [{ playerId: 0, team: 1, alive: true, position: [0, 0, 0], azimuth: 0, status: 1 }],
    shots: [],
    flags: [],
    messages: [],
    worldGeometry: null
  });

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function vector(value) {
    const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value : [0, 0, 0];
    return [finite(source[0]), finite(source[1]), finite(source[2])];
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

  function geometryObjects(snapshot) {
    const source = snapshot?.worldGeometry || snapshot?.geometry;
    const records = Array.isArray(source?.objects) ? source.objects.slice(0, 4096) : [];
    const objects = [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const position = vector(record.position);
      const size = vector(record.size).map((value) => Math.min(1_000_000, Math.max(0.01, Math.abs(value))));
      const kind = String(record.kind || "mesh").toLowerCase();
      objects.push({
        id: record.id,
        position: [position[0], position[2], position[1]],
        size: [size[0], size[2], size[1]],
        rotation: finite(record.rotation),
        color: geometryColor({ ...record, kind }),
        kind: `world-${kind}`
      });
      if (kind === "teleporter") {
        objects.push({
          position: [position[0], position[2] + size[2] * 0.55, position[1]],
          size: [size[0] * 1.35, Math.max(0.08, size[2] * 0.08), size[1] * 1.35],
          rotation: finite(record.rotation),
          color: [0.28, 0.92, 0.96, 0.72],
          kind: "world-teleporter-ring"
        });
      }
    }
    return objects;
  }

  function resizeCanvas(canvas) {
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect?.() || { width: canvas.clientWidth || 640, height: canvas.clientHeight || 360 };
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
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
      players: Array.isArray(snapshot.players) && snapshot.players.length ? snapshot.players.slice(0, 216) : DEFAULT_SNAPSHOT.players,
      shots: Array.isArray(snapshot.shots) ? snapshot.shots.slice(0, 512) : [],
      flags: Array.isArray(snapshot.flags) ? snapshot.flags.slice(0, 256) : [],
      messages: Array.isArray(snapshot.messages) ? snapshot.messages.slice(-128) : [],
      worldGeometry: snapshot.worldGeometry && Array.isArray(snapshot.worldGeometry.objects)
        ? { ...snapshot.worldGeometry, objects: snapshot.worldGeometry.objects.slice(0, 4096) }
        : null
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
      // Keep the preview animation alive before the first authoritative packet;
      // authoritative WorldState snapshots are immutable between revisions.
      if (nextRevision === 0 || nextRevision !== revision) {
        objects = sceneObjects(snapshot, time);
        revision = nextRevision;
      }
      return objects;
    };
  }

  function sceneObjects(snapshot, time) {
    const objects = [];
    objects.push({ position: [0, -0.35, 0], size: [24, 0.3, 18], color: [0.06, 0.13, 0.18, 1] });
    for (let x = -10; x <= 10; x += 2) {
      objects.push({ position: [x, -0.18, 0], size: [0.012, 0.012, 18], color: [0.10, 0.26, 0.31, 0.65] });
    }
    for (let z = -8; z <= 8; z += 2) {
      objects.push({ position: [0, -0.17, z], size: [24, 0.012, 0.012], color: [0.10, 0.26, 0.31, 0.65] });
    }
    objects.push(...geometryObjects(snapshot));
    for (const player of snapshot.players) {
      const position = vector(player.position);
      const alive = player.alive !== false && (Number(player.status) & 1) !== 0;
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
        playerId: player.playerId
      });
      objects.push({
        position: [position[0], Math.max(0.75, position[2] + 1.1), position[1]],
        size: [0.46, 0.28, 0.78],
        rotation,
        color: [0.66, 0.73, 0.78, 1],
        kind: "tank-turret",
        playerId: player.playerId
      });
      objects.push({
        position: [position[0], Math.max(0.86, position[2] + 1.25), position[1]],
        size: [0.18, 0.18, 1.0],
        rotation,
        color: [0.75, 0.82, 0.86, 1],
        kind: "tank-barrel",
        playerId: player.playerId
      });
      for (const side of [-1, 1]) {
        objects.push({
          position: [position[0] + lateralX * side, Math.max(0.18, position[2] + 0.38), position[1] + lateralZ * side],
          size: [0.20, 0.42, 1.40],
          rotation,
          color: [0.12, 0.16, 0.20, 1],
          kind: "tank-track",
          playerId: player.playerId
        });
      }
    }
    for (const shot of snapshot.shots) {
      const position = vector(shot.position);
      const color = String(shot.flag || "").length > 0 ? flagColor(shot.flag) : teamColor(shot.team);
      objects.push({ position: [position[0], position[2] + 0.2, position[1]], size: [0.18, 0.18, 0.55], color, kind: "shot" });
      objects.push({ position: [position[0], position[2] + 0.2, position[1]], size: [0.34, 0.34, 0.34], color: [color[0], color[1], color[2], 0.22], kind: "shot-glow" });
    }
    for (const flag of snapshot.flags) {
      const position = vector(flag.position || flag.landingPosition);
      const color = flagColor(flag.flagType);
      objects.push({ position: [position[0], position[2] + 0.9, position[1]], size: [0.12, 1.8, 0.12], color: [0.80, 0.80, 0.84, 1], kind: "flag-pole" });
      objects.push({ position: [position[0] + 0.32, position[2] + 1.5, position[1]], size: [0.65, 0.35, 0.08], color, kind: "flag-cloth" });
      objects.push({ position: [position[0], position[2] + 0.08, position[1]], size: [0.42, 0.08, 0.42], color: [color[0], color[1], color[2], 0.72], kind: "flag-base" });
    }
    if (snapshot.players.length === 1 && snapshot.revision === 0) {
      const pulse = Math.sin(time * 0.002) * 0.25;
      objects.push({ position: [5, 0.35 + pulse, -2], size: [1.2, 0.7, 1.2], color: [0.15, 0.62, 0.66, 0.7], kind: "preview" });
    }
    return objects;
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

  function makeWebGLRenderer(canvas) {
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
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, cubeVertices(), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "a_position");
    const matrixLocation = gl.getUniformLocation(program, "u_matrix");
    const scaleLocation = gl.getUniformLocation(program, "u_scale");
    const objectPositionLocation = gl.getUniformLocation(program, "u_position");
    const rotationLocation = gl.getUniformLocation(program, "u_rotation");
    const colorLocation = gl.getUniformLocation(program, "u_color");
    let snapshot = DEFAULT_SNAPSHOT;
    const getSceneObjects = createSceneObjectCache();
    let input = new Set();
    let stopped = false;
    let frame = 0;
    const setWorldState = (state) => { snapshot = snapshotFromState(state); };
    const handleInput = (command, phase) => { if (phase === "start") input.add(command); else input.delete(command); };
    const draw = (time) => {
      if (stopped) return;
      resizeCanvas(canvas);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.DEPTH_TEST);
      gl.clearColor(0.008, 0.025, 0.04, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(matrixLocation, false, cameraMatrix(canvas, time));
      for (const object of getSceneObjects(snapshot, time)) {
        const size = object.size || [1, 1, 1];
        gl.uniform3f(scaleLocation, size[0] / 2, size[1] / 2, size[2] / 2);
        gl.uniform3f(objectPositionLocation, object.position[0], object.position[1], object.position[2]);
        gl.uniform1f(rotationLocation, object.rotation || 0);
        gl.uniform4fv(colorLocation, object.color || [1, 1, 1, 1]);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      }
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return {
      mode: "webgl2",
      setWorldState,
      handleInput,
      stop() {
        if (stopped) return;
        stopped = true;
        window.cancelAnimationFrame(frame);
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
      }
    };
  }

  async function makeWebGPURenderer(canvas) {
    if (!navigator.gpu) throw new Error("WebGPU is not available");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter is available");
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("WebGPU canvas context is not available");
    const format = navigator.gpu.getPreferredCanvasFormat();
    const vertices = cubeVertices();
    const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertexBuffer, 0, vertices);
    const cameraBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const objectFloats = 12;
    const objectBytes = objectFloats * Float32Array.BYTES_PER_ELEMENT;
    const maxObjects = 2048;
    const objectBuffer = device.createBuffer({
      size: maxObjects * objectBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
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
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }
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
    let depthTexture;
    const configure = () => {
      resizeCanvas(canvas);
      context.configure({ device, format, alphaMode: "opaque" });
      depthTexture?.destroy();
      depthTexture = device.createTexture({
        size: [canvas.width, canvas.height, 1],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
    };
    configure();
    let snapshot = DEFAULT_SNAPSHOT;
    const getSceneObjects = createSceneObjectCache();
    let stopped = false;
    let frame = 0;
    const setWorldState = (state) => { snapshot = snapshotFromState(state); };
    const handleInput = () => {};
    const draw = (time) => {
      if (stopped) return;
      if (resizeCanvas(canvas)) configure();
      const matrix = cameraMatrix(canvas, time);
      cameraData.set(matrix);
      const objects = getSceneObjects(snapshot, time);
      const instanceCount = Math.min(objects.length, maxObjects);
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
      pass.setPipeline(pipeline); pass.setVertexBuffer(0, vertexBuffer); pass.setBindGroup(0, bindGroup);
      pass.draw(36, instanceCount);
      pass.end(); device.queue.submit([command.finish()]); frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    device.lost.catch(() => { stopped = true; });
    return {
      mode: "webgpu",
      setWorldState,
      handleInput,
      stop() {
        if (stopped) return;
        stopped = true;
        window.cancelAnimationFrame(frame);
        depthTexture?.destroy();
        cameraBuffer.destroy();
        objectBuffer.destroy();
        vertexBuffer.destroy();
        device.destroy?.();
      }
    };
  }

  async function createRenderer(canvas, options = {}) {
    const preferWebGPU = options.preferWebGPU !== false;
    if (preferWebGPU) {
      try { return await makeWebGPURenderer(canvas); } catch (error) { console.info("WebGPU renderer unavailable; trying WebGL2", error); }
    }
    try { return makeWebGLRenderer(canvas); } catch (error) { console.warn("No supported browser renderer is available", error); return { mode: "unavailable", setWorldState() {}, handleInput() {}, stop() {} }; }
  }

  window.BZFlagWebRenderer = { createRenderer, makeWebGLRenderer, makeWebGPURenderer, resizeCanvas, sceneObjects, geometryObjects };
})();
