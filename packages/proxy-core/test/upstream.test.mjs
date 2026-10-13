import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fetchModels, testUpstream } from "../upstream.mjs";

async function mock(t, wireApi, responder, model = "mock-model") {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = { path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(request);
    const response = responder(request, requests.length);
    res.writeHead(response.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-upstream-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    connections: [{ id: "c", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "mock-secret-not-sk", wireApi, defaultModel: model, thinkingEffort: "high" }],
    routes: [], runtime: { defaultConnectionId: "c" }
  }));
  return { configPath, requests };
}

for (const wireApi of ["chat", "responses", "anthropic"]) {
  test(`connection test uses ${wireApi} protocol and redacts keys`, async t => {
    const payload = wireApi === "chat"
      ? { model: "actual-model", choices: [{ message: { content: "pong" } }] }
      : wireApi === "responses"
        ? { model: "actual-model", output: [{ content: [{ type: "output_text", text: "pong" }] }] }
        : { model: "actual-model", content: [{ type: "text", text: "pong" }] };
    const { configPath, requests } = await mock(t, wireApi, () => ({ body: payload }));
    const result = await testUpstream(configPath);
    assert.equal(result.ok, true);
    assert.equal(result.requestModel, "mock-model");
    assert.equal(result.returnedModel, "actual-model");
    assert.equal(result.responseText, "pong");
    assert.equal(JSON.stringify(result).includes("mock-secret-not-sk"), false);
    assert.equal(requests[0].path, wireApi === "chat" ? "/v1/chat/completions" : wireApi === "responses" ? "/v1/responses" : "/v1/messages");
    assert.equal(wireApi === "anthropic" ? requests[0].headers["x-api-key"] : requests[0].headers.authorization, wireApi === "anthropic" ? "mock-secret-not-sk" : "Bearer mock-secret-not-sk");
  });
}

test("unsupported reasoning is retried once and no longer reports high", async t => {
  const { configPath, requests } = await mock(t, "chat", (_req, count) => count === 1
    ? { status: 400, body: { error: "reasoning_effort not supported" } }
    : { body: { choices: [{ message: { content: "pong" } }] } });
  const result = await testUpstream(configPath);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.thinkingEffort, "default");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.equal("reasoning_effort" in requests[1].body, false);
});

test("model listing works with no model name and removes duplicates", async t => {
  const { configPath, requests } = await mock(t, "chat", () => ({ body: { data: [{ id: "b" }, { id: "a" }, { id: "b" }] } }), "");
  const result = await fetchModels(configPath, "c");
  assert.deepEqual(result.models, ["a", "b"]);
  assert.equal(requests[0].path, "/v1/models");
  assert.equal(JSON.stringify(result).includes("mock-secret-not-sk"), false);
});

test("model errors preserve upstream details without exposing arbitrary keys", async t => {
  const { configPath } = await mock(t, "chat", () => ({ status: 401, body: { error: "invalid mock-secret-not-sk" } }), "");
  await assert.rejects(fetchModels(configPath, "c"), error => error.message.includes("HTTP 401") && error.message.includes("[REDACTED]") && !error.message.includes("mock-secret-not-sk"));
});
