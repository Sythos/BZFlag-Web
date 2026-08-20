/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) Sythos (https://www.sythos.net)
 *
 * Small, dependency-free smoke checks for the public HTML entry points. The
 * browser client is intentionally static, so these checks run on every
 * supported runner without a DOM package or a browser installation.
 */

import { access, readFile } from "node:fs/promises";

const files = [
  ["server/index.html", ["Sythos (https://www.sythos.net)", "Node.js", "gateway"]],
  ["client/index.html", ["Sythos (https://www.sythos.net)", "F11", "BZFS", "connect"]],
  ["client/web_game_run.html", ["Sythos (https://www.sythos.net)", "BZFS"]],
];

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const failures = [];
let checked = 0;

for (const [path, requiredText] of files) {
  if (!(await exists(path))) {
    continue;
  }

  checked += 1;
  const source = await readFile(path, "utf8");
  const normalized = source.toLowerCase();

  for (const token of ["<!doctype html", "<html", "</html>", "<head", "</head>", "<body", "</body>", "<title"] ) {
    if (!normalized.includes(token)) {
      failures.push(`${path}: missing required HTML token ${token}`);
    }
  }

  for (const token of requiredText) {
    if (!normalized.includes(token.toLowerCase())) {
      failures.push(`${path}: missing required project marker ${token}`);
    }
  }
}

if (checked === 0) {
  console.log("No server/client HTML entry points are present yet; HTML smoke checks skipped.");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else if (checked > 0) {
  console.log(`Validated ${checked} server/client HTML entry point(s).`);
}
