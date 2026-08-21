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

  type Preferences = {
    nickname: string;
    serverId: string;
    serverHost: string;
    port: number;
    gateway: string;
    team: string;
    motto: string;
    audioEnabled: boolean;
    preferWebGPU: boolean;
    rememberPassword: boolean;
    password?: string;
  };

  type Connection = Preferences & {
    sessionToken: string;
    upstreamRef: string;
    bzfsVersion: string;
    webVersion: string;
    buildDate: string;
    createdAt: string;
  };

  type AppElements = {
    form: HTMLFormElement;
    status: HTMLElement;
    nickname: HTMLInputElement;
    serverHost: HTMLInputElement;
    serverId: HTMLInputElement;
    serverPreset: HTMLSelectElement;
    port: HTMLInputElement;
    gateway: HTMLInputElement;
    sessionToken: HTMLInputElement;
    password: HTMLInputElement;
    rememberPassword: HTMLInputElement;
    team: HTMLSelectElement;
    motto: HTMLInputElement;
    audioEnabled: HTMLInputElement;
    preferWebGPU: HTMLInputElement;
    installButton: HTMLButtonElement;
  };

  type InstallPromptEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };

  const WEB_VERSION = "0.1.2";
  const BUILD_DATE = "2026-08-20";
  const BZFS_VERSION = "2.4.31";
  const UPSTREAM_REF = "59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74";
  const PREFERENCES_KEY = "bzflag-web.preferences.v1";
  const CONNECTION_KEY = "bzflag-web.connection.v1";

  const elements = {} as AppElements;
  let storageAvailable = true;
  let deferredInstallPrompt: InstallPromptEvent | null = null;

  function getStorage(storage: Storage | null): Storage | null {
    if (!storage) {
      storageAvailable = false;
      return null;
    }
    try {
      const marker = "__bzflag_web_storage_test__";
      storage.setItem(marker, marker);
      storage.removeItem(marker);
      return storage;
    } catch {
      storageAvailable = false;
      return null;
    }
  }

  function getWindowStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
    try {
      return getStorage(kind === "localStorage" ? window.localStorage : window.sessionStorage);
    } catch {
      storageAvailable = false;
      return null;
    }
  }

  function readJson<T extends Record<string, unknown>>(storage: Storage | null, key: string, fallback: T): T {
    if (!storage) {
      return fallback;
    }
    try {
      const value: unknown = JSON.parse(storage.getItem(key) || "null");
      return value && typeof value === "object" ? value as T : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(storage: Storage | null, key: string, value: unknown): boolean {
    if (!storage) {
      return false;
    }
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      storageAvailable = false;
      return false;
    }
  }

  function getElement<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
  }

  function t(key: string): string {
    return window.BZFlagWebI18n?.t(key) || key;
  }

  function showStatus(message: string, kind = ""): void {
    if (!elements.status) {
      return;
    }
    elements.status.className = `form-status ${kind}`.trim();
    elements.status.textContent = message;
  }

  function updateFooter() {
    const footer = getElement("client-credit");
    if (!footer) {
      return;
    }
    const shortRef = UPSTREAM_REF.slice(0, 8);
    footer.title = `Build ${BUILD_DATE}; web ${WEB_VERSION}; BZFS ${BZFS_VERSION}; upstream ${UPSTREAM_REF}`;
    footer.innerHTML = `[${BUILD_DATE} · web ${WEB_VERSION} · BZFS ${BZFS_VERSION} / ${shortRef}…] Sythos (<a href="https://www.sythos.net" rel="noopener noreferrer">https://www.sythos.net</a>)`;
  }

  function loadPreferences(storage: Storage | null): void {
    const preferences = readJson<Partial<Preferences>>(storage, PREFERENCES_KEY, {});
    if (preferences.nickname) elements.nickname.value = preferences.nickname;
    if (preferences.serverId) {
      elements.serverPreset.value = preferences.serverId;
      handlePresetChange();
    } else if (preferences.serverHost) {
      elements.serverHost.value = preferences.serverHost;
    }
    if (preferences.port) elements.port.value = String(preferences.port);
    if (preferences.gateway) elements.gateway.value = preferences.gateway;
    if (preferences.team) elements.team.value = preferences.team;
    if (preferences.motto) elements.motto.value = preferences.motto;
    if (typeof preferences.audioEnabled === "boolean") elements.audioEnabled.checked = preferences.audioEnabled;
    if (typeof preferences.preferWebGPU === "boolean") elements.preferWebGPU.checked = preferences.preferWebGPU;
    elements.rememberPassword.checked = preferences.rememberPassword === true;
    if (elements.rememberPassword.checked && typeof preferences.password === "string") {
      elements.password.value = preferences.password;
    }
  }

  function collectPreferences(): Preferences {
    const values: Preferences = {
      nickname: elements.nickname.value.trim(),
      serverId: elements.serverId.value,
      serverHost: elements.serverHost.value.trim().toLowerCase(),
      port: Number(elements.port.value),
      gateway: elements.gateway.value.trim(),
      team: elements.team.value,
      motto: elements.motto.value.trim(),
      audioEnabled: elements.audioEnabled.checked,
      preferWebGPU: elements.preferWebGPU.checked,
      rememberPassword: elements.rememberPassword.checked
    };
    if (values.rememberPassword && elements.password.value) {
      values.password = elements.password.value;
    }
    return values;
  }

  function savePreferences(storage: Storage | null, values: Preferences): void {
    if (!storage) {
      return;
    }
    const preferences = { ...values };
    if (!values.rememberPassword) {
      delete preferences.password;
    }
    writeJson(storage, PREFERENCES_KEY, preferences);
  }

  function clearSavedPassword(storage: Storage | null): void {
    if (!storage) {
      return;
    }
    const preferences = readJson<Partial<Preferences>>(storage, PREFERENCES_KEY, {});
    delete preferences.password;
    preferences.rememberPassword = false;
    writeJson(storage, PREFERENCES_KEY, preferences);
  }

  function buildConnection(storage: Storage | null): Connection {
    const values = collectPreferences();
    const session: Connection = {
      nickname: values.nickname,
      serverId: values.serverId,
      serverHost: values.serverHost,
      port: values.port,
      gateway: values.gateway || "/bridge",
      sessionToken: elements.sessionToken.value,
      team: values.team,
      motto: values.motto,
      audioEnabled: values.audioEnabled,
      preferWebGPU: values.preferWebGPU,
      rememberPassword: values.rememberPassword,
      upstreamRef: UPSTREAM_REF,
      bzfsVersion: BZFS_VERSION,
      webVersion: WEB_VERSION,
      buildDate: BUILD_DATE,
      createdAt: new Date().toISOString()
    };
    /* Session storage is scoped to this tab. It carries a current-session
       password only when the user explicitly opted into remembering it. */
    if (values.password) {
      session.password = values.password;
    }
    savePreferences(storage, values);
    return session;
  }

  function normaliseGatewayEndpoint(endpoint: string): string {
    const value = String(endpoint || "/bridge").trim();
    if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") && !value.split("/").includes("..")) {
      return value;
    }
    if (/^wss?:\/\//i.test(value)) {
      return value;
    }
    if (/^https?:\/\//i.test(value)) {
      return value.replace(/^http/i, "ws");
    }
    return "";
  }

  function registerInstallPrompt(): void {
    const button = elements.installButton;
    if (!button) {
      return;
    }
    button.hidden = true;
    window.addEventListener("beforeinstallprompt", (event) => {
      const installEvent = event as InstallPromptEvent;
      installEvent.preventDefault();
      deferredInstallPrompt = installEvent;
      button.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      deferredInstallPrompt = null;
      button.hidden = true;
      showStatus(t("appInstalled"), "success");
    });
    button.addEventListener("click", async () => {
      if (!deferredInstallPrompt) {
        showStatus(t("installUnavailable"));
        return;
      }
      const installEvent = deferredInstallPrompt;
      deferredInstallPrompt = null;
      try {
        await installEvent.prompt();
        const choice = await installEvent.userChoice;
        button.hidden = true;
        showStatus(choice.outcome === "accepted" ? t("appInstalled") : t("installDismissed"));
      } catch {
        showStatus(t("installUnavailable"), "error");
      }
    });
  }

  function handlePresetChange() {
    const option = elements.serverPreset.selectedOptions[0];
    if (!option) {
      return;
    }
    elements.serverId.value = option.value;
    elements.serverHost.value = option.dataset.host || "";
    if (option.dataset.port) {
      elements.port.value = option.dataset.port;
    }
  }

  function handleSubmit(event: SubmitEvent, localStorage: Storage | null, sessionStorage: Storage | null): void {
    event.preventDefault();
    if (!elements.form.checkValidity()) {
      elements.form.reportValidity();
      showStatus("Check the highlighted connection fields.", "error");
      return;
    }
    const gateway = normaliseGatewayEndpoint(elements.gateway.value);
    if (!gateway) {
      showStatus(t("invalidGateway"), "error");
      elements.gateway.focus();
      return;
    }
    elements.gateway.value = gateway;
    const session = buildConnection(localStorage);
    session.gateway = gateway;
    if (!writeJson(sessionStorage, CONNECTION_KEY, session)) {
      showStatus("This browser cannot open a session; enable session storage and try again.", "error");
      return;
    }
    showStatus(t("connectStatus"), "success");
    const submitButton = elements.form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submitButton) {
      submitButton.disabled = true;
    }
    window.setTimeout(() => {
      window.location.assign("./web_game_run.html");
    }, 180);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(() => {
      /* Local static hosting without a secure context can disable service
         workers; the shell remains fully usable without the cache layer. */
    });
  }

  function init() {
    if (document.documentElement.dataset.page !== "connect") {
      return;
    }
    elements.form = getElement("connect-form");
    elements.status = getElement("connect-status");
    elements.nickname = getElement("nickname");
    elements.serverHost = getElement("server-host");
    elements.serverId = getElement("server-id");
    elements.serverPreset = getElement("server-preset");
    elements.port = getElement("server-port");
    elements.gateway = getElement("gateway-endpoint");
    elements.sessionToken = getElement("session-token");
    elements.password = getElement("password");
    elements.rememberPassword = getElement("remember-password");
    elements.team = getElement("team");
    elements.motto = getElement("motto");
    elements.audioEnabled = getElement("audio-enabled");
    elements.preferWebGPU = getElement("prefer-webgpu");
    elements.installButton = getElement("install-button");

    const localStorage = getWindowStorage("localStorage");
    const sessionStorage = getWindowStorage("sessionStorage");
    loadPreferences(localStorage);
    updateFooter();
    registerServiceWorker();
    registerInstallPrompt();

    elements.serverPreset.addEventListener("change", handlePresetChange);
    elements.rememberPassword.addEventListener("change", () => {
      if (!elements.rememberPassword.checked) {
        elements.password.value = "";
        clearSavedPassword(localStorage);
      }
    });
    elements.form.addEventListener("submit", (event) => handleSubmit(event, localStorage, sessionStorage));
    if (!storageAvailable) {
      showStatus(t("storageUnavailable"));
    }
  }

  window.BZFlagWebClient = {
    BZFS_VERSION,
    BUILD_DATE,
    CONNECTION_KEY,
    UPSTREAM_REF,
    WEB_VERSION,
    normaliseGatewayEndpoint
  };

  document.addEventListener("DOMContentLoaded", init);
})();
