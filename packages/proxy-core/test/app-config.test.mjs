import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig, readConfig, redact, resolveRoute, toRuntimeConfig } from "../app-config.mjs";

test("route inherits reusable connection settings", () => {
  const config = normalizeConfig({
    schemaVersion: 1,
    connections: [{
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "secret",
      wireApi: "chat",
      defaultModel: "deepseek-chat",
      thinkingEffort: "high"
    }],
    routes: [{
      id: "route-1",
      windsurfModelId: "MODEL_CLAUDE_4_SONNET_BYOK",
      connectionId: "deepseek",
      model: "deepseek-reasoner",
      thinkingEffort: ""
    }],
    runtime: { defaultConnectionId: "deepseek", port: 3009 }
  });
  const route = resolveRoute(config, "MODEL_CLAUDE_4_SONNET_BYOK");
  assert.equal(route.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(route.model, "deepseek-reasoner");
  assert.equal(route.thinkingEffort, "high");
  assert.equal(toRuntimeConfig(config).modelRoutes.MODEL_CLAUDE_4_SONNET_BYOK.apiKey, "secret");
});

test("null route budget inherits; explicit zero overrides", () => {
  for (const budget of [null, undefined, "", 0, 4096]) {
    const config = normalizeConfig({
      connections: [{ id: "c", name: "Mock", thinkingBudgetTokens: 8192 }],
      routes: [{ windsurfModelId: "test", connectionId: "c", thinkingBudgetTokens: budget }],
      runtime: { defaultConnectionId: "c" }
    });
    assert.equal(resolveRoute(config, "test").thinkingBudgetTokens, budget === 0 || budget === 4096 ? budget : 8192);
  }
});

test("broken or unsupported configuration does not silently reset", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  assert.throws(() => readConfig(file));
  for (const contents of ["{", "null", "[]", '{"schemaVersion":99}']) {
    fs.writeFileSync(file, contents);
    assert.throws(() => readConfig(file));
  }
});

test("redaction covers arbitrary and JSON-escaped keys and auth headers", () => {
  const secret = 'custom-key\\with"quotes';
  const value = { detail: { echoed: secret }, authorization: "Bearer arbitrary-token", "x-api-key": "another-token" };
  const output = redact(value, [secret]);
  assert.doesNotThrow(() => JSON.parse(output));
  assert.equal(output.includes(JSON.stringify(secret).slice(1, -1)), false);
  assert.equal(output.includes("arbitrary-token"), false);
  assert.equal(output.includes("another-token"), false);
});
