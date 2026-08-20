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

  const WEB_VERSION = "0.1.0";
  const BUILD_DATE = "2026-08-20";
  const BZFS_VERSION = "2.4.31";
  const UPSTREAM_REF = "59b3ef44fa4538296be8b7f5eeafc2a4e57d0b74";
  const PREFERENCES_KEY = "bzflag-web.preferences.v1";
  const CONNECTION_KEY = "bzflag-web.connection.v1";

  const elements = {};
  let storageAvailable = true;

  function getStorage(storage) {
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

  function readJson(storage, key, fallback = {}) {
    if (!storage) {
      return fallback;
    }
    try {
      const value = JSON.parse(storage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(storage, key, value) {
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

  function getElement(id) {
    return document.getElementById(id);
  }

  function t(key) {
    return window.BZFlagWebI18n?.t(key) || key;
  }

  function showStatus(message, kind = "") {
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

  function loadPreferences(storage) {
    const preferences = readJson(storage, PREFERENCES_KEY);
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

  function collectPreferences() {
    const values = {
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

  function savePreferences(storage, values) {
    if (!storage) {
      return;
    }
    const preferences = { ...values };
    if (!values.rememberPassword) {
      delete preferences.password;
    }
    writeJson(storage, PREFERENCES_KEY, preferences);
  }

  function buildConnection(storage) {
    const values = collectPreferences();
    const session = {
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

  function normaliseGatewayEndpoint(endpoint) {
    const value = String(endpoint || "/bridge").trim();
    if (value.startsWith("/")) {
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

  function handleSubmit(event, localStorage, sessionStorage) {
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
    elements.form.querySelector("button[type=submit]").disabled = true;
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

    const localStorage = getStorage(window.localStorage);
    const sessionStorage = getStorage(window.sessionStorage);
    loadPreferences(localStorage);
    updateFooter();
    registerServiceWorker();

    elements.serverPreset.addEventListener("change", handlePresetChange);
    elements.rememberPassword.addEventListener("change", () => {
      if (!elements.rememberPassword.checked) {
        elements.password.value = "";
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
