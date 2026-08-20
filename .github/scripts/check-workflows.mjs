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
 *
 * Dependency-free structural checks for the repository workflows. actionlint
 * remains the YAML/action expression validator; this script protects the
 * project-specific release and container invariants that actionlint cannot
 * infer from the workflow syntax alone.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const workflowDirectory = ".github/workflows";
const requiredWorkflows = ["ci.yml", "compliance.yml", "container.yml", "release.yml", "security.yml", "workflow-lint.yml"];
const failures = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readWorkflow(name) {
  const path = join(workflowDirectory, name);
  if (!(await exists(path))) {
    failures.push(`${path}: required workflow is missing`);
    return "";
  }
  return readFile(path, "utf8");
}

function requireMarker(source, path, marker) {
  if (!source.includes(marker)) failures.push(`${path}: missing required marker ${marker}`);
}

const workflows = new Map();
for (const name of requiredWorkflows) workflows.set(name, await readWorkflow(name));

for (const [name, source] of workflows) {
  const path = join(workflowDirectory, name);
  for (const [lineNumber, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (!match) continue;
    const reference = match[1];
    if (!/@[0-9a-f]{40}$/i.test(reference)) {
      failures.push(`${path}:${lineNumber + 1}: action reference must use a full commit SHA: ${reference}`);
    }
  }
}

const ci = workflows.get("ci.yml") || "";
requireMarker(ci, ".github/workflows/ci.yml", "npm ci --prefix");
requireMarker(ci, ".github/workflows/ci.yml", "node-version: 26.x");
requireMarker(ci, ".github/workflows/ci.yml", "npm run typecheck --prefix server");
requireMarker(ci, ".github/workflows/ci.yml", "npm run typecheck --prefix client");
requireMarker(ci, ".github/workflows/ci.yml", "npm test --prefix server");
requireMarker(ci, ".github/workflows/ci.yml", "npm test --prefix client");

const container = workflows.get("container.yml") || "";
requireMarker(container, ".github/workflows/container.yml", "context: server");
requireMarker(container, ".github/workflows/container.yml", "file: server/Dockerfile");
requireMarker(container, ".github/workflows/container.yml", "push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}");
requireMarker(container, ".github/workflows/container.yml", "load: ${{ github.event_name != 'push' }}");
requireMarker(container, ".github/workflows/container.yml", "if: github.event_name != 'push'");
if (/push:\s*\$\{\{\s*github\.event_name\s*!=\s*'pull_request'\s*\}\}/.test(container)) {
  failures.push(".github/workflows/container.yml: image publishing must be limited to the protected main push event");
}

const release = workflows.get("release.yml") || "";
requireMarker(workflows.get("compliance.yml") || "", ".github/workflows/compliance.yml", "node-version: 26.x");
requireMarker(release, ".github/workflows/release.yml", "node-version: 26.x");
requireMarker(release, ".github/workflows/release.yml", "needs:\n      - validate-ref\n      - verify");
requireMarker(release, ".github/workflows/release.yml", "context: server");
requireMarker(release, ".github/workflows/release.yml", "file: server/Dockerfile");
requireMarker(release, ".github/workflows/release.yml", "node --check");
if (/find release -maxdepth 1 -type f[^\n]*>\s*release\/SHA256SUMS\.txt/.test(release)
  && !/!\s*-name\s+SHA256SUMS\.txt/.test(release)) {
  failures.push(".github/workflows/release.yml: SHA256SUMS.txt must not hash itself");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${workflows.size} workflow structure(s) and release invariants.`);
}
