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

  type Connection = Record<string, any>;
  type InputState = {
    playerId: number | null;
    physicsReady: boolean;
    alive: boolean;
    paused: boolean;
    order: number;
    status: number;
    timestamp: number;
    position: [number, number, number];
    velocity: [number, number, number];
    azimuth: number;
    angularVelocity: number;
    clientTime: number;
    nextShotId: number;
    [key: string]: any;
  };
  type SessionPhase = "connecting" | "handshaking" | "joining" | "accepted" | "joined" | "playing" | "dead" | "paused" | "rejected" | "left" | "closing" | "closed" | "error";
  type SessionLifecycle = {
    phase: SessionPhase;
    joined: boolean;
    alive: boolean;
    paused: boolean;
    respawnPending: boolean;
    closed: boolean;
    closeReason: string | null;
    lastEvent: string | null;
    tcpReady: boolean;
    udpState: "disabled" | "idle" | "requested" | "ready" | "closed";
  };
  type ProtocolResult = BZFlagWebProtocolResult & {
    code: number;
    channel?: number;
    data?: Record<string, any>;
    player?: Record<string, any>;
  };
  type WorldStateAdapter = {
    apply(event: ProtocolResult): { applied: boolean };
    snapshot(): unknown;
    setWorldGeometry?: (input: unknown) => { applied: boolean };
  };
  type WorldTransferAdapter = {
    push(chunk: { bytesLeft: number; chunk: Uint8Array }): {
      complete: boolean;
      failed: boolean;
      bytesReceived: number;
      totalBytes: number | null;
      bytesLeft: number | null;
      chunkCount: number;
      summary: unknown;
      error?: string;
    };
    snapshot(): unknown;
    bytes?: () => Uint8Array;
    reset?(): void;
  };
  type WorldEnvelopeDecoder = (envelope: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  type ProtocolSession = {
    connection: Connection;
    inputState: InputState;
    worldState: WorldStateAdapter | null;
    renderer: BZFlagWebRendererHandle;
    socket: WebSocket | null;
    handshake: {
      push(payload: Uint8Array): { ready: boolean; version?: string; playerId?: number; payload: Uint8Array };
    };
    handshakeComplete: boolean;
    serverVersion: string | null;
    serverPlayerId: number | null;
    enterSent: boolean;
    flagNegotiationSent: boolean;
    udpRequested: boolean;
    udpReady: boolean;
    lifecycle: SessionLifecycle;
    serverPlayerOrder: number | null;
    queriesSent: boolean;
    settingsRequested: boolean;
    worldHashRequested: boolean;
    worldTransfer: {
      started: boolean;
      complete: boolean;
      requestedOffset: number | null;
      offset: number;
      total: number | null;
      bytes: Uint8Array;
      assembler: WorldTransferAdapter | null;
      decodeEnvelope: WorldEnvelopeDecoder | null;
      snapshot: unknown;
      summary: unknown;
    };
    tcpStream: { push(payload: Uint8Array): Uint8Array[]; reset?: () => void };
    udpStream: { push(payload: Uint8Array): Uint8Array[]; reset?: () => void };
    [key: string]: any;
  };

  const CONNECTION_KEY = "bzflag-web.connection.v1";
  const BRIDGE_MAGIC = new Uint8Array([0x42, 0x5a, 0x57, 0x42]);
  const BRIDGE_VERSION = 1;
  const CHANNEL_TCP = 0;
  const CHANNEL_UDP = 1;
  const WEBSOCKET_SUBPROTOCOL = "bzflag-web-v1";
  const TOKEN_SUBPROTOCOL_PREFIX = "bzflag-token.";
  const CHAT_MESSAGE_MAX_LENGTH = 128;
  const PLAYER_ALIVE_MASK = 1;
  const PLAYER_PAUSED_MASK = 1 << 1;
  const MAX_PHYSICS_COORDINATE = 1_000_000;
  const MAX_PHYSICS_SPEED = 1_000;
  const MAX_PHYSICS_ANGULAR_VELOCITY = 32.766;
  const MAX_PHYSICS_STEP_SECONDS = 0.1;
  const MAX_CLIENT_TIMESTAMP = 1_000_000_000;
  const MAX_CLIENT_CLOCK_SECONDS = 4_000_000_000;
  const SESSION_REASON_BYTES = 160;
  // The primary bindings below mirror BZFlag 2.4.31's ActionBinding defaults.
  // WASD and F/T remain browser-friendly aliases for the existing web UI.
  const COMMAND_MAP: Record<string, string> = {
    ArrowUp: "move-forward",
    KeyW: "move-forward",
    ArrowDown: "move-backward",
    KeyS: "move-backward",
    ArrowLeft: "turn-left",
    KeyA: "turn-left",
    ArrowRight: "turn-right",
    KeyD: "turn-right",
    Enter: "fire",
    Space: "drop-flag",
    KeyF: "drop-flag",
    Tab: "jump",
    F12: "exit",
    KeyI: "restart",
    KeyP: "pause",
    Digit9: "auto-pilot",
    KeyN: "send-all",
    KeyM: "send-team",
    Comma: "send-nemesis",
    Period: "send-recipient",
    KeyZ: "send-admin",
    KeyT: "open-chat",
    Escape: "open-menu"
  };
  const AUDIO_ASSETS: Record<string, string> = Object.freeze({
    fire: "./assets/upstream/fire.wav",
    explosion: "./assets/upstream/explosion.wav",
    jump: "./assets/upstream/jump.wav",
    flagGrab: "./assets/upstream/flag_grab.wav"
  });

  function createInputState(): InputState {
    return {
      // A player id is learned from the server's MsgAddPlayer packet. The
      // physics renderer must later provide a fresh snapshot before movement
      // packets are emitted; sending guessed positions would be unsafe.
      playerId: null,
      physicsReady: false,
      alive: false,
      paused: false,
      order: 0,
      status: window.BZFlagWebProtocol?.PLAYER_STATUS?.dead || 0,
      timestamp: 0,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      azimuth: 0,
      angularVelocity: 0,
      clientTime: 0,
      nextShotId: 0
    };
  }

  function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }

  function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
    return Math.trunc(boundedNumber(value, minimum, maximum, fallback));
  }

  function boundedPlayerId(value: unknown, fallback: number | null = null): number | null {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 254 ? number : fallback;
  }

  function boundedVector(value: unknown, fallback: [number, number, number], maximum: number): [number, number, number] {
    const source = Array.isArray(value) || ArrayBuffer.isView(value) ? value as ArrayLike<unknown> : fallback;
    return [
      boundedNumber(source[0], -maximum, maximum, fallback[0]),
      boundedNumber(source[1], -maximum, maximum, fallback[1]),
      boundedNumber(source[2], -maximum, maximum, fallback[2])
    ];
  }

  function createSessionLifecycle(useUDP = true): SessionLifecycle {
    return {
      phase: "connecting",
      joined: false,
      alive: false,
      paused: false,
      respawnPending: false,
      closed: false,
      closeReason: null,
      lastEvent: null,
      tcpReady: false,
      udpState: useUDP ? "idle" : "disabled"
    };
  }

  function applySessionLifecycle(
    lifecycle: SessionLifecycle | null | undefined,
    event: string,
    detail: Record<string, any> = {}
  ): SessionLifecycle {
    const current = lifecycle || createSessionLifecycle(detail.useUDP !== false);
    const next: SessionLifecycle = { ...current, lastEvent: String(event || "unknown") };
    const reason = String(detail.reason || "").slice(0, SESSION_REASON_BYTES);
    switch (event) {
      case "socket-open":
        next.phase = "handshaking";
        next.tcpReady = true;
        break;
      case "handshake-ready":
        next.phase = "joining";
        next.tcpReady = true;
        break;
      case "enter-sent":
        if (next.phase === "connecting" || next.phase === "handshaking") next.phase = "joining";
        break;
      case "accepted":
        next.phase = "accepted";
        next.joined = false;
        next.alive = false;
        next.paused = false;
        next.respawnPending = false;
        break;
      case "local-joined":
        next.phase = "joined";
        next.joined = true;
        next.alive = false;
        next.paused = false;
        next.respawnPending = false;
        break;
      case "alive":
        next.phase = "playing";
        next.joined = true;
        next.alive = true;
        next.paused = false;
        next.respawnPending = false;
        break;
      case "killed":
      case "death":
        next.phase = "dead";
        next.joined = true;
        next.alive = false;
        next.paused = false;
        next.respawnPending = true;
        break;
      case "pause":
        next.paused = Boolean(detail.paused);
        next.phase = next.paused ? "paused" : (next.alive ? "playing" : "dead");
        break;
      case "restart-requested":
        if (next.joined && !next.alive) next.respawnPending = true;
        break;
      case "local-left":
      case "leave":
        next.phase = "left";
        next.joined = false;
        next.alive = false;
        next.paused = false;
        next.respawnPending = false;
        break;
      case "rejected":
        next.phase = "rejected";
        next.joined = false;
        next.alive = false;
        next.paused = false;
        next.respawnPending = false;
        next.closeReason = reason || next.closeReason;
        break;
      case "udp-requested":
        if (next.udpState !== "disabled") next.udpState = "requested";
        break;
      case "udp-ready":
        if (next.udpState !== "disabled") next.udpState = "ready";
        break;
      case "udp-closed":
        next.udpState = next.udpState === "disabled" ? "disabled" : "closed";
        break;
      case "close-requested":
        next.phase = next.phase === "rejected" || next.phase === "left" ? next.phase : "closing";
        next.closeReason = reason || next.closeReason;
        next.udpState = next.udpState === "disabled" ? "disabled" : "closed";
        break;
      case "socket-error":
        next.phase = "error";
        next.closeReason = reason || next.closeReason;
        break;
      case "socket-close":
        next.phase = "closed";
        next.closed = true;
        next.tcpReady = false;
        next.udpState = next.udpState === "disabled" ? "disabled" : "closed";
        next.closeReason = reason || next.closeReason;
        break;
      default:
        break;
    }
    return next;
  }

  function resetClientPhysics(inputState: InputState, preservePosition = false): void {
    if (!inputState) return;
    inputState.physicsReady = false;
    inputState.alive = false;
    inputState.paused = false;
    inputState.velocity = [0, 0, 0];
    inputState.angularVelocity = 0;
    inputState.clientTime = 0;
    inputState.nextShotId = 0;
    if (!preservePosition) inputState.position = [0, 0, 0];
  }

  function sanitizePhysicsSnapshot(data: Record<string, any> = {}, current: Partial<InputState> = {}): Record<string, any> {
    const fallbackPosition = Array.isArray(current.position) ? current.position : [0, 0, 0];
    const fallbackVelocity = Array.isArray(current.velocity) ? current.velocity : [0, 0, 0];
    return {
      playerId: boundedPlayerId(data.playerId, boundedPlayerId(current.playerId)),
      order: boundedInteger(data.order, 0, 0x7fffffff, boundedInteger(current.order, 0, 0x7fffffff, 0)),
      status: boundedInteger(data.status, -0x8000, 0x7fff, boundedInteger(current.status, -0x8000, 0x7fff, 0)),
      timestamp: boundedNumber(data.timestamp, -MAX_CLIENT_TIMESTAMP, MAX_CLIENT_TIMESTAMP, boundedNumber(current.timestamp, -MAX_CLIENT_TIMESTAMP, MAX_CLIENT_TIMESTAMP, 0)),
      position: boundedVector(data.position, fallbackPosition as [number, number, number], MAX_PHYSICS_COORDINATE),
      velocity: boundedVector(data.velocity, fallbackVelocity as [number, number, number], MAX_PHYSICS_SPEED),
      azimuth: boundedNumber(data.azimuth, -Math.PI * 2, Math.PI * 2, boundedNumber(current.azimuth, -Math.PI * 2, Math.PI * 2, 0)),
      angularVelocity: boundedNumber(data.angularVelocity, -MAX_PHYSICS_ANGULAR_VELOCITY, MAX_PHYSICS_ANGULAR_VELOCITY, boundedNumber(current.angularVelocity, -MAX_PHYSICS_ANGULAR_VELOCITY, MAX_PHYSICS_ANGULAR_VELOCITY, 0))
    };
  }

  function advanceClientPhysics(inputState: InputState, nowSeconds = Date.now() / 1000): boolean {
    if (!inputState?.physicsReady || inputState.alive === false || inputState.paused) return false;
    const now = boundedNumber(nowSeconds, 0, MAX_CLIENT_CLOCK_SECONDS, inputState.clientTime || 0);
    const previous = boundedNumber(inputState.clientTime, 0, MAX_CLIENT_CLOCK_SECONDS, now);
    const delta = Math.min(MAX_PHYSICS_STEP_SECONDS, Math.max(0, now - previous));
    inputState.clientTime = now;
    if (delta <= 0) return false;
    const velocity = boundedVector(inputState.velocity, [0, 0, 0], MAX_PHYSICS_SPEED);
    const position = boundedVector(inputState.position, [0, 0, 0], MAX_PHYSICS_COORDINATE);
    inputState.velocity = velocity;
    inputState.position = boundedVector([
      position[0] + velocity[0] * delta,
      position[1] + velocity[1] * delta,
      position[2] + velocity[2] * delta
    ], position, MAX_PHYSICS_COORDINATE);
    inputState.azimuth = boundedNumber(inputState.azimuth + boundedNumber(inputState.angularVelocity, -MAX_PHYSICS_ANGULAR_VELOCITY, MAX_PHYSICS_ANGULAR_VELOCITY, 0) * delta, -Math.PI * 2, Math.PI * 2, inputState.azimuth);
    inputState.timestamp = boundedNumber(inputState.timestamp + delta, -MAX_CLIENT_TIMESTAMP, MAX_CLIENT_TIMESTAMP, inputState.timestamp);
    return true;
  }

  const get = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const t = (key: string): string => window.BZFlagWebI18n?.t(key) || key;

  function readConnection(): Connection | null {
    try {
      const raw = window.sessionStorage.getItem(CONNECTION_KEY);
      const connection: unknown = raw ? JSON.parse(raw) : null;
      return connection && typeof connection === "object" ? connection as Connection : null;
    } catch {
      return null;
    }
  }

  function safeText(value: unknown, fallback = "—"): string {
    return value === undefined || value === null || value === "" ? fallback : String(value);
  }

  function encodeSessionToken(token: string): string {
    const bytes = new TextEncoder().encode(token);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function resolveWebSocketEndpoint(endpoint: unknown, connection: Connection = {}) {
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
    // Bearer credentials belong in the WebSocket subprotocol offer, not in a
    // URL that can leak through browser history, referrers, or access logs.
    resolved.searchParams.delete("token");
    resolved.hash = "";
    return { resolved, token };
  }

  function toWebSocketUrl(endpoint: unknown, connection: Connection = {}) {
    return resolveWebSocketEndpoint(endpoint, connection).resolved.toString();
  }

  function toWebSocketProtocols(endpoint: unknown, connection: Connection = {}) {
    const { token } = resolveWebSocketEndpoint(endpoint, connection);
    return [WEBSOCKET_SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${encodeSessionToken(token)}`];
  }

  function toUint8Array(payload: unknown): Uint8Array {
    if (payload instanceof Uint8Array) {
      return payload;
    }
    if (payload instanceof ArrayBuffer) {
      return new Uint8Array(payload);
    }
    return new TextEncoder().encode(String(payload || ""));
  }

  function encodeBridgeMessage(channel: number, payload: unknown): Uint8Array {
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

  function decodeBridgeMessage(payload: unknown): { channel: number; payload: Uint8Array } {
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

  function setStatus(message: string, kind = ""): void {
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

  function appendEvent(message: string, kind = "info"): void {
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
    enabled: boolean;
    volume: number;
    context: AudioContext | null;
    assetBuffers: Map<string, AudioBuffer>;
    assetLoads: Map<string, Promise<AudioBuffer | null>>;
    failedAssets: Set<string>;

    constructor(enabled = true) {
      this.enabled = enabled;
      this.volume = 0.7;
      this.context = null;
      this.assetBuffers = new Map();
      this.assetLoads = new Map();
      this.failedAssets = new Set();
    }

    setEnabled(enabled: boolean): void {
      this.enabled = enabled;
      this.updateState();
    }

    setVolume(value: unknown): void {
      this.volume = Math.min(1, Math.max(0, Number(value)));
    }

    async resume(): Promise<boolean | undefined> {
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
      return true;
    }

    async loadAsset(name: string): Promise<AudioBuffer | null> {
      const context = this.context;
      if (!context || !AUDIO_ASSETS[name] || this.failedAssets.has(name)) {
        return null;
      }
      if (this.assetBuffers.has(name)) {
        return this.assetBuffers.get(name) ?? null;
      }
      if (this.assetLoads.has(name)) {
        return this.assetLoads.get(name) ?? null;
      }
      const load = fetch(AUDIO_ASSETS[name], { cache: "force-cache" })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Audio asset request failed with HTTP ${response.status}`);
          }
          return response.arrayBuffer();
        })
        .then((bytes) => context.decodeAudioData(bytes as ArrayBuffer))
        .then((buffer) => {
          this.assetBuffers.set(name, buffer);
          return buffer;
        })
        .catch(() => {
          /* A missing or undecodable upstream effect falls back to a local tone. */
          this.failedAssets.add(name);
          return null;
        })
        .finally(() => this.assetLoads.delete(name));
      this.assetLoads.set(name, load);
      return load;
    }

    async preload(names: string[] = Object.keys(AUDIO_ASSETS)): Promise<number> {
      if (!this.enabled || !this.context) {
        return 0;
      }
      const buffers = await Promise.all(names.map((name) => this.loadAsset(name)));
      return buffers.filter(Boolean).length;
    }

    async play(name: string, frequency = 360, duration = 0.05): Promise<void> {
      if (!this.enabled) {
        return;
      }
      await this.resume();
      if (!this.context) {
        return;
      }
      const buffer = await this.loadAsset(name);
      if (buffer) {
        const source = this.context.createBufferSource();
        const gain = this.context.createGain();
        source.buffer = buffer;
        gain.gain.value = this.volume;
        source.connect(gain).connect(this.context.destination);
        source.start();
        return;
      }
      await this.beep(frequency, duration);
    }

    async beep(frequency = 360, duration = 0.05): Promise<void> {
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

    updateState(): void {
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

  function updateSessionDetails(connection: Connection): void {
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

  function sendSessionPacket(session: ProtocolSession, channel: number, packet: Uint8Array | null | undefined): boolean {
    if (!packet || !session?.socket || session.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    session.socket.send(encodeBridgeMessage(channel, packet) as unknown as ArrayBuffer);
    return true;
  }

  function ensureSessionLifecycle(session: ProtocolSession): SessionLifecycle {
    if (!session.lifecycle) {
      session.lifecycle = createSessionLifecycle(session.connection?.useUDP !== false);
    }
    return session.lifecycle;
  }

  function updateSessionLifecycle(session: ProtocolSession, event: string, detail: Record<string, any> = {}): SessionLifecycle {
    const lifecycle = applySessionLifecycle(ensureSessionLifecycle(session), event, detail);
    session.lifecycle = lifecycle;
    if (event === "udp-requested") session.udpRequested = true;
    if (event === "udp-ready") {
      session.udpReady = true;
      session.udpRequested = true;
    }
    if (event === "udp-closed" || event === "close-requested" || event === "socket-close") {
      session.udpReady = false;
      session.udpRequested = false;
    }
    if (session.inputState) {
      if (event === "local-joined") {
        const playerId = boundedPlayerId(detail.playerId, session.inputState.playerId);
        session.inputState.playerId = playerId;
        resetClientPhysics(session.inputState);
      } else if (event === "alive") {
        session.inputState.alive = true;
        session.inputState.paused = false;
        session.inputState.physicsReady = true;
        session.inputState.clientTime = Date.now() / 1000;
      } else if (event === "killed" || event === "death") {
        resetClientPhysics(session.inputState, true);
      } else if (event === "pause") {
        session.inputState.paused = Boolean(detail.paused);
      } else if (event === "local-left" || event === "leave" || event === "socket-close") {
        const playerId = session.inputState.playerId;
        resetClientPhysics(session.inputState);
        session.inputState.playerId = event === "socket-close" ? null : playerId;
      }
    }
    if (typeof document !== "undefined" && typeof CustomEvent !== "undefined") {
      document.dispatchEvent(new CustomEvent("bzflag:session-state", {
        detail: Object.freeze({ event, lifecycle, reason: detail.reason || null })
      }));
    }
    return lifecycle;
  }

  function finalizeSessionClose(session: ProtocolSession, reason = "") : boolean {
    if (ensureSessionLifecycle(session).closed) return false;
    updateSessionLifecycle(session, "socket-close", { reason });
    session.handshakeComplete = false;
    session.serverVersion = null;
    session.serverPlayerId = null;
    session.serverPlayerOrder = null;
    session.enterSent = false;
    session.flagNegotiationSent = false;
    session.queriesSent = false;
    session.settingsRequested = false;
    session.worldHashRequested = false;
    session.tcpStream?.reset?.();
    session.udpStream?.reset?.();
    session.renderer?.stop?.();
    return true;
  }

  function closeSession(session: ProtocolSession, code = 1000, reason = "Client closed the session"): boolean {
    if (ensureSessionLifecycle(session).closed) return false;
    const safeReason = String(reason || "Client closed the session").slice(0, SESSION_REASON_BYTES);
    updateSessionLifecycle(session, "close-requested", { reason: safeReason });
    const socket = session.socket;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING)) {
      try {
        socket.close(code, safeReason);
      } catch {
        finalizeSessionClose(session, safeReason);
      }
    } else {
      finalizeSessionClose(session, safeReason);
    }
    return true;
  }

  function acceptsServerOrder(lastOrder: number | null, nextOrder: unknown): boolean {
    const order = Number(nextOrder);
    return Number.isInteger(order) && order >= 0 && order <= 0x7fffffff && (lastOrder === null || order > lastOrder);
  }

  function isGameplayInput(command: string): boolean {
    return [
      "move-forward", "move-backward", "turn-left", "turn-right", "fire",
      "drop", "drop-flag", "grab", "grab-flag", "capture", "capture-flag", "shot-end"
    ].includes(command);
  }

  function canSendSessionInput(lifecycle: SessionLifecycle, command: string, phase: string): boolean {
    if (!lifecycle || lifecycle.closed || lifecycle.phase === "rejected" || lifecycle.phase === "left" || lifecycle.phase === "closing") return false;
    if (isGameplayInput(command)) return lifecycle.joined && lifecycle.alive && !lifecycle.paused;
    if (command === "restart" || command === "alive") return lifecycle.joined && !lifecycle.alive && phase === (command === "restart" ? "end" : "start");
    if (command === "pause") return lifecycle.joined;
    if (command === "exit") return true;
    return true;
  }

  function createFiringState(inputState: InputState, connection: Connection = {}): Record<string, any> | null {
    const playerId = boundedPlayerId(inputState?.playerId);
    if (playerId === null || !inputState?.physicsReady || !inputState.alive || inputState.paused) return null;
    const protocol = window.BZFlagWebProtocol;
    const teamNames = protocol?.TEAM_BY_NAME as Record<string, number> | undefined;
    const configuredTeam = teamNames ? teamNames[String(connection.team || "automatic")] : 0;
    const team = boundedInteger(inputState.team ?? configuredTeam, -1, 7, 0);
    const shotId = boundedInteger(inputState.nextShotId, 0, 0xffff, 0);
    inputState.nextShotId = (shotId + 1) & 0xffff;
    const azimuth = boundedNumber(inputState.azimuth, -Math.PI * 2, Math.PI * 2, 0);
    const speed = boundedNumber(connection.shotSpeed, 0, MAX_PHYSICS_SPEED, 100);
    const position = boundedVector(inputState.position, [0, 0, 0], MAX_PHYSICS_COORDINATE);
    const velocity = boundedVector(inputState.velocity, [0, 0, 0], MAX_PHYSICS_SPEED);
    return {
      playerId,
      shotId,
      timeSent: boundedNumber(inputState.timestamp, -MAX_CLIENT_TIMESTAMP, MAX_CLIENT_TIMESTAMP, 0),
      position,
      velocity: [
        boundedNumber(velocity[0] + Math.cos(azimuth) * speed, -MAX_PHYSICS_SPEED, MAX_PHYSICS_SPEED, velocity[0]),
        boundedNumber(velocity[1] + Math.sin(azimuth) * speed, -MAX_PHYSICS_SPEED, MAX_PHYSICS_SPEED, velocity[1]),
        velocity[2]
      ],
      dt: 0,
      team,
      flag: String(inputState.flag || connection.flag || "").slice(0, 2),
      lifetime: boundedNumber(inputState.shotLifetime ?? connection.shotLifetime, 0, 120, 3)
    };
  }

  type ChatProtocolApi = BZFlagWebProtocolApi & {
    ADMIN_PLAYERS?: number;
    ALL_PLAYERS?: number;
    FIRST_TEAM?: number;
    TEAM_BY_NAME?: Record<string, number>;
  };

  function resolveChatTarget(selection: string, connection: Connection = {}, protocol: BZFlagWebProtocolApi): number | null {
    const chatProtocol = protocol as ChatProtocolApi;
    const allPlayers = Number(chatProtocol.ALL_PLAYERS ?? 254);
    const adminPlayers = Number(chatProtocol.ADMIN_PLAYERS ?? 252);
    const firstTeam = Number(chatProtocol.FIRST_TEAM ?? 251);
    const target = String(selection || "").trim().toLowerCase();
    if (target === "all") {
      return Number.isInteger(allPlayers) && allPlayers >= 0 && allPlayers < 255 ? allPlayers : null;
    }
    if (target === "admin") {
      return Number.isInteger(adminPlayers) && adminPlayers >= 0 && adminPlayers < 255 ? adminPlayers : null;
    }
    if (target === "team") {
      const teamName = String(connection.team || "").trim().toLowerCase();
      const teamIndex = chatProtocol.TEAM_BY_NAME ? Number(chatProtocol.TEAM_BY_NAME[teamName]) : NaN;
      if (!Number.isInteger(teamIndex) || teamIndex < 0 || teamIndex > 7) {
        return null;
      }
      const teamTarget = firstTeam - teamIndex;
      return Number.isInteger(teamTarget) && teamTarget >= 0 && teamTarget < 255 ? teamTarget : null;
    }
    const numericTarget = Number(target);
    return Number.isInteger(numericTarget) && numericTarget >= 0 && numericTarget < 255 ? numericTarget : null;
  }

  function sendChatMessage(
    socket: WebSocket | null,
    protocol: BZFlagWebProtocolApi | null | undefined,
    connection: Connection,
    selection: string,
    message: string
  ): boolean {
    const text = String(message || "").trim();
    if (!text || text.length > CHAT_MESSAGE_MAX_LENGTH || !socket || socket.readyState !== WebSocket.OPEN || !protocol?.encodeInput) {
      return false;
    }
    const target = resolveChatTarget(selection, connection, protocol);
    if (target === null) {
      return false;
    }
    const payload = protocol.encodeInput("message", "start", "chat", { message: text, target });
    if (!payload) {
      return false;
    }
    socket.send(encodeBridgeMessage(CHANNEL_TCP, payload) as unknown as ArrayBuffer);
    return true;
  }

  function bindChatComposer(socket: WebSocket | null, connection: Connection, protocol: BZFlagWebProtocolApi): () => void {
    const form = get<HTMLFormElement>("chat-composer");
    const message = get<HTMLTextAreaElement>("chat-message");
    const target = get<HTMLSelectElement>("chat-target");
    const status = get("chat-status");
    if (!form || !message || !target) {
      return () => undefined;
    }
    const submit = (event: SubmitEvent): void => {
      event.preventDefault();
      if (sendChatMessage(socket, protocol, connection, target.value, message.value)) {
        message.value = "";
        if (status) {
          status.className = "form-status success";
          status.textContent = t("chatSent");
        }
        appendEvent(t("chatSent"));
        return;
      }
      if (status) {
        status.className = "form-status error";
        status.textContent = t("chatUnavailable");
      }
    };
    form.addEventListener("submit", submit);
    return () => form.removeEventListener("submit", submit);
  }

  function sendInitialProtocolPackets(session: ProtocolSession): void {
    const protocol = window.BZFlagWebProtocol;
    if (!protocol || !session.handshakeComplete || session.enterSent) return;
    ensureSessionLifecycle(session);
    const playerId = session.serverPlayerId;
    session.inputState.playerId = Number.isInteger(playerId) ? playerId : null;
    if (session.connection.useUDP !== false && protocol.encodeUDPLinkRequest && playerId !== null) {
      session.udpRequested = sendSessionPacket(session, CHANNEL_UDP, protocol.encodeUDPLinkRequest(playerId));
      if (session.udpRequested) updateSessionLifecycle(session, "udp-requested");
    } else if (session.connection.useUDP === false) {
      session.lifecycle.udpState = "disabled";
    }
    if (protocol.encodeFlagNegotiation) {
      session.flagNegotiationSent = sendSessionPacket(session, CHANNEL_TCP, protocol.encodeFlagNegotiation());
    }
    if (protocol.encodeEnter) {
      session.enterSent = sendSessionPacket(session, CHANNEL_TCP, protocol.encodeEnter(session.connection));
    }
    if (session.enterSent) updateSessionLifecycle(session, "enter-sent");
    if (session.enterSent) appendEvent("BZFlag enter packet sent.");
  }

  async function appendWorldChunk(session: ProtocolSession, result: ProtocolResult): Promise<void> {
    const protocol = window.BZFlagWebProtocol;
    if (!protocol) return;
    const data = result?.data;
    if (!data || !Number.isInteger(data.bytesLeft) || !data.chunk) return;
    const transfer = session.worldTransfer;
    const chunk = data.chunk instanceof Uint8Array ? data.chunk : new Uint8Array(data.chunk);
    if (!transfer.assembler) {
      throw new Error("BZFlag world transfer assembler is unavailable");
    }
    const snapshot = transfer.assembler.push({ bytesLeft: data.bytesLeft, chunk });
    transfer.snapshot = snapshot;
    transfer.offset = Number(snapshot.bytesReceived) || 0;
    transfer.total = Number.isInteger(snapshot.totalBytes) ? Number(snapshot.totalBytes) : null;
    transfer.complete = snapshot.complete === true;
    transfer.summary = snapshot.summary || null;
    if (!snapshot.complete) {
      const nextOffset = transfer.offset;
      if (data.bytesLeft > 0) {
        if (transfer.requestedOffset === nextOffset) return;
        transfer.requestedOffset = nextOffset;
        if (protocol.encodeGetWorld) {
          sendSessionPacket(session, CHANNEL_TCP, protocol.encodeGetWorld(nextOffset));
        }
        appendEvent(`World transfer: ${nextOffset} bytes received.`);
      }
      return;
    }
    transfer.requestedOffset = null;
    if (!transfer.summary) {
      throw new Error("BZFlag world transfer completed without a safe summary");
    }
    let worldSummary: unknown = transfer.summary;
    const transferSnapshot = transfer.assembler.snapshot?.() as {
      envelope?: unknown;
      chunkCount?: number;
    } | null;
    if (transfer.decodeEnvelope && transferSnapshot?.envelope) {
      try {
        worldSummary = await transfer.decodeEnvelope(transferSnapshot.envelope, {
          mapVersion: 1
        });
        transfer.summary = worldSummary;
      } catch (error) {
        const message = error instanceof Error ? error.message : "BZFlag world database decoding failed";
        appendEvent(`World decoder rejected the native database: ${message}`, "error");
        setStatus(message, "error");
        throw error;
      }
    }
    transfer.bytes = new Uint8Array();
    appendEvent(`World transfer complete (${transfer.offset} bytes); native database decoded.`);
    (session.renderer as BZFlagWebRendererHandle & {
      setWorldData?: (summary: unknown) => void;
    })?.setWorldData?.(worldSummary);
    if (session.worldState?.setWorldGeometry) {
      const geometryResult = session.worldState.setWorldGeometry(worldSummary);
      if (geometryResult?.applied) session.renderer.setWorldState?.(session.worldState);
    }
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent("bzflag:world-ready", {
        detail: Object.freeze({
          bytesReceived: transfer.offset,
          totalBytes: transfer.total,
          chunkCount: transferSnapshot?.chunkCount ?? snapshot.chunkCount,
          world: worldSummary
        })
      }));
    }
  }

  function beginWorldTransfer(session: ProtocolSession): void {
    const transfer = session.worldTransfer;
    if (!transfer.assembler) {
      throw new Error("BZFlag world transfer assembler is unavailable");
    }
    if (transfer.complete || transfer.started) return;
    transfer.started = true;
    transfer.requestedOffset = 0;
    transfer.assembler.reset?.();
    transfer.snapshot = transfer.assembler.snapshot?.() || null;
    if (window.BZFlagWebProtocol?.encodeGetWorld) {
      sendSessionPacket(session, CHANNEL_TCP, window.BZFlagWebProtocol.encodeGetWorld(0));
    }
  }

  function handleProtocolFollowUp(session: ProtocolSession, result: ProtocolResult): void {
    const protocol = window.BZFlagWebProtocol;
    if (!protocol || !result || result.valid === false) return;
    ensureSessionLifecycle(session);
    if (protocol.MSG_SUPER_KILL !== undefined && result.code === protocol.MSG_SUPER_KILL) {
      session.protocolError = true;
      setStatus(t("serverDisconnect"), "error");
      appendEvent(t("serverDisconnect"), "error");
      updateSessionLifecycle(session, "socket-error", { reason: "BZFlag server requested disconnect" });
      closeSession(session, 1008, "BZFlag server requested disconnect");
      return;
    }
    if (result.code === protocol.MSG_UDP_LINK_REQUEST) {
      if (session.connection?.useUDP !== false && protocol.encodeUDPLinkEstablished) {
        sendSessionPacket(session, result.channel ?? CHANNEL_TCP, protocol.encodeUDPLinkEstablished());
      }
      return;
    }
    if (result.code === protocol.MSG_UDP_LINK_ESTABLISHED) {
      if (session.connection?.useUDP !== false) {
        updateSessionLifecycle(session, "udp-ready");
        appendEvent("BZFlag UDP link established.");
      }
      return;
    }
    if (result.code === protocol.MSG_ACCEPT) {
      updateSessionLifecycle(session, "accepted");
      if (!session.queriesSent) {
        session.queriesSent = true;
        if (protocol.encodeQueryGame) sendSessionPacket(session, CHANNEL_TCP, protocol.encodeQueryGame());
        if (protocol.encodeQueryPlayers) sendSessionPacket(session, CHANNEL_TCP, protocol.encodeQueryPlayers());
      }
      return;
    }
    if (protocol.MSG_REJECT !== undefined && result.code === protocol.MSG_REJECT) {
      const reason = String(result.data?.reason || "BZFlag server rejected the player");
      updateSessionLifecycle(session, "rejected", { reason });
      setStatus(reason, "error");
      appendEvent(reason, "error");
      closeSession(session, 1008, reason);
      return;
    }
    if (protocol.MSG_REMOVE_PLAYER !== undefined && result.code === protocol.MSG_REMOVE_PLAYER
      && result.data?.playerId === session.inputState?.playerId) {
      updateSessionLifecycle(session, "local-left", { playerId: result.data.playerId });
      closeSession(session, 1000, "BZFlag player left the server");
      return;
    }
    if (result.code === protocol.MSG_NEGOTIATE_FLAGS) {
      if (result.data?.missing && Array.isArray(result.data.flags)) appendEvent(`Server reports unsupported flags: ${result.data.flags.join(", ")}.`, "warning");
      if (!session.settingsRequested && protocol.encodeNoPayload) {
        session.settingsRequested = true;
        sendSessionPacket(session, CHANNEL_TCP, protocol.encodeNoPayload(protocol.MSG_WANT_SETTINGS));
      }
      return;
    }
    if (result.code === protocol.MSG_GAME_SETTINGS) {
      if (!session.worldHashRequested && protocol.encodeNoPayload) {
        session.worldHashRequested = true;
        sendSessionPacket(session, CHANNEL_TCP, protocol.encodeNoPayload(protocol.MSG_WANT_W_HASH));
      }
      return;
    }
    if (result.code === protocol.MSG_WANT_W_HASH) {
      beginWorldTransfer(session);
      return;
    }
    if (result.code === protocol.MSG_GET_WORLD) {
      void appendWorldChunk(session, result).catch(() => {
        session.protocolError = true;
        if (session.socket?.readyState === WebSocket.OPEN) session.socket.close(1002, "Invalid BZFlag world database");
      });
    }
  }

  function connectGateway(
    connection: Connection,
    onMessage: (data: unknown) => void,
    onSessionEvent: (event: string, detail?: Record<string, any>) => void = () => undefined
  ): WebSocket | null {
    let socket: WebSocket;
    try {
      const endpoint = toWebSocketUrl(connection?.gateway, connection);
      socket = new WebSocket(endpoint, toWebSocketProtocols(connection?.gateway, connection));
    } catch (error) {
      const message = error instanceof Error && error.message === "A gateway session token is required" ? t("missingSessionToken") : t("invalidGateway");
      setStatus(message, "error");
      appendEvent(message, "error");
      return null;
    }
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      onSessionEvent("socket-open");
      setStatus(t("connected"), "success");
      appendEvent(`Binary BZWB bridge ready for server ID ${safeText(connection?.serverId)}.`);
      appendEvent("Gateway is validating the BZFS handshake before forwarding game traffic.");
    });
    socket.addEventListener("message", (event) => onMessage(event.data));
    socket.addEventListener("error", () => {
      onSessionEvent("socket-error", { reason: "Gateway WebSocket error" });
      setStatus(t("gatewayUnavailable"), "warning");
      appendEvent(t("gatewayUnavailable"), "warning");
    });
    socket.addEventListener("close", (event) => {
      onSessionEvent("socket-close", { code: event?.code, reason: event?.reason });
      setStatus(t("disconnected"), "warning");
    });
    return socket;
  }

  function resultPlayerId(result: ProtocolResult): number | null {
    const data = result?.data;
    const direct = boundedPlayerId(data?.playerId ?? data?.victim ?? result?.player?.playerId);
    if (direct !== null) return direct;
    const payload = toUint8Array(result?.payload);
    return payload.byteLength > 0 ? boundedPlayerId(payload[0]) : null;
  }

  function isLocalResult(session: ProtocolSession, result: ProtocolResult): boolean {
    const localPlayerId = boundedPlayerId(session.inputState?.playerId);
    const eventPlayerId = resultPlayerId(result);
    return localPlayerId !== null && eventPlayerId === localPlayerId;
  }

  function applySessionProtocolResult(session: ProtocolSession, result: ProtocolResult): boolean {
    const protocol = window.BZFlagWebProtocol;
    if (!protocol || !result || result.valid === false) return true;
    ensureSessionLifecycle(session);
    const data = result.data || {};
    if (result.code === protocol.MSG_ADD_PLAYER && result.local && result.player) {
      const playerId = boundedPlayerId(result.player.playerId);
      if (playerId !== null) {
        session.inputState.playerId = playerId;
        session.serverPlayerId = playerId;
        session.serverPlayerOrder = null;
        updateSessionLifecycle(session, "local-joined", { playerId });
        appendEvent(`Assigned BZFlag player ID ${playerId}.`);
      }
    }
    if (!isLocalResult(session, result)) return true;
    if (result.code === protocol.MSG_ALIVE && data) {
      const snapshot = sanitizePhysicsSnapshot({ ...data, status: PLAYER_ALIVE_MASK }, session.inputState);
      session.serverPlayerOrder = null;
      updateSessionLifecycle(session, "alive", { playerId: snapshot.playerId });
      Object.assign(session.inputState, snapshot, {
        physicsReady: true,
        alive: true,
        paused: false,
        status: PLAYER_ALIVE_MASK,
        clientTime: Date.now() / 1000
      });
      return true;
    }
    if ((result.code === protocol.MSG_PLAYER_UPDATE || result.code === protocol.MSG_PLAYER_UPDATE_SMALL) && data) {
      if (!acceptsServerOrder(session.serverPlayerOrder, data.order)) return false;
      const snapshot = sanitizePhysicsSnapshot(data, session.inputState);
      const alive = typeof data.alive === "boolean" ? data.alive : (snapshot.status & PLAYER_ALIVE_MASK) !== 0;
      const paused = (snapshot.status & PLAYER_PAUSED_MASK) !== 0;
      session.serverPlayerOrder = snapshot.order;
      Object.assign(session.inputState, snapshot, {
        physicsReady: true,
        alive,
        paused,
        clientTime: Date.now() / 1000
      });
      if (!alive) updateSessionLifecycle(session, "killed", { playerId: snapshot.playerId });
      else {
        if (!session.lifecycle.alive) updateSessionLifecycle(session, "alive", { playerId: snapshot.playerId });
        if (paused) updateSessionLifecycle(session, "pause", { playerId: snapshot.playerId, paused: true });
        else if (session.lifecycle.paused) updateSessionLifecycle(session, "pause", { playerId: snapshot.playerId, paused: false });
      }
      return true;
    }
    if (protocol.MSG_KILLED !== undefined && result.code === protocol.MSG_KILLED) {
      updateSessionLifecycle(session, "killed", { playerId: resultPlayerId(result) });
      appendEvent("The local tank was destroyed.", "warning");
      return true;
    }
    if (protocol.MSG_PAUSE !== undefined && result.code === protocol.MSG_PAUSE) {
      const paused = typeof data.paused === "boolean" ? data.paused : toUint8Array(result.payload)[1] === 1;
      updateSessionLifecycle(session, "pause", { playerId: resultPlayerId(result), paused });
      return true;
    }
    if (protocol.MSG_REMOVE_PLAYER !== undefined && result.code === protocol.MSG_REMOVE_PLAYER) {
      updateSessionLifecycle(session, "local-left", { playerId: resultPlayerId(result) });
      return true;
    }
    return true;
  }

  function handleGatewayMessage(data: unknown, session: ProtocolSession): void {
    try {
      const bridge = decodeBridgeMessage(data);
      const protocol = window.BZFlagWebProtocol;
      if (protocol?.consume) {
        let serverPayload = bridge.payload;
        if (bridge.channel === CHANNEL_TCP && !session.handshakeComplete && session.handshake) {
          const greeting = session.handshake.push(bridge.payload);
          if (!greeting.ready) return;
          session.handshakeComplete = true;
          session.serverVersion = greeting.version ?? null;
          session.serverPlayerId = greeting.playerId ?? null;
          session.inputState.playerId = greeting.playerId ?? null;
          updateSessionLifecycle(session, "handshake-ready", { playerId: greeting.playerId });
          appendEvent(`BZFS ${greeting.version} handshake complete; gateway player ID ${greeting.playerId}.`);
          sendInitialProtocolPackets(session);
          serverPayload = greeting.payload;
        }
        if (serverPayload.byteLength === 0) return;
        const stream = bridge.channel === CHANNEL_TCP ? session.tcpStream : session.udpStream;
        const packets = stream ? stream.push(serverPayload) : [serverPayload];
        for (const packet of packets) {
          const result = protocol.consume(bridge.channel, packet, { nickname: session.connection?.nickname }) as ProtocolResult;
          const applyToWorld = applySessionProtocolResult(session, result);
          const transition = applyToWorld ? session.worldState?.apply(result) : null;
          if (transition?.applied && session.worldState) {
            const snapshot = session.worldState.snapshot();
            session.renderer?.setWorldState?.(snapshot);
            if (typeof document !== "undefined") {
              document.dispatchEvent(new CustomEvent("bzflag:world-state", {
                detail: snapshot
              }));
            }
          }
          handleProtocolFollowUp(session, result);
        }
      } else {
        appendEvent(`Received ${bridge.payload.byteLength} bytes on ${bridge.channel === CHANNEL_UDP ? "UDP" : "TCP"} bridge channel.`);
      }
    } catch (error) {
      /* Text frames are intentionally not accepted: the gateway rejects them
         and the browser client must remain binary-only for protocol safety. */
      session.protocolError = true;
      const message = error instanceof Error ? error.message : "Invalid binary bridge frame";
      setStatus(message, "error");
      appendEvent(message, "error");
      if (session.socket?.readyState === WebSocket.OPEN) session.socket.close(1002, "BZFlag protocol error");
    }
  }

  function bindKeyboard(
    socket: WebSocket | null,
    audio: AudioEngine,
    getInputState: (command?: string, phase?: string, key?: string) => Record<string, any> = () => ({}),
    getChannel: (command?: string, phase?: string, state?: Record<string, any>, payload?: Uint8Array) => number | null = () => CHANNEL_TCP,
    onCommand: (command?: string, phase?: string, state?: Record<string, any>, payload?: Uint8Array, channel?: number) => void = () => undefined
  ): () => void {
    const pressed = new Set();
    const sendCommand = (command: string, phase: string, key: string): void => {
      const state = getInputState(command, phase, key) || {};
      const protocol = window.BZFlagWebProtocol;
      if (socket?.readyState === WebSocket.OPEN && protocol?.encodeInput) {
        const payload = protocol.encodeInput(command, phase, key, state);
        if (payload) {
          const channel = getChannel(command, phase, state, payload);
          // BZFS accepts MsgShotBegin on UDP only for the browser bridge. A
          // not-yet-established UDP link must suppress the shot instead of
          // silently downgrading it to the TCP channel.
          if (channel === null || (command === "fire" && channel !== CHANNEL_UDP)) {
            if (command === "fire") appendEvent("Fire input suppressed until the UDP link is ready.", "warning");
            return;
          }
          socket.send(encodeBridgeMessage(channel, payload) as unknown as ArrayBuffer);
          onCommand(command, phase, state, payload, channel);
        }
      }
      appendEvent(`${command} (${phase})`);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
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
        audio.play("fire", 420, 0.06);
      }
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
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

  function resolveInputChannel(command = "", udpReady = false, useUDP = true): number | null {
    if (command === "fire") return udpReady && useUDP ? CHANNEL_UDP : null;
    const udpCommands = new Set(["move-forward", "move-backward", "turn-left", "turn-right", "shot-end"]);
    return udpReady && udpCommands.has(command) ? CHANNEL_UDP : CHANNEL_TCP;
  }

  function bindControls(audio: AudioEngine, renderer: BZFlagWebRendererHandle, onDisconnect: () => void = () => undefined): void {
    const audioToggle = get("audio-toggle");
    const volume = get<HTMLInputElement>("volume");
    const fullscreen = get("fullscreen-button");
    const disconnect = get("disconnect-button");
    audioToggle?.addEventListener("click", async () => {
      audio.setEnabled(!audio.enabled);
      if (audio.enabled) {
        await audio.resume();
        await audio.preload(["fire"]);
        audio.play("fire", 540, 0.04);
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
      onDisconnect();
      window.sessionStorage.removeItem(CONNECTION_KEY);
      window.location.assign("./index.html");
    });
  }

  function updateRendererStatus(mode: string): void {
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

  async function init(): Promise<void> {
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
    const canvas = get<HTMLCanvasElement>("game-canvas");
    const inputState = createInputState();
    let worldAssembler: WorldTransferAdapter | null = null;
    let worldDecodeEnvelope: WorldEnvelopeDecoder | null = null;
    try {
      const worldModule = await import(new URL("./dist/world.js", window.location.href).href);
      const worldTransferLimit = window.BZFlagWebProtocol?.MAX_WORLD_BYTES;
      if (typeof worldModule.createWorldTransferAssembler === "function") {
        worldAssembler = worldModule.createWorldTransferAssembler({
          maxTransferBytes: Number.isInteger(worldTransferLimit)
            ? worldTransferLimit
            : undefined
        });
      }
      if (typeof worldModule.decodeWorldEnvelope === "function") {
        worldDecodeEnvelope = worldModule.decodeWorldEnvelope as WorldEnvelopeDecoder;
      }
    } catch (error) {
      appendEvent(`World transfer module unavailable: ${error instanceof Error ? error.message : "load failure"}`, "warning");
    }
    let worldState: WorldStateAdapter | null = null;
    try {
      const stateModule = await import(new URL("./dist/state.js", window.location.href).href);
      worldState = stateModule.createWorldState();
    } catch (error) {
      appendEvent(`World state module unavailable: ${error instanceof Error ? error.message : "load failure"}`, "warning");
    }
    const rendererApi = window.BZFlagWebRenderer;
    if (!rendererApi) {
      appendEvent("Renderer module unavailable.", "error");
      return;
    }
    const renderer = await rendererApi.createRenderer(canvas, {
      preferWebGPU: connection.preferWebGPU !== false,
      worldState
    });
    renderer.setWorldState?.(worldState);
    updateRendererStatus(renderer.mode);
    const protocolApi = window.BZFlagWebProtocol;
    if (!protocolApi) {
      appendEvent("BZFlag protocol module unavailable.", "error");
      return;
    }
    const protocolSession: ProtocolSession = {
      connection,
      inputState,
      worldState,
      renderer,
      socket: null,
      handshake: new protocolApi.ServerHandshake({
        expectedVersion: connection.serverProtocol || protocolApi.DEFAULT_SERVER_VERSION
      }),
      handshakeComplete: false,
      serverVersion: null,
      serverPlayerId: null,
      enterSent: false,
      flagNegotiationSent: false,
      udpRequested: false,
      udpReady: false,
      lifecycle: createSessionLifecycle(connection.useUDP !== false),
      serverPlayerOrder: null,
      queriesSent: false,
      settingsRequested: false,
      worldHashRequested: false,
      worldTransfer: {
        started: false,
        complete: false,
        requestedOffset: null,
        offset: 0,
        total: null,
        bytes: new Uint8Array(),
        assembler: worldAssembler,
        decodeEnvelope: worldDecodeEnvelope,
        snapshot: worldAssembler?.snapshot?.() || null,
        summary: null
      },
      tcpStream: new protocolApi.PacketStream(),
      udpStream: new protocolApi.PacketStream()
    };
    bindControls(audio, renderer, () => closeSession(protocolSession, 1000, "User disconnected"));
    const socket = connectGateway(
      connection,
      (data) => handleGatewayMessage(data, protocolSession),
      (event, detail = {}) => updateSessionLifecycle(protocolSession, event, detail)
    );
    protocolSession.socket = socket;
    bindChatComposer(socket, connection, protocolApi);
    bindKeyboard(socket, audio, (command = "", phase = "") => {
      if (!canSendSessionInput(protocolSession.lifecycle, command, phase)) {
        return { command, phase };
      }
      renderer.handleInput?.(command, phase);
      if (!inputState.physicsReady || inputState.playerId === null) {
        return { command, phase };
      }
      const now = Date.now() / 1000;
      advanceClientPhysics(inputState, now);
      inputState.order = boundedInteger(inputState.order + 1, 0, 0x7fffffff, 0);
      inputState.timestamp = boundedNumber(now, 0, MAX_CLIENT_TIMESTAMP, inputState.timestamp);
      const state: Record<string, any> = {
        ...inputState,
        position: inputState.position.slice() as [number, number, number],
        velocity: inputState.velocity.slice() as [number, number, number]
      };
      if (command === "pause" && phase === "start") {
        state.paused = !protocolSession.lifecycle.paused;
      }
      if (command === "fire" && phase === "start") {
        if (resolveInputChannel(command, protocolSession.udpReady, connection.useUDP !== false) !== CHANNEL_UDP) {
          return { command, phase };
        }
        state.firing = createFiringState(inputState, connection);
        if (!state.firing) return { command, phase };
      }
      return state;
    }, (command = "") => {
      return resolveInputChannel(command, protocolSession.udpReady, connection.useUDP !== false);
    }, (command = "", phase = "") => {
      if (command === "restart" && phase === "end") {
        updateSessionLifecycle(protocolSession, "restart-requested");
      }
      if (command === "exit" && phase === "start") {
        closeSession(protocolSession, 1000, "Client requested exit");
      }
    });
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
    if (window.BZFlagWebGame) window.BZFlagWebGame.worldState = worldState;
    document.dispatchEvent(new CustomEvent("bzflag:game-ready", { detail: { renderer: renderer.mode, connection, worldState } }));
  }

  window.BZFlagWebGame = {
    BRIDGE_MAGIC,
    BRIDGE_VERSION,
    CHANNEL_TCP,
    CHANNEL_UDP,
    COMMAND_MAP,
    CONNECTION_KEY,
    AUDIO_ASSETS,
    createInputState,
    createSessionLifecycle,
    applySessionLifecycle,
    resetClientPhysics,
    sanitizePhysicsSnapshot,
    advanceClientPhysics,
    canSendSessionInput,
    createFiringState,
    AudioEngine,
    decodeBridgeMessage,
    encodeBridgeMessage,
    resolveWebSocketEndpoint,
    toWebSocketUrl,
    toWebSocketProtocols,
    resolveChatTarget,
    sendChatMessage,
    resolveInputChannel,
    acceptsServerOrder,
    bindKeyboard,
    handleProtocolFollowUp,
    applySessionProtocolResult,
    closeSession,
    finalizeSessionClose
  };
  document.addEventListener("DOMContentLoaded", init);
})();
