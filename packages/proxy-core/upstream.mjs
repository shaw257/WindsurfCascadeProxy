import { joinEndpoint, readConfig, redact, resolveConnection, resolveRoute } from "./app-config.mjs";

export async function testUpstream(configPath, options = {}) {
  const config = readConfig(configPath);
  const requestId = cryptoRandomId();
  const route = options.windsurfModelId
    ? resolveRoute(config, options.windsurfModelId)
    : connectionAsRoute(resolveConnection(config, options.connectionId));
  validateRoute(route);

  const startedAt = Date.now();
  let result = await sendTest(route, true);
  let degraded = false;
  if (!result.ok && result.thinkingRejected) {
    result = await sendTest(route, false);
    degraded = result.ok;
  }

  return {
    ok: result.ok,
    requestModel: route.model,
    returnedModel: result.returnedModel || "",
    wireApi: route.wireApi,
    latencyMs: Date.now() - startedAt,
    responseText: result.responseText || "",
    status: result.status,
    thinkingEffort: degraded ? "default" : result.thinkingEffort || route.thinkingEffort,
    degraded,
    raw: redact(result.raw, [route.apiKey]),
    requestId,
    rawRequest: redact(result.rawRequest || "", [route.apiKey]),
    rawResponse: redact(result.raw, [route.apiKey])
  };
}

export async function fetchModels(configPath, connectionId = "") {
  const config = readConfig(configPath);
  const connection = resolveConnection(config, connectionId);
  if (!connection) throw new Error("没有可用的上游连接。");
  if (!connection.baseUrl) throw new Error("接口地址不能为空。");
  if (!connection.apiKey) throw new Error("API 密钥不能为空。");

  const endpoint = joinEndpoint(connection.baseUrl, "models");
  const headers = authHeaders(connection);
  const rawRequest = redact(JSON.stringify({
    method: "GET",
    endpoint,
    headers
  }, null, 2), [connection.apiKey]);
  const startedAt = Date.now();
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw httpError(response.status, text, [connection.apiKey]);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`模型列表不是有效 JSON：${redact(text.slice(0, 800), [connection.apiKey])}`);
  }

  const values = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : []);
  const models = values
    .map(item => typeof item === "string" ? item : item?.id || item?.name)
    .filter(Boolean)
    .map(String);
  return {
    ok: true,
    endpoint,
    latencyMs: Date.now() - startedAt,
    models: [...new Set(models)].sort(),
    rawRequest,
    rawResponse: redact(text, [connection.apiKey])
  };
}

async function sendTest(route, includeThinking) {
  const endpoint = route.wireApi === "anthropic"
    ? joinEndpoint(route.baseUrl, "messages")
    : route.wireApi === "responses"
      ? joinEndpoint(route.baseUrl, "responses")
      : joinEndpoint(route.baseUrl, "chat/completions");
  const headers = authHeaders(route);
  const payload = buildTestPayload(route, includeThinking);
  const rawRequest = redact(JSON.stringify({
    method: "POST",
    endpoint,
    headers: { ...headers, "content-type": "application/json" },
    body: payload
  }, null, 2), [route.apiKey]);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Raw text is included in the result.
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      raw: text,
      rawRequest,
      thinkingRejected: includeThinking && isThinkingParameterError(response.status, text)
    };
  }

  return {
    ok: true,
    status: response.status,
    raw: text,
    rawRequest,
    returnedModel: parsed?.model || "",
    responseText: extractText(parsed, route.wireApi),
    thinkingEffort: parsed?.reasoning?.effort || parsed?.output_config?.effort || ""
  };
}

function cryptoRandomId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildTestPayload(route, includeThinking) {
  if (route.wireApi === "anthropic") {
    const payload = {
      model: route.model,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with exactly: pong" }]
    };
    if (includeThinking) {
      if (route.thinkingMode === "adaptive") payload.thinking = { type: "adaptive" };
      if (route.thinkingMode === "enabled") {
        payload.thinking = { type: "enabled", budget_tokens: Math.max(1024, Number(route.thinkingBudgetTokens || 1024)) };
        payload.max_tokens = Math.max(payload.max_tokens, payload.thinking.budget_tokens + 32);
      }
      if (route.thinkingMode === "disabled") payload.thinking = { type: "disabled" };
      if (route.thinkingEffort !== "default") payload.output_config = { effort: route.thinkingEffort };
    }
    return payload;
  }

  if (route.wireApi === "responses") {
    const payload = {
      model: route.model,
      input: "Reply with exactly: pong",
      max_output_tokens: 32
    };
    if (includeThinking && route.thinkingEffort !== "default") {
      payload.reasoning = { effort: route.thinkingMode === "disabled" ? "none" : route.thinkingEffort };
    }
    return payload;
  }

  const payload = {
    model: route.model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    max_tokens: 32,
    stream: false
  };
  if (includeThinking && route.thinkingEffort !== "default") payload.reasoning_effort = route.thinkingEffort;
  return payload;
}

function authHeaders(connection) {
  if (connection.wireApi === "anthropic") {
    return {
      "x-api-key": connection.apiKey,
      "anthropic-version": "2023-06-01"
    };
  }
  return { authorization: `Bearer ${connection.apiKey}` };
}

function connectionAsRoute(connection) {
  if (!connection) return null;
  return {
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    model: connection.defaultModel,
    wireApi: connection.wireApi,
    thinkingMode: connection.thinkingMode,
    thinkingEffort: connection.thinkingEffort,
    thinkingBudgetTokens: connection.thinkingBudgetTokens
  };
}

function validateRoute(route) {
  if (!route) throw new Error("没有可用的上游连接。");
  if (!route.baseUrl) throw new Error("接口地址不能为空。");
  if (!route.apiKey) throw new Error("API 密钥不能为空。");
  if (!route.model) throw new Error("模型名称不能为空。");
}

function extractText(value, wireApi) {
  if (!value) return "";
  if (wireApi === "anthropic") {
    return (value.content || []).filter(item => item?.type === "text").map(item => item.text || "").join("");
  }
  if (wireApi === "responses") {
    if (value.output_text) return String(value.output_text);
    return (value.output || []).flatMap(item => item?.content || [])
      .filter(item => item?.type === "output_text")
      .map(item => item.text || "")
      .join("");
  }
  return value.choices?.[0]?.message?.content || "";
}

function isThinkingParameterError(status, text) {
  if (![400, 404, 422].includes(status)) return false;
  return /thinking|reasoning|effort|budget_tokens|output_config/i.test(text);
}

function httpError(status, text, secrets) {
  return new Error(`HTTP ${status}: ${redact(text.slice(0, 1600), secrets)}`);
}
