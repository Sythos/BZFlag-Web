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

  const DEFAULT_LOCALE = "en";
  const LOCALE_STORAGE_KEY = "bzflag-web.locale.v1";
  const SUPPORTED_LOCALES = [
    "cs_CZ",
    "da",
    "de",
    "en_US_l33t",
    "en_US_redneck",
    "es",
    "fr",
    "it",
    "kg",
    "lt",
    "nl",
    "pt",
    "ru",
    "sk",
    "sv",
    "xx"
  ];

  const ENGLISH = {
    language: "Language",
    clientReady: "Client ready",
    connection: "Connection",
    title: "Connect to a BZFS server",
    intro: "Choose an official endpoint configured by the gateway, then enter your player details. The browser client keeps the game window independent from this setup screen.",
    officialOnly: "Official network only",
    officialOnlyHint: "Custom servers stay disabled until an explicit allowlist is added.",
    rendererReady: "Renderer ready",
    rendererHint: "WebGPU first, with a WebGL2 fallback for modern browsers.",
    offlineReady: "Installable shell",
    offlineHint: "The app shell can be cached as a PWA on HTTPS or localhost.",
    playerSession: "Player session",
    playerDetails: "Player details",
    nickname: "Nickname",
    nicknamePlaceholder: "How should other players see you?",
    nicknameHelp: "Use 1–32 characters.",
    server: "Server",
    serverPlaceholder: "Official server hostname",
    serverHelp: "The selected server ID maps to a host and port in the gateway allowlist.",
    port: "Port",
    password: "Password",
    passwordPlaceholder: "Optional server password",
    passwordHelp: "Only save it if this is a trusted device. It is never sent to analytics.",
    rememberPassword: "Save password on this device",
    gateway: "Gateway endpoint",
    gatewayPlaceholder: "/bridge",
    sessionToken: "Gateway session token",
    sessionTokenPlaceholder: "Provided by the gateway operator",
    sessionTokenHelp: "Used only for this tab. It is never written to localStorage.",
    team: "Team",
    teamAutomatic: "Automatic",
    teamRogue: "Rogue",
    teamRed: "Red",
    teamGreen: "Green",
    teamBlue: "Blue",
    teamPurple: "Purple",
    teamObserver: "Observer",
    motto: "Motto",
    mottoPlaceholder: "Optional player motto",
    clientOptions: "Client options",
    enableAudio: "Enable audio",
    preferWebGPU: "Prefer WebGPU when available",
    fullscreenHint: "Use F11 for browser fullscreen.",
    connect: "Connect",
    connecting: "Waiting for gateway",
    connected: "Gateway connected",
    disconnected: "Disconnected",
    disconnect: "Disconnect",
    toggleAudio: "Toggle audio",
    fullscreen: "Fullscreen",
    score: "Score",
    kills: "Kills",
    health: "Health",
    move: "move",
    fire: "fire",
    dropFlag: "drop flag",
    scoreboard: "scoreboard",
    session: "Session",
    player: "Player",
    rendering: "Rendering",
    webgpu: "WebGPU",
    webgpuPrimary: "Primary renderer",
    webgl2: "WebGL2",
    webglFallback: "Fallback renderer",
    gatewayNoteTitle: "Gateway boundary",
    gatewayNote: "The browser never opens a raw BZFS socket. The Node.js bridge validates the allowlist and carries the session over WebSocket/WSS.",
    previewNotice: "Renderer preview active. Server protocol messages will appear here.",
    audio: "Audio",
    audioOn: "On",
    audioOff: "Off",
    volume: "Volume",
    footerNote: "A browser client shell for the BZFlag network. The gateway remains responsible for server access.",
    disclaimer: "Unofficial browser client shell. BZFlag and BZFS remain projects of their respective maintainers.",
    connectStatus: "Preparing the game window…",
    gatewayUnavailable: "Gateway is not reachable yet; the local renderer preview remains active.",
    invalidGateway: "Use a same-origin, ws://, or wss:// gateway endpoint.",
    missingSessionToken: "Enter the gateway session token before connecting.",
    storageUnavailable: "Browser storage is unavailable; preferences will remain in memory.",
    webgpuUnavailable: "WebGPU unavailable; using WebGL2 fallback.",
    webglUnavailable: "Neither WebGPU nor WebGL2 is available in this browser."
  };

  /* The upstream BZFlag data/l10n locale list is kept intact. Missing strings
     intentionally fall back to English while each locale pack is expanded. */
  const LOCALE_PACKS = {
    cs_CZ: { language: "Čeština", connect: "Připojit", disconnect: "Odpojit", nickname: "Přezdívka", server: "Server", password: "Heslo", team: "Tým", motto: "Motto", score: "Skóre", kills: "Zabití", health: "Zdraví" },
    da: { language: "Dansk", connect: "Forbind", disconnect: "Afbryd", nickname: "Kaldenavn", server: "Server", password: "Adgangskode", team: "Hold", motto: "Motto", score: "Point", kills: "Drab", health: "Helbred" },
    de: { language: "Deutsch", connect: "Verbinden", disconnect: "Trennen", nickname: "Spitzname", server: "Server", password: "Passwort", team: "Team", motto: "Motto", score: "Punktzahl", kills: "Abschüsse", health: "Gesundheit" },
    en_US_l33t: { language: "English (l33t)", connect: "C0nn3ct", disconnect: "D1sc0nn3ct", nickname: "N1ckn4m3", server: "S3rv3r", password: "P4ssw0rd", team: "T34m", score: "Sc0r3", kills: "K1lls", health: "H34lth" },
    en_US_redneck: { language: "English (redneck)", connect: "Hook up", disconnect: "Unhook", nickname: "Handle", server: "Server", password: "Passcode", team: "Team", score: "Score", kills: "Takedowns", health: "Health" },
    es: { language: "Español", connect: "Conectar", disconnect: "Desconectar", nickname: "Apodo", server: "Servidor", password: "Contraseña", team: "Equipo", motto: "Lema", score: "Puntuación", kills: "Bajas", health: "Salud" },
    fr: { language: "Français", connect: "Connexion", disconnect: "Déconnexion", nickname: "Pseudonyme", server: "Serveur", password: "Mot de passe", team: "Équipe", motto: "Devise", score: "Score", kills: "Éliminations", health: "Santé" },
    it: { language: "Italiano", connect: "Connetti", disconnect: "Disconnetti", nickname: "Nickname", server: "Server", password: "Password", team: "Squadra", motto: "Motto", score: "Punteggio", kills: "Uccisioni", health: "Salute" },
    kg: { language: "Kyrgyz", connect: "Connect", disconnect: "Disconnect", nickname: "Nickname", server: "Server", password: "Password", team: "Team", motto: "Motto" },
    lt: { language: "Lietuvių", connect: "Prisijungti", disconnect: "Atsijungti", nickname: "Slapyvardis", server: "Serveris", password: "Slaptažodis", team: "Komanda", motto: "Devizas", score: "Taškai", kills: "Nužudymai", health: "Sveikata" },
    nl: { language: "Nederlands", connect: "Verbinden", disconnect: "Verbinding verbreken", nickname: "Bijnaam", server: "Server", password: "Wachtwoord", team: "Team", motto: "Motto", score: "Score", kills: "Kills", health: "Gezondheid" },
    pt: { language: "Português", connect: "Ligar", disconnect: "Desligar", nickname: "Apelido", server: "Servidor", password: "Senha", team: "Equipe", motto: "Lema", score: "Pontuação", kills: "Abates", health: "Saúde" },
    ru: { language: "Русский", connect: "Подключить", disconnect: "Отключить", nickname: "Имя", server: "Сервер", password: "Пароль", team: "Команда", motto: "Девиз", score: "Счёт", kills: "Убийства", health: "Здоровье" },
    sk: { language: "Slovenčina", connect: "Pripojiť", disconnect: "Odpojiť", nickname: "Prezývka", server: "Server", password: "Heslo", team: "Tím", motto: "Motto", score: "Skóre", kills: "Zabitia", health: "Zdravie" },
    sv: { language: "Svenska", connect: "Anslut", disconnect: "Koppla från", nickname: "Smeknamn", server: "Server", password: "Lösenord", team: "Lag", motto: "Motto", score: "Poäng", kills: "Dödade", health: "Hälsa" },
    xx: { language: "Experimental", connect: "Connect", disconnect: "Disconnect", nickname: "Nickname", server: "Server", password: "Password", team: "Team", motto: "Motto" }
  };

  function normaliseLocale(locale) {
    if (!locale) {
      return DEFAULT_LOCALE;
    }
    const lower = String(locale).toLowerCase();
    const match = SUPPORTED_LOCALES.find((candidate) => candidate.toLowerCase() === lower);
    if (match) {
      return match;
    }
    const prefix = lower.split(/[-_]/)[0];
    return SUPPORTED_LOCALES.find((candidate) => candidate.toLowerCase().startsWith(`${prefix}_`) || candidate.toLowerCase() === prefix) || DEFAULT_LOCALE;
  }

  function readLocale() {
    try {
      return normaliseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY) || navigator.language);
    } catch {
      return normaliseLocale(navigator.language);
    }
  }

  let activeLocale = readLocale();

  function translate(key, locale = activeLocale) {
    const pack = LOCALE_PACKS[locale] || {};
    return pack[key] || ENGLISH[key] || key;
  }

  function applyTranslations(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      element.textContent = translate(key);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      const key = element.getAttribute("data-i18n-placeholder");
      element.setAttribute("placeholder", translate(key));
    });
    root.querySelectorAll("[data-i18n-title]").forEach((element) => {
      const key = element.getAttribute("data-i18n-title");
      element.setAttribute("title", translate(key));
    });
    document.documentElement.lang = activeLocale === DEFAULT_LOCALE ? "en" : activeLocale;
    document.dispatchEvent(new CustomEvent("bzflag:localechange", { detail: { locale: activeLocale } }));
  }

  function setLocale(locale) {
    activeLocale = normaliseLocale(locale);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, activeLocale);
    } catch {
      /* Storage is optional for a static shell. */
    }
    applyTranslations();
  }

  function populateLocaleSelect(select) {
    if (!select) {
      return;
    }
    select.replaceChildren();
    const defaultOption = document.createElement("option");
    defaultOption.value = DEFAULT_LOCALE;
    defaultOption.textContent = "English";
    select.append(defaultOption);
    SUPPORTED_LOCALES.forEach((locale) => {
      const option = document.createElement("option");
      option.value = locale;
      option.textContent = LOCALE_PACKS[locale]?.language || locale;
      select.append(option);
    });
    select.value = activeLocale;
    select.addEventListener("change", () => setLocale(select.value));
  }

  window.BZFlagWebI18n = {
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    LOCALE_PACKS,
    applyTranslations,
    getLocale: () => activeLocale,
    populateLocaleSelect,
    setLocale,
    t: translate
  };

  document.addEventListener("DOMContentLoaded", () => {
    applyTranslations();
    populateLocaleSelect(document.querySelector("[data-locale-select]"));
  });
})();
