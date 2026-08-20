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

  const CONNECTION_KEY = "bzflag-web.connection.v1";
  const BRIDGE_MAGIC = new Uint8Array([0x42, 0x5a, 0x57, 0x42]);
  const BRIDGE_VERSION = 1;
  const CHANNEL_TCP = 0;
  const CHANNEL_UDP = 1;
  const COMMAND_MAP = {
    ArrowUp: "move-forward",
    KeyW: "move-forward",
    ArrowDown: "move-backward",
    KeyS: "move-backward",
    ArrowLeft: "turn-left",
    KeyA: "turn-left",
    ArrowRight: "turn-right",
    KeyD: "turn-right",
    Space: "fire",
    KeyF: "drop-flag",
    Tab: "toggle-scoreboard",
    KeyT: "open-chat",
    Escape: "open-menu"
  };

  const get = (id) => document.getElementById(id);
  const t = (key) => window.BZFlagWebI18n?.t(key) || key;

  function readConnection() {
    try {
      const raw = window.sessionStorage.getItem(CONNECTION_KEY);
      const connection = raw ? JSON.parse(raw) : null;
      return connection && typeof connection === "object" ? connection : null;
    } catch {
      return null;
    }
  }

  function safeText(value, fallback = "—") {
    return value === undefined || value === null || value === "" ? fallback : String(value);
  }

  function toWebSocketUrl(endpoint, connection = {}) {
    const value = String(endpoint || "/bridge").trim();
    let resolved;
    if (/^(?:wss?|https?):\/\//i.test(value)) {
      resolved = new URL(value);
      if (resolved.protocol === "http:") resolved.protocol = "ws:";
      if (resolved.protocol === "https:") resolved.protocol = "wss:";
    } else {
      resolved = new URL(value || "/bridge", window.location.href);
      resolved.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(connection.serverId || ""))) {
      throw new Error("A valid allowlisted server ID is required");
    }
    const token = String(connection.sessionToken || resolved.searchParams.get("token") || "").trim();
    if (!token) {
      throw new Error("A gateway session token is required");
    }
    resolved.searchParams.set("server", connection.serverId);
    resolved.searchParams.set("token", token);
    return resolved.toString();
  }

  function toUint8Array(payload) {
    if (payload instanceof Uint8Array) {
      return payload;
    }
    if (payload instanceof ArrayBuffer) {
      return new Uint8Array(payload);
    }
    return new TextEncoder().encode(String(payload || ""));
  }

  function encodeBridgeMessage(channel, payload) {
    if (channel !== CHANNEL_TCP && channel !== CHANNEL_UDP) {
      throw new Error("Unsupported bridge channel");
    }
    const body = toUint8Array(payload);
    const message = new Uint8Array(8 + body.byteLength);
    message.set(BRIDGE_MAGIC, 0);
    message[4] = BRIDGE_VERSION;
    message[5] = channel;
    message[6] = 0;
    message[7] = 0;
    message.set(body, 8);
    return message;
  }

  function decodeBridgeMessage(payload) {
    const message = toUint8Array(payload);
    if (message.byteLength < 8 || !BRIDGE_MAGIC.every((value, index) => message[index] === value)) {
      throw new Error("Invalid BZWB bridge envelope");
    }
    if (message[4] !== BRIDGE_VERSION || message[6] !== 0 || message[7] !== 0) {
      throw new Error("Unsupported BZWB bridge envelope");
    }
    if (message[5] !== CHANNEL_TCP && message[5] !== CHANNEL_UDP) {
      throw new Error("Unsupported BZWB channel");
    }
    return { channel: message[5], payload: message.slice(8) };
  }

  function setStatus(message, kind = "") {
    const status = get("connection-status");
    if (!status) {
      return;
    }
    status.className = `connection-status ${kind}`.trim();
    status.replaceChildren();
    const dot = document.createElement("span");
    dot.className = `status-dot ${kind === "error" ? "danger" : kind === "warning" ? "warning" : ""}`.trim();
    dot.setAttribute("aria-hidden", "true");
    status.append(dot, document.createTextNode(message));
  }

  function appendEvent(message, kind = "info") {
    const feed = get("event-feed");
    if (!feed) {
      return;
    }
    const line = document.createElement("p");
    line.dataset.kind = kind;
    line.textContent = message;
    feed.replaceChildren(line);
  }

  class AudioEngine {
    constructor(enabled = true) {
      this.enabled = enabled;
      this.volume = 0.7;
      this.context = null;
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      this.updateState();
    }

    setVolume(value) {
      this.volume = Number(value);
    }

    async resume() {
      if (!this.enabled) {
        return;
      }
      if (!this.context) {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) {
          return;
        }
        this.context = new AudioContextConstructor();
      }
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
    }

    async beep(frequency = 360, duration = 0.05) {
      if (!this.enabled) {
        return;
      }
      await this.resume();
      if (!this.context) {
        return;
      }
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(Math.max(0.001, this.volume * 0.08), this.context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
      oscillator.connect(gain).connect(this.context.destination);
      oscillator.start();
      oscillator.stop(this.context.currentTime + duration);
    }

    updateState() {
      const label = get("audio-state");
      const toggle = get("audio-toggle");
      if (label) {
        label.textContent = this.enabled ? t("audioOn") : t("audioOff");
      }
      if (toggle) {
        toggle.setAttribute("aria-pressed", String(this.enabled));
      }
    }
  }

  function updateSessionDetails(connection) {
    const nickname = safeText(connection?.nickname, "Player");
    const server = connection?.serverId ? `${connection.serverId}${connection.port ? `:${connection.port}` : ""}` : "Gateway session";
    const gateway = safeText(connection?.gateway, "/bridge");
    const team = safeText(connection?.team, "automatic");
    get("session-player").textContent = nickname;
    get("session-server").textContent = server;
    get("sidebar-player").textContent = nickname;
    get("sidebar-server").textContent = server;
    get("sidebar-team").textContent = team;
    get("sidebar-gateway").textContent = gateway;
  }

  function connectGateway(connection, onMessage) {
    let socket;
    try {
      socket = new WebSocket(toWebSocketUrl(connection?.gateway, connection));
    } catch (error) {
      const message = error.message === "A gateway session token is required" ? t("missingSessionToken") : t("invalidGateway");
      setStatus(message, "error");
      appendEvent(message, "error");
      return null;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      setStatus(t("connected"), "success");
      appendEvent(`Binary BZWB bridge ready for server ID ${safeText(connection?.serverId)}.`);
      const protocol = window.BZFlagWebProtocol;
      if (protocol?.encodeEnter) {
        socket.send(encodeBridgeMessage(CHANNEL_TCP, protocol.encodeEnter(connection)));
        appendEvent("BZFlag enter packet sent.");
      }
    });
    socket.addEventListener("message", (event) => onMessage(event.data));
    socket.addEventListener("error", () => {
      setStatus(t("gatewayUnavailable"), "warning");
      appendEvent(t("gatewayUnavailable"), "warning");
    });
    socket.addEventListener("close", () => {
      setStatus(t("disconnected"), "warning");
    });
    return socket;
  }

  function handleGatewayMessage(data) {
    try {
      const bridge = decodeBridgeMessage(data);
      const protocol = window.BZFlagWebProtocol;
      if (protocol?.consume) {
        protocol.consume(bridge.channel, bridge.payload);
      } else {
        appendEvent(`Received ${bridge.payload.byteLength} bytes on ${bridge.channel === CHANNEL_UDP ? "UDP" : "TCP"} bridge channel.`);
      }
    } catch (error) {
      /* Text frames are intentionally not accepted: the gateway rejects them
         and the browser client must remain binary-only for protocol safety. */
      appendEvent(error.message || "Invalid binary bridge frame", "error");
    }
  }

  function bindKeyboard(socket, audio) {
    const pressed = new Set();
    const sendCommand = (command, phase, key) => {
      const protocol = window.BZFlagWebProtocol;
      if (socket?.readyState === WebSocket.OPEN && protocol?.encodeInput) {
        const payload = protocol.encodeInput(command, phase, key);
        if (payload) {
          socket.send(encodeBridgeMessage(CHANNEL_TCP, payload));
        }
      }
      appendEvent(`${command} (${phase})`);
    };
    const handleKeyDown = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      const command = COMMAND_MAP[event.code];
      if (!command) {
        return;
      }
      event.preventDefault();
      if (pressed.has(event.code)) {
        return;
      }
      pressed.add(event.code);
      sendCommand(command, "start", event.code);
      if (command === "fire") {
        audio.beep(420, 0.06);
      }
    };
    const handleKeyUp = (event) => {
      const command = COMMAND_MAP[event.code];
      if (!command) {
        return;
      }
      pressed.delete(event.code);
      sendCommand(command, "end", event.code);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }

  function bindControls(audio, renderer) {
    const audioToggle = get("audio-toggle");
    const volume = get("volume");
    const fullscreen = get("fullscreen-button");
    const disconnect = get("disconnect-button");
    audioToggle?.addEventListener("click", async () => {
      audio.setEnabled(!audio.enabled);
      if (audio.enabled) {
        await audio.resume();
        audio.beep(540, 0.04);
      }
    });
    volume?.addEventListener("input", () => audio.setVolume(volume.value));
    fullscreen?.addEventListener("click", async () => {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    });
    disconnect?.addEventListener("click", () => {
      renderer?.stop();
      window.sessionStorage.removeItem(CONNECTION_KEY);
      window.location.assign("./index.html");
    });
  }

  function updateRendererStatus(mode) {
    const badge = get("renderer-badge");
    const label = get("renderer-label");
    const webgpuState = get("webgpu-state");
    const webglState = get("webgl-state");
    if (badge) badge.dataset.mode = mode;
    if (label) label.textContent = mode === "webgpu" ? "WebGPU" : mode === "webgl2" ? "WebGL2 fallback" : "Renderer unavailable";
    if (webgpuState) webgpuState.textContent = mode === "webgpu" ? "active" : "ready";
    if (webglState) webglState.textContent = mode === "webgl2" ? "active" : "ready";
    get("renderer-choice-primary")?.classList.toggle("active", mode === "webgpu");
    get("renderer-choice-fallback")?.classList.toggle("active", mode === "webgl2");
    if (mode === "webgl2") appendEvent(t("webgpuUnavailable"), "warning");
    if (mode === "unavailable") appendEvent(t("webglUnavailable"), "error");
  }

  async function init() {
    if (document.documentElement.dataset.page !== "game") {
      return;
    }
    const connection = readConnection() || {
      nickname: "Preview player",
      serverId: "official-main",
      port: 5154,
      gateway: "/bridge",
      team: "automatic",
      audioEnabled: true,
      preferWebGPU: true
    };
    updateSessionDetails(connection);
    const audio = new AudioEngine(connection.audioEnabled !== false);
    audio.updateState();
    const canvas = get("game-canvas");
    const renderer = await window.BZFlagWebRenderer.createRenderer(canvas, { preferWebGPU: connection.preferWebGPU !== false });
    updateRendererStatus(renderer.mode);
    bindControls(audio, renderer);
    const socket = connectGateway(connection, handleGatewayMessage);
    bindKeyboard(socket, audio);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(() => {
        /* A static HTTP deployment may not provide a secure context. */
      });
    }
    if (!socket) {
      setStatus(t("gatewayUnavailable"), "warning");
    }
    if (connection.audioEnabled !== false) {
      audio.updateState();
    }
    document.dispatchEvent(new CustomEvent("bzflag:game-ready", { detail: { renderer: renderer.mode, connection } }));
  }

  window.BZFlagWebGame = {
    BRIDGE_MAGIC,
    BRIDGE_VERSION,
    CHANNEL_TCP,
    CHANNEL_UDP,
    COMMAND_MAP,
    CONNECTION_KEY,
    AudioEngine,
    decodeBridgeMessage,
    encodeBridgeMessage,
    toWebSocketUrl
  };
  document.addEventListener("DOMContentLoaded", init);
})();
