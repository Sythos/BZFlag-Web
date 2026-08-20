// @ts-nocheck
/*
Copyright (c) 2026 Sythos (https://www.sythos.net)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(() => {
  "use strict";

  function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width === width && canvas.height === height) {
      return false;
    }
    canvas.width = width;
    canvas.height = height;
    return true;
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

  function createWebGLRenderer(canvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, powerPreference: "high-performance" });
    if (!gl) {
      throw new Error("WebGL2 is not available");
    }
    const vertexShader = createWebGLShader(gl, gl.VERTEX_SHADER, `#version 300 es
      const vec2 positions[3] = vec2[3](vec2(-0.72, -0.58), vec2(0.72, -0.58), vec2(0.0, 0.76));
      void main() { gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0); }
    `);
    const fragmentShader = createWebGLShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      out vec4 color;
      uniform float time;
      void main() {
        float pulse = 0.5 + 0.5 * sin(time * 1.2);
        color = vec4(0.08 + pulse * 0.08, 0.62 + pulse * 0.10, 0.64 + pulse * 0.16, 1.0);
      }
    `);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Unable to link WebGL2 renderer");
    }
    const timeLocation = gl.getUniformLocation(program, "time");
    let frameHandle = 0;
    let stopped = false;
    const draw = (time) => {
      if (stopped) {
        return;
      }
      resizeCanvas(canvas);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.012, 0.045, 0.075, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform1f(timeLocation, time / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frameHandle = window.requestAnimationFrame(draw);
    };
    frameHandle = window.requestAnimationFrame(draw);
    return {
      mode: "webgl2",
      stop() {
        stopped = true;
        window.cancelAnimationFrame(frameHandle);
        gl.deleteProgram(program);
        gl.deleteShader(vertexShader);
        gl.deleteShader(fragmentShader);
      }
    };
  }

  async function createWebGPURenderer(canvas) {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available");
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("No WebGPU adapter is available");
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      throw new Error("WebGPU canvas context is not available");
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    const shader = device.createShaderModule({ code: `
      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec3f,
      };
      @vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
        var positions = array<vec2f, 3>(vec2f(-0.72, -0.58), vec2f(0.72, -0.58), vec2f(0.0, 0.76));
        var output: VertexOutput;
        output.position = vec4f(positions[index], 0.0, 1.0);
        output.color = vec3f(0.10, 0.72, 0.66);
        return output;
      }
      @fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        return vec4f(input.color, 1.0);
      }
    ` });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: shader, entryPoint: "vertexMain" },
      fragment: { module: shader, entryPoint: "fragmentMain", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
    let frameHandle = 0;
    let stopped = false;
    const configure = () => {
      resizeCanvas(canvas);
      context.configure({ device, format, alphaMode: "opaque" });
    };
    configure();
    const draw = () => {
      if (stopped) {
        return;
      }
      if (resizeCanvas(canvas)) {
        context.configure({ device, format, alphaMode: "opaque" });
      }
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.012, g: 0.045, b: 0.075, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }]
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      frameHandle = window.requestAnimationFrame(draw);
    };
    frameHandle = window.requestAnimationFrame(draw);
    device.lost.then(() => {
      stopped = true;
      window.cancelAnimationFrame(frameHandle);
    });
    return {
      mode: "webgpu",
      stop() {
        stopped = true;
        window.cancelAnimationFrame(frameHandle);
        device.destroy?.();
      }
    };
  }

  async function createRenderer(canvas, options = {}) {
    const preferWebGPU = options.preferWebGPU !== false;
    if (preferWebGPU) {
      try {
        return await createWebGPURenderer(canvas);
      } catch (error) {
        console.info("WebGPU renderer unavailable; trying WebGL2", error);
      }
    }
    try {
      return createWebGLRenderer(canvas);
    } catch (error) {
      console.warn("No supported browser renderer is available", error);
      return { mode: "unavailable", stop() {} };
    }
  }

  window.BZFlagWebRenderer = {
    createRenderer,
    createWebGLRenderer,
    createWebGPURenderer,
    resizeCanvas
  };
})();
