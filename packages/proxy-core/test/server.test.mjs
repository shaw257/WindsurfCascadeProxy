import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(packageDirectory, "cli.mjs");

test("proxy binds only localhost and exposes controlled health", async () => {
  const port = await freePort();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "windsurf-server-test-"));
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    onboardingCompleted: true,
    connections: [{
      id: "default",
      name: "Mock",
      providerTemplate: "custom",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "secret-test-key",
      wireApi: "chat",
      defaultModel: "mock-model",
      thinkingMode: "default",
      thinkingEffort: "default",
      thinkingBudgetTokens: 0
    }],
    routes: [],
    runtime: {
      defaultConnectionId: "default",
      nodePath: "",
      windsurfPath: "",
      port,
      launchWindsurfOnStart: false,
      minimizeToTrayOnClose: true
    }
  }));

  const token = "control-test-token";
  const child = spawn(process.execPath, [
    cliPath,
    "serve",
    "--config", configPath,
    "--instance", "test-instance",
    "--token", token
  ], { cwd: packageDirectory });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; });

  try {
    await waitForHealth(port);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.instance_id, "test-instance");
    assert.equal(health.port, port);
    assert.equal(stdout.includes("secret-test-key"), false);

    for (const origin of ["https://untrusted.example", "null", "http://127.0.0.1:1"]) {
      const denied = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin } });
      assert.equal(denied.status, 403);
    }
    for (const host of [`untrusted.example:${port}`, "malformed host", ""]) {
      assert.equal(await requestStatus(port, { host }), 403, `Host ${JSON.stringify(host)} must be refused`);
    }
    for (const origin of [`http://localhost:${port}`, "vscode-file://vscode-app", "vscode-webview://test-editor"]) {
      const sameOrigin = await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin } });
      assert.equal(sameOrigin.status, 200);
    }

    const forbidden = await fetch(`http://127.0.0.1:${port}/control/reload`, { method: "POST" });
    assert.equal(forbidden.status, 403);
    const changedConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    changedConfig.connections[0].defaultModel = "reloaded-model";
    changedConfig.runtime.port = await freePort();
    fs.writeFileSync(configPath, JSON.stringify(changedConfig));
    const reloaded = await fetch(`http://127.0.0.1:${port}/control/reload`, { method: "POST", headers: { "x-control-token": token } });
    assert.equal(reloaded.status, 200);
    let status = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(status.model, "reloaded-model");
    assert.equal(status.port, port);
    fs.writeFileSync(configPath, "{");
    const rejected = await fetch(`http://127.0.0.1:${port}/control/reload`, { method: "POST", headers: { "x-control-token": token } });
    assert.equal(rejected.status, 500);
    status = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(status.model, "reloaded-model");
    const exited = once(child, "exit");
    const stopped = await fetch(`http://127.0.0.1:${port}/control/shutdown`, {
      method: "POST",
      headers: { "x-control-token": token }
    });
    assert.equal(stopped.status, 200);
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function requestStatus(port, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/health", setHost: false, headers }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Process may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("proxy did not become healthy");
}
