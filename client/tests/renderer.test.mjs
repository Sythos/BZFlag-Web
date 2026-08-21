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

import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const rendererPath = fileURLToPath(new URL("../dist/renderer.js", import.meta.url));
const source = await readFile(rendererPath, "utf8");

const domNodes = new Map();
for (const id of ["score-value", "kills-value", "health-value", "connection-status"]) {
  domNodes.set(id, {
    textContent: "",
    style: {},
    dataset: {},
    parentElement: { setAttribute() {} }
  });
}

const pendingFrames = [];
let nextFrame = 0;
const windowMock = {
  devicePixelRatio: 1,
  requestAnimationFrame(callback) {
    pendingFrames.push(callback);
    return ++nextFrame;
  },
  cancelAnimationFrame() {},
  BZFlagWebRenderer: null
};
const context = {
  Array,
  ArrayBuffer,
  Boolean,
  DataView,
  Error,
  Float32Array,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  Set,
  String,
  Uint8Array,
  console,
  document: { getElementById: (id) => domNodes.get(id) || null },
  navigator: { gpu: null },
  window: windowMock
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "dist/renderer.js" });
const renderer = context.window.BZFlagWebRenderer;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function flushFrame(time = 1000) {
  const callback = pendingFrames.shift();
  if (callback) callback(time);
}

function createCanvas({ webgl = null, webgpu = null } = {}) {
  const listeners = new Map();
  const attributes = {};
  return {
    width: 300,
    height: 150,
    clientWidth: 300,
    clientHeight: 150,
    dataset: {},
    getBoundingClientRect() { return { width: 300, height: 150 }; },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name]; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    getContext(kind) {
      if (kind === "webgl2") return webgl;
      if (kind === "webgpu") return webgpu;
      return null;
    }
  };
}

function createFakeWebGL() {
  let drawCount = 0;
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    DEPTH_TEST: 9,
    CULL_FACE: 10,
    BLEND: 11,
    SRC_ALPHA: 12,
    ONE_MINUS_SRC_ALPHA: 13,
    COLOR_BUFFER_BIT: 14,
    DEPTH_BUFFER_BIT: 15,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader() {},
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram() {},
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() {},
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    viewport() {},
    enable() {},
    blendFunc() {},
    clearColor() {},
    clear() {},
    useProgram() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    uniformMatrix4fv() {},
    uniform3f() {},
    uniform1f() {},
    uniform4fv() {},
    drawArrays() { drawCount += 1; }
  };
  Object.defineProperty(gl, "drawCount", { get: () => drawCount });
  return gl;
}

function createFakeWebGPU() {
  let drawCount = 0;
  let resolveLost;
  const lost = new Promise((resolve) => { resolveLost = resolve; });
  const device = {
    lost,
    queue: { writeBuffer() {}, submit() {} },
    createBuffer: () => ({ destroy() {} }),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createCommandEncoder: () => ({
      beginRenderPass() {
        return {
          setPipeline() {},
          setVertexBuffer() {},
          setBindGroup() {},
          draw() { drawCount += 1; },
          end() {}
        };
      },
      finish: () => ({})
    }),
    destroy() {}
  };
  const adapter = { requestDevice: async () => device };
  const gpu = {
    requestAdapter: async () => adapter,
    getPreferredCanvasFormat: () => "bgra8unorm"
  };
  return {
    gpu,
    device,
    resolveLost,
    drawCount: () => drawCount,
    context: { configure() {}, getCurrentTexture: () => ({ createView: () => ({}) }) }
  };
}

const snapshot = {
  revision: 7,
  localPlayerId: 3,
  players: [{ playerId: 3, team: 3, wins: 12, losses: 4, health: 73, alive: true, status: 1, position: [4, 5, 1], azimuth: 0.75 }],
  shots: [{ playerId: 3, shotId: 8, team: 3, flag: "SW", position: [6, 7, 0.4] }],
  flags: [{ flagIndex: 1, flagType: "R*", position: [2, 3, 0] }],
  messages: [],
  water: { level: -1.5, size: [40, 32] },
  worldGeometry: {
    source: "wasm-decoder",
    mapVersion: 3,
    objects: [
      { id: "box-1", kind: "box", position: [10, 20, 3], size: [4, 6, 2], rotation: 0.25 },
      { id: "teleporter-1", kind: "teleporter", position: [0, 4, 0], size: [2, 2, 5], rotation: 1 },
      { id: "pyramid-1", kind: "pyramid", position: [-4, 3, 0], size: [3, 3, 3] }
    ]
  }
};

const first = renderer.sceneObjects(snapshot, 1000);
const second = renderer.sceneObjects(snapshot, 1000);
assert(JSON.stringify(first) === JSON.stringify(second), "renderer scene generation is not deterministic");
assert(first.some((object) => object.kind === "world-box"), "decoded box geometry was not rendered");
assert(first.some((object) => object.kind === "world-pyramid" && object.primitive === "pyramid"), "pyramid geometry did not select a pyramid mesh");
assert(first.some((object) => object.kind === "world-teleporter-ring"), "teleporter geometry did not produce its visible ring");
assert(first.some((object) => object.kind === "world-teleporter-beam"), "teleporter geometry did not produce its beam");
assert(first.some((object) => object.kind === "water" && object.primitive === "water"), "authoritative water metadata was not rendered");
assert(first.some((object) => object.kind === "tank-body"), "authoritative player tank body was not rendered");
assert(first.some((object) => object.kind === "tank-turret"), "authoritative player turret was not rendered");
assert(first.filter((object) => object.kind === "tank-track").length === 2, "tank tracks were not rendered symmetrically");
assert(first.some((object) => object.kind === "shot" && object.primitive === "sphere") && first.some((object) => object.kind === "shot-glow"), "shot and shot glow were not rendered");
assert(first.some((object) => object.kind === "flag-pole" && object.primitive === "cylinder") && first.some((object) => object.kind === "flag-cloth"), "flag pole and cloth were not rendered");
const box = first.find((object) => object.kind === "world-box");
assert(box.position[0] === 10 && box.position[1] === 3 && box.position[2] === 20, "world coordinates were not mapped to renderer coordinates");
assert(box.size[0] === 4 && box.size[1] === 2 && box.size[2] === 6, "world dimensions were not mapped to renderer dimensions");
assert(renderer.meshVertices("pyramid").length !== renderer.meshVertices("box").length, "primitive mesh selection collapsed to the cube mesh");
assert(renderer.meshVertices("sphere").length > renderer.meshVertices("box").length, "sphere mesh was not generated");
const empty = renderer.sceneObjects({ revision: 0, players: [], shots: [], flags: [], worldGeometry: null }, 0);
assert(empty.length === 0, "renderer still injects a placeholder scene without authoritative data");
assert(empty.length <= renderer.MAX_RENDER_OBJECTS, "renderer scene budget is not exposed or enforced");

const fakeGl = createFakeWebGL();
const webglCanvas = createCanvas({ webgl: fakeGl });
const webglRenderer = renderer.makeWebGLRenderer(webglCanvas, { worldData: { geometryReady: false } });
webglRenderer.setWorldState(snapshot);
flushFrame();
assert(webglRenderer.mode === "webgl2", "WebGL2 backend did not initialize");
assert(webglRenderer.getUiState().status === "ready", "WebGL2 renderer did not publish ready status");
assert(webglRenderer.getUiState().objectCount > 0 && webglRenderer.getUiState().drawCalls > 0, "WebGL2 backend did not draw authoritative scene objects");
assert(fakeGl.drawCount > 0, "WebGL2 mock did not receive draw calls");
assert(webglRenderer.getUiState().worldDataReady === false, "renderer masked missing world decoder data");
let prevented = false;
webglCanvas.dispatchEvent({ type: "webglcontextlost", preventDefault() { prevented = true; } });
assert(prevented && webglRenderer.getUiState().status === "error", "WebGL2 context loss did not enter explicit error state");
webglRenderer.stop();
pendingFrames.length = 0;

const fakeGpu = createFakeWebGPU();
context.navigator.gpu = fakeGpu.gpu;
context.GPUBufferUsage = { COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
context.GPUTextureUsage = { RENDER_ATTACHMENT: 16 };
context.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
const webgpuCanvas = createCanvas({ webgpu: fakeGpu.context });
const webgpuRenderer = await renderer.makeWebGPURenderer(webgpuCanvas);
webgpuRenderer.setWorldState(snapshot);
flushFrame();
assert(webgpuRenderer.mode === "webgpu", "WebGPU backend did not initialize");
assert(webgpuRenderer.getUiState().status === "ready", "WebGPU renderer did not publish ready status");
assert(webgpuRenderer.getUiState().drawCalls > 0 && fakeGpu.drawCount() > 0, "WebGPU mock did not draw primitive scene objects");
fakeGpu.resolveLost({ reason: "destroyed", message: "test loss" });
await Promise.resolve();
await Promise.resolve();
assert(webgpuRenderer.getUiState().status === "error" && webgpuRenderer.getUiState().error.includes("test loss"), "WebGPU device loss did not enter explicit error state");
webgpuRenderer.stop();
pendingFrames.length = 0;

context.navigator.gpu = { requestAdapter: async () => null, getPreferredCanvasFormat: () => "bgra8unorm" };
const unavailable = await renderer.createRenderer(createCanvas(), { preferWebGPU: true });
assert(unavailable.mode === "unavailable" && unavailable.getUiState().status === "error", "unsupported backend path did not publish an actionable error");
assert(unavailable.getUiState().error.includes("No supported"), "unsupported backend error did not explain the failure");

console.log("Client renderer checks passed (WebGPU/WebGL2 mocks, authoritative scene, lifecycle and budgets).");
