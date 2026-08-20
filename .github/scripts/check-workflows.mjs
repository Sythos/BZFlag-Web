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

function requireBefore(source, path, firstMarker, secondMarker) {
  const firstIndex = source.indexOf(firstMarker);
  const secondIndex = source.indexOf(secondMarker);
  if (firstIndex < 0 || secondIndex < 0) return;
  if (firstIndex >= secondIndex) {
    failures.push(`${path}: ${firstMarker} must run before ${secondMarker}`);
  }
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

const checkoutActionNode24Marker = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
for (const [name, source] of workflows) {
  if (source.includes("actions/checkout@")) {
    requireMarker(source, join(workflowDirectory, name), checkoutActionNode24Marker);
  }
}

const setupNodeActionNode24Marker = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
for (const [name, source] of workflows) {
  if (source.includes("actions/setup-node@")) {
    requireMarker(source, join(workflowDirectory, name), setupNodeActionNode24Marker);
  }
}

const ci = workflows.get("ci.yml") || "";
requireMarker(ci, ".github/workflows/ci.yml", "npm ci --prefix");
requireMarker(ci, ".github/workflows/ci.yml", "node-version: 26.7.0");
requireMarker(ci, ".github/workflows/ci.yml", "node .github/scripts/check-runtime-versions.mjs");
requireMarker(ci, ".github/workflows/ci.yml", "npm run typecheck --prefix server");
requireMarker(ci, ".github/workflows/ci.yml", "npm run typecheck --prefix client");
requireMarker(ci, ".github/workflows/ci.yml", "npm test --prefix server");
requireMarker(ci, ".github/workflows/ci.yml", "npm test --prefix client");
requireMarker(ci, ".github/workflows/ci.yml", "node .github/scripts/check-readmes.mjs");
requireMarker(ci, ".github/workflows/ci.yml", "browser-e2e:");
requireMarker(ci, ".github/workflows/ci.yml", "run-browser-e2e.mjs");
requireMarker(ci, ".github/workflows/ci.yml", "playwright@1.62.1");
requireMarker(ci, ".github/workflows/ci.yml", "playwright install --dry-run --with-deps --only-shell chromium");
requireMarker(ci, ".github/workflows/ci.yml", "timeout 12m npx --prefix");
requireMarker(ci, ".github/workflows/ci.yml", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");

const container = workflows.get("container.yml") || "";
requireMarker(container, ".github/workflows/container.yml", "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e");
requireMarker(container, ".github/workflows/container.yml", "docker/login-action@dbcb813823bdd20940b903addbd779551569679f");
requireMarker(container, ".github/workflows/container.yml", "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a");
requireMarker(container, ".github/workflows/container.yml", "context: server");
requireMarker(container, ".github/workflows/container.yml", "file: server/Dockerfile");
requireMarker(container, ".github/workflows/container.yml", "IMAGE_NAME: ghcr.io/sythos/bzflag-web-server");
requireMarker(container, ".github/workflows/container.yml", "validate-docker-context.mjs");
requireMarker(container, ".github/workflows/container.yml", "push: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}");
requireMarker(container, ".github/workflows/container.yml", "load: ${{ github.event_name != 'push' }}");
requireMarker(container, ".github/workflows/container.yml", "if: github.event_name != 'push'");
requireBefore(container, ".github/workflows/container.yml", "validate-docker-context.mjs", "docker/build-push-action@");
if (/push:\s*\$\{\{\s*github\.event_name\s*!=\s*'pull_request'\s*\}\}/.test(container)) {
  failures.push(".github/workflows/container.yml: image publishing must be limited to the protected main push event");
}

const release = workflows.get("release.yml") || "";
requireMarker(release, ".github/workflows/release.yml", "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e");
requireMarker(release, ".github/workflows/release.yml", "docker/login-action@dbcb813823bdd20940b903addbd779551569679f");
requireMarker(release, ".github/workflows/release.yml", "docker/metadata-action@dc802804100637a589fabce1cb79ff13a1411302");
requireMarker(release, ".github/workflows/release.yml", "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a");
requireMarker(workflows.get("compliance.yml") || "", ".github/workflows/compliance.yml", "node-version: 26.7.0");
requireMarker(workflows.get("compliance.yml") || "", ".github/workflows/compliance.yml", "node .github/scripts/check-runtime-versions.mjs");
requireMarker(workflows.get("compliance.yml") || "", ".github/workflows/compliance.yml", "node .github/scripts/check-readmes.mjs");
requireMarker(release, ".github/workflows/release.yml", "node-version: 26.7.0");
requireMarker(release, ".github/workflows/release.yml", "node .github/scripts/check-runtime-versions.mjs");
requireMarker(release, ".github/workflows/release.yml", "needs:\n      - validate-ref\n      - verify");
requireMarker(release, ".github/workflows/release.yml", "context: server");
requireMarker(release, ".github/workflows/release.yml", "file: server/Dockerfile");
requireMarker(release, ".github/workflows/release.yml", "IMAGE_NAME: ghcr.io/sythos/bzflag-web-server");
requireMarker(release, ".github/workflows/release.yml", "node --check");
requireMarker(release, ".github/workflows/release.yml", "node .github/scripts/check-readmes.mjs");
requireMarker(release, ".github/workflows/release.yml", "validate-docker-context.mjs");
requireMarker(release, ".github/workflows/release.yml", "run-browser-e2e.mjs");
requireMarker(release, ".github/workflows/release.yml", "playwright@1.62.1");
requireMarker(release, ".github/workflows/release.yml", "playwright install --dry-run --with-deps --only-shell chromium");
requireMarker(release, ".github/workflows/release.yml", "timeout 12m npx --prefix");
requireMarker(release, ".github/workflows/release.yml", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
requireMarker(release, ".github/workflows/release.yml", "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c");
requireMarker(release, ".github/workflows/release.yml", "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8");
requireMarker(release, ".github/workflows/release.yml", "gh release view \"$RELEASE_TAG\" --repo \"$GITHUB_REPOSITORY\"");
requireMarker(release, ".github/workflows/release.yml", "--repo \"$GITHUB_REPOSITORY\" --clobber");
requireMarker(release, ".github/workflows/release.yml", "zip -X -q -r \"bzflag-web-client-${version}.zip\"");
requireMarker(release, ".github/workflows/release.yml", "zip -X -q -r \"bzflag-web-server-${version}.zip\"");
const security = workflows.get("security.yml") || "";
requireMarker(security, ".github/workflows/security.yml", "github/codeql-action/init@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd");
requireMarker(security, ".github/workflows/security.yml", "github/codeql-action/analyze@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd");
requireMarker(security, ".github/workflows/security.yml", "github/codeql-action/upload-sarif@ff2f1c621b7f889edc0d3c761ac2e6a3f8cdb0dd");
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
