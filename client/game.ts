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
    order: number;
    status: number;
    timestamp: number;
    position: [number, number, number];
    velocity: [number, number, number];
    azimuth: number;
    angularVelocity: number;
    [key: string]: any;
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
    reset?(): void;
  };
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
      snapshot: unknown;
      summary: unknown;
    };
    tcpStream: { push(payload: Uint8Array): Uint8Array[] };
    udpStream: { push(payload: Uint8Array): Uint8Array[] };
    [key: string]: any;
  };

  const CONNECTION_KEY = "bzflag-web.connection.v1";
  const BRIDGE_MAGIC = new Uint8Array([0x42, 0x5a, 0x57, 0x42]);
  const BRIDGE_VERSION = 1;
  const CHANNEL_TCP = 0;
  const CHANNEL_UDP = 1;
  const WEBSOCKET_SUBPROTOCOL = "bzflag-web-v1";
  const TOKEN_SUBPROTOCOL_PREFIX = "bzflag-token.";
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
      order: 0,
      status: window.BZFlagWebProtocol?.PLAYER_STATUS?.dead || 0,
      timestamp: 0,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      azimuth: 0,
      angularVelocity: 0
    };
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

  function sendInitialProtocolPackets(session: ProtocolSession): void {
    const protocol = window.BZFlagWebProtocol;
    if (!protocol || !session.handshakeComplete || session.enterSent) return;
    const playerId = session.serverPlayerId;
    session.inputState.playerId = Number.isInteger(playerId) ? playerId : null;
    if (session.connection.useUDP !== false && protocol.encodeUDPLinkRequest && playerId !== null) {
      session.udpRequested = sendSessionPacket(session, CHANNEL_UDP, protocol.encodeUDPLinkRequest(playerId));
    }
    if (protocol.encodeFlagNegotiation) {
      session.flagNegotiationSent = sendSessionPacket(session, CHANNEL_TCP, protocol.encodeFlagNegotiation());
    }
    if (protocol.encodeEnter) {
      session.enterSent = sendSessionPacket(session, CHANNEL_TCP, protocol.encodeEnter(session.connection));
    }
    if (session.enterSent) appendEvent("BZFlag enter packet sent.");
  }

  function appendWorldChunk(session: ProtocolSession, result: ProtocolResult): void {
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
    const worldSummary = transfer.summary;
    transfer.bytes = new Uint8Array();
    appendEvent(`World transfer complete (${transfer.offset} bytes).`);
    (session.renderer as BZFlagWebRendererHandle & {
      setWorldData?: (summary: unknown) => void;
    })?.setWorldData?.(worldSummary);
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent("bzflag:world-ready", {
        detail: Object.freeze({
          bytesReceived: transfer.offset,
          totalBytes: transfer.total,
          chunkCount: snapshot.chunkCount,
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
    if (result.code === protocol.MSG_UDP_LINK_REQUEST) {
      if (protocol.encodeUDPLinkEstablished) {
        sendSessionPacket(session, result.channel ?? CHANNEL_TCP, protocol.encodeUDPLinkEstablished());
      }
      return;
    }
    if (result.code === protocol.MSG_UDP_LINK_ESTABLISHED) {
      session.udpReady = true;
      appendEvent("BZFlag UDP link established.");
      return;
    }
    if (result.code === protocol.MSG_ACCEPT) {
      if (!session.queriesSent) {
        session.queriesSent = true;
        if (protocol.encodeQueryGame) sendSessionPacket(session, CHANNEL_TCP, protocol.encodeQueryGame());
        if (protocol.encodeQueryPlayers) sendSessionPacket(session, CHANNEL_TCP, protocol.encodeQueryPlayers());
      }
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
      appendWorldChunk(session, result);
    }
  }

  function connectGateway(connection: Connection, onMessage: (data: unknown) => void): WebSocket | null {
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
      setStatus(t("connected"), "success");
      appendEvent(`Binary BZWB bridge ready for server ID ${safeText(connection?.serverId)}.`);
      appendEvent("Gateway is validating the BZFS handshake before forwarding game traffic.");
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
          appendEvent(`BZFS ${greeting.version} handshake complete; gateway player ID ${greeting.playerId}.`);
          sendInitialProtocolPackets(session);
          serverPayload = greeting.payload;
        }
        if (serverPayload.byteLength === 0) return;
        const stream = bridge.channel === CHANNEL_TCP ? session.tcpStream : session.udpStream;
        const packets = stream ? stream.push(serverPayload) : [serverPayload];
        for (const packet of packets) {
          const result = protocol.consume(bridge.channel, packet, { nickname: session.connection?.nickname }) as ProtocolResult;
          const transition = session.worldState?.apply(result);
          if (transition?.applied && session.worldState) {
            const snapshot = session.worldState.snapshot();
            session.renderer?.setWorldState?.(snapshot);
            if (typeof document !== "undefined") {
              document.dispatchEvent(new CustomEvent("bzflag:world-state", {
                detail: snapshot
              }));
            }
          }
          if (result?.local && result.player && session.inputState) {
            session.inputState.playerId = Number.isInteger(result.player.playerId) ? Number(result.player.playerId) : null;
            appendEvent(`Assigned BZFlag player ID ${result.player.playerId}.`);
          }
          if (result?.data && session.inputState && result.data.playerId === session.inputState.playerId) {
            if (result.code === protocol.MSG_PLAYER_UPDATE || result.code === protocol.MSG_PLAYER_UPDATE_SMALL || result.code === protocol.MSG_ALIVE) {
              Object.assign(session.inputState, result.data, { physicsReady: true });
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
    getChannel: (command?: string, phase?: string, state?: Record<string, any>, payload?: Uint8Array) => number = () => CHANNEL_TCP
  ): () => void {
    const pressed = new Set();
    const sendCommand = (command: string, phase: string, key: string): void => {
      const state = getInputState(command, phase, key) || {};
      const protocol = window.BZFlagWebProtocol;
      if (socket?.readyState === WebSocket.OPEN && protocol?.encodeInput) {
        const payload = protocol.encodeInput(command, phase, key, state);
        if (payload) {
          const channel = getChannel(command, phase, state, payload);
        socket.send(encodeBridgeMessage(channel, payload) as unknown as ArrayBuffer);
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

  function bindControls(audio: AudioEngine, renderer: BZFlagWebRendererHandle): void {
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
      renderer.stop?.();
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
    bindControls(audio, renderer);
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
        snapshot: worldAssembler?.snapshot?.() || null,
        summary: null
      },
      tcpStream: new protocolApi.PacketStream(),
      udpStream: new protocolApi.PacketStream()
    };
    const socket = connectGateway(connection, (data) => handleGatewayMessage(data, protocolSession));
    protocolSession.socket = socket;
    bindKeyboard(socket, audio, (command = "", phase = "") => {
      renderer.handleInput?.(command, phase);
      // Until the renderer supplies a physics snapshot, this remains null for
      // movement and shot commands. Local key handling still works and is ready
      // for the authoritative state adapter without changing the wire format.
      if (inputState.physicsReady && inputState.playerId !== null) {
        inputState.order = Math.min(0x7fffffff, inputState.order + 1);
        inputState.timestamp = (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()) / 1000;
        return inputState;
      }
      return { command, phase };
    }, (command = "") => {
      const udpCommands = new Set(["move-forward", "move-backward", "turn-left", "turn-right", "fire", "shot-end"]);
      return protocolSession.udpReady && udpCommands.has(command) ? CHANNEL_UDP : CHANNEL_TCP;
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
    AudioEngine,
    decodeBridgeMessage,
    encodeBridgeMessage,
    toWebSocketUrl,
    toWebSocketProtocols
  };
  document.addEventListener("DOMContentLoaded", init);
})();
