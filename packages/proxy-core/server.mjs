#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import { URL } from "node:url";
import {
  readConfig,
  redact,
  toRuntimeConfig,
} from "./app-config.mjs";
import {
  parseFields,
  writeBytesField,
  writeFixed32Field,
  writeFixed64Field,
  writeStringField,
  writeVarintField,
} from "./src/proto.js";
import {
  endOfStreamEnvelope,
  streamHeaders,
  tryGunzip,
  wrapEnvelope,
} from "./src/connect.js";
import { parseGetChatMessageRequest } from "./src/handlers/parse-request.js";
import {
  buildErrorChunk,
  buildSignatureDelta,
  buildStopChunk,
  buildTextDelta,
  buildThinkingDelta,
  buildToolCallDelta,
  STOP_REASON,
} from "./src/handlers/build-response.js";

const CONFIG_PATH = process.env.WINDSURF_PROXY_CONFIG || new URL("./windsurf-proxy-config.json", import.meta.url);
const INSTANCE_ID = process.env.WINDSURF_PROXY_INSTANCE_ID || crypto.randomUUID();
const CONTROL_TOKEN = process.env.WINDSURF_PROXY_CONTROL_TOKEN || crypto.randomBytes(24).toString("hex");
let CONFIG = toRuntimeConfig(readConfig(CONFIG_PATH));

let PORT;
let OPENAI_BASE_URL;
let OPENAI_API_KEY;
let OPENAI_MODEL;
let OPENAI_WIRE_API;
let OPENAI_API_PATH;
let THINKING_MODE;
let THINKING_EFFORT;
let THINKING_BUDGET_TOKENS;
let MAX_TOKENS;
let ENABLE_TOOLS;
let MODEL_ROUTES;
let LOG_FULL_UPSTREAM_TRAFFIC;
applyRuntimeConfig(CONFIG, true);

const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
console.log = (...values) => emitLog("info", values);
console.warn = (...values) => emitLog("warn", values);
console.error = (...values) => emitLog("error", values);

const REAL_API_HOST = "server.self-serve.windsurf.com";
const REAL_WEBSITE_HOST = "windsurf.com";
const REAL_REGISTER_HOST = "register.windsurf.com";
const REAL_UNLEASH_HOST = "unleash.codeium.com";
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000;
const WINDSURF_PROXY_TIMEOUT_MS = 30_000;

let lastRequestStatus = {
  status: "",
  model: "",
  wireApi: "",
  at: "",
};

function loadConfig(pathOrUrl) {
  try {
    const raw = fs.readFileSync(pathOrUrl, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`Could not read config: ${error.message}`);
    return {};
  }
}

function applyRuntimeConfig(nextConfig, initial = false) {
  const previousPort = PORT;
  CONFIG = nextConfig;
  PORT = Number(configValue(["PORT", "WINDSURF_PROXY_PORT", "NATIVE_PROXY_PORT"], "port", 3009));
  OPENAI_BASE_URL = stripTrailingSlash(configValue(["OPENAI_BASE_URL", "OPENAI_API_BASE"], "openaiBaseUrl", "https://api.deepseek.com/v1"));
  OPENAI_API_KEY = configValue(["OPENAI_API_KEY", "API_KEY"], "openaiApiKey", "");
  OPENAI_MODEL = configValue(["OPENAI_MODEL", "MODEL"], "openaiModel", "deepseek-chat");
  OPENAI_WIRE_API = String(configValue(["OPENAI_WIRE_API", "WIRE_API"], "openaiWireApi", "chat") || "chat").toLowerCase();
  OPENAI_API_PATH = String(configValue(["OPENAI_API_PATH"], "openaiApiPath", "") || "").trim();
  THINKING_MODE = normalizeThinkingMode(configValue(["THINKING_MODE"], "thinkingMode", "default"));
  THINKING_EFFORT = normalizeThinkingEffort(configValue(["THINKING_EFFORT", "REASONING_EFFORT"], "thinkingEffort", "default"));
  THINKING_BUDGET_TOKENS = normalizeThinkingBudget(configValue(["THINKING_BUDGET_TOKENS"], "thinkingBudgetTokens", 0), 0);
  MAX_TOKENS = Number(configValue(["MAX_TOKENS"], "maxTokens", 8192));
  ENABLE_TOOLS = String(configValue(["ENABLE_TOOLS"], "enableTools", "true")).toLowerCase() !== "false";
  MODEL_ROUTES = normalizeModelRoutes(configValue([], "modelRoutes", {}));
  LOG_FULL_UPSTREAM_TRAFFIC = false;
  if (!initial && previousPort !== PORT) {
    emitEvent("restart-required", { reason: "port-changed", previousPort, port: PORT });
    PORT = previousPort;
  }
}

function emitLog(level, values) {
  const secrets = [OPENAI_API_KEY, ...Object.values(MODEL_ROUTES || {}).map(item => item?.apiKey)];
  const message = redact(values.map(value => {
    if (value instanceof Error) return value.stack || value.message;
    return typeof value === "string" ? value : JSON.stringify(value);
  }).join(" "), secrets);
  nativeConsole.log(JSON.stringify({
    event: "log",
    at: new Date().toISOString(),
    data: { level, message, instanceId: INSTANCE_ID }
  }));
}

function emitLogEntry(entry) {
  const secrets = [OPENAI_API_KEY, ...Object.values(MODEL_ROUTES || {}).map(item => item?.apiKey)];
  const data = {
    level: entry.level || "info",
    source: entry.source || "proxy",
    message: redact(entry.message || entry.summary || "", secrets),
    operation: entry.operation || "",
    requestId: entry.requestId || "",
    summary: redact(entry.summary || entry.message || "", secrets),
    detail: entry.detail ? JSON.parse(redact(entry.detail, secrets)) : null,
    rawRequest: entry.rawRequest ? redact(entry.rawRequest, secrets) : "",
    rawResponse: entry.rawResponse ? redact(entry.rawResponse, secrets) : "",
  };
  nativeConsole.log(JSON.stringify({
    event: "log_entry",
    at: new Date().toISOString(),
    data,
  }));
}

function emitEvent(event, data) {
  nativeConsole.log(JSON.stringify({ event, at: new Date().toISOString(), data }));
}

function configValue(envNames, key, fallback) {
  for (const name of envNames) {
    if (process.env[name] !== undefined && process.env[name] !== "") return process.env[name];
  }
  if (Object.prototype.hasOwnProperty.call(CONFIG, key)) return CONFIG[key];
  return fallback;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function stripProtocol(value) {
  return String(value || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function normalizeWireApi(value) {
  const wireApi = String(value || "chat").trim().toLowerCase();
  if (wireApi === "responses") return "responses";
  if (wireApi === "anthropic" || wireApi === "messages" || wireApi === "claude") return "anthropic";
  return "chat";
}

function normalizeBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() !== "false";
}

function normalizeThinkingMode(value) {
  const mode = String(value || "default").trim().toLowerCase();
  if (mode === "disabled" || mode === "adaptive" || mode === "enabled") return mode;
  return "default";
}

function normalizeThinkingEffort(value) {
  const effort = String(value || "default").trim().toLowerCase();
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) return effort;
  return "default";
}

function normalizeThinkingBudget(value, fallback) {
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) return fallback;
  return Math.min(Math.floor(budget), 1000000);
}

function normalizeModelRoutes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const routes = {};
  for (const [windsurfModel, route] of Object.entries(value)) {
    if (!windsurfModel || route === null || route === undefined) continue;
    routes[windsurfModel] = route;
  }
  return routes;
}

function buildDefaultRoute(requestedModel = "") {
  return {
    name: "default",
    windsurfModel: requestedModel || "",
    baseUrl: OPENAI_BASE_URL,
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    wireApi: normalizeWireApi(OPENAI_WIRE_API),
    apiPath: OPENAI_API_PATH,
    thinkingMode: THINKING_MODE,
    thinkingEffort: THINKING_EFFORT,
    thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
    maxTokens: MAX_TOKENS,
    enableTools: ENABLE_TOOLS,
  };
}

function resolveModelRoute(requestedModel = "") {
  const routeConfig = MODEL_ROUTES[requestedModel] || MODEL_ROUTES["*"];
  const route = buildDefaultRoute(requestedModel);
  if (!routeConfig) return route;

  route.name = requestedModel && MODEL_ROUTES[requestedModel] ? requestedModel : "*";
  if (typeof routeConfig === "string") {
    route.model = routeConfig;
    return route;
  }

  if (typeof routeConfig !== "object") return route;
  route.baseUrl = stripTrailingSlash(routeConfig.baseUrl || routeConfig.openaiBaseUrl || route.baseUrl);
  route.apiKey = routeConfig.apiKey || routeConfig.openaiApiKey || route.apiKey;
  route.model = routeConfig.model || routeConfig.openaiModel || route.model;
  route.wireApi = normalizeWireApi(routeConfig.wireApi || routeConfig.openaiWireApi || route.wireApi);
  route.apiPath = String(routeConfig.apiPath || routeConfig.openaiApiPath || route.apiPath || "").trim();
  if (Object.prototype.hasOwnProperty.call(routeConfig, "thinkingMode") && routeConfig.thinkingMode !== "") {
    route.thinkingMode = normalizeThinkingMode(routeConfig.thinkingMode);
  }
  if (Object.prototype.hasOwnProperty.call(routeConfig, "thinkingEffort") && routeConfig.thinkingEffort !== "") {
    route.thinkingEffort = normalizeThinkingEffort(routeConfig.thinkingEffort);
  }
  if (Object.prototype.hasOwnProperty.call(routeConfig, "thinkingBudgetTokens") && Number(routeConfig.thinkingBudgetTokens) >= 0) {
    route.thinkingBudgetTokens = normalizeThinkingBudget(routeConfig.thinkingBudgetTokens, route.thinkingBudgetTokens);
  }
  route.maxTokens = Number(routeConfig.maxTokens ?? routeConfig.max_output_tokens ?? route.maxTokens);
  route.enableTools = normalizeBool(routeConfig.enableTools, route.enableTools);
  return route;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getRpcMethod(url) {
  const clean = String(url || "").split("?")[0];
  return clean.slice(clean.lastIndexOf("/") + 1);
}

function stripRoutePrefix(url) {
  return String(url || "").replace(/^\/_route\/api_server/, "");
}

function getUpstreamHost(url) {
  if (url.includes("unleash") || url.includes("experiment_config")) return REAL_UNLEASH_HOST;
  return REAL_API_HOST;
}

function rewriteProtoMessage(fields, patchField, patchValue) {
  const parts = [];
  for (const field of fields) {
    if (field.field === patchField && field.wireType === 2) {
      parts.push(writeStringField(patchField, patchValue));
    } else if (field.wireType === 0) {
      parts.push(writeVarintField(field.field, field.value));
    } else if (field.wireType === 1) {
      parts.push(writeFixed64Field(field.field, field.value));
    } else if (field.wireType === 2) {
      parts.push(writeBytesField(field.field, field.value));
    } else if (field.wireType === 5) {
      parts.push(writeFixed32Field(field.field, field.value));
    }
  }
  return Buffer.concat(parts);
}

function rewriteRegisterUserResponse(body) {
  if (body.length <= 5) return body;
  const flags = body[0];
  const length = body.readUInt32BE(1);
  if (length !== body.length - 5 || flags > 1) return body;

  let payload = body.subarray(5);
  if (flags === 1) {
    const unzipped = tryGunzip(payload);
    if (!unzipped) return body;
    payload = unzipped;
  }

  const fields = parseFields(payload);
  const localUrl = `http://localhost:${PORT}`;
  const rewritten = rewriteProtoMessage(fields, 3, localUrl);
  console.log(`RegisterUser api_server_url -> ${localUrl}`);
  return wrapEnvelope(rewritten, false);
}

function proxyToWindsurf(req, res, body) {
  return new Promise(resolve => {
    const method = getRpcMethod(req.url);
    const upstreamHost = getUpstreamHost(req.url || "");
    const upstreamPath = stripRoutePrefix(req.url || "/");
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers.host;
    delete headers["content-length"];
    headers.host = upstreamHost;
    headers["content-length"] = body.length;

    const upstream = https.request({
      hostname: upstreamHost,
      port: 443,
      path: upstreamPath,
      method: req.method,
      headers,
    }, upstreamRes => {
      const chunks = [];
      upstreamRes.on("data", chunk => chunks.push(chunk));
      upstreamRes.on("end", () => {
        let responseBody = Buffer.concat(chunks);
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders.connection;
        delete responseHeaders["content-length"];

        if (method === "RegisterUser" && upstreamRes.statusCode === 200) {
          try {
            responseBody = rewriteRegisterUserResponse(responseBody);
          } catch (error) {
            console.error(`RegisterUser rewrite failed: ${error.message}`);
          }
        }

        responseHeaders["content-length"] = responseBody.length;
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        res.end(responseBody);
        res.off("close", onClientClose);
        resolve();
      });
    });

    upstream.setTimeout(WINDSURF_PROXY_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`Windsurf upstream ${WINDSURF_PROXY_TIMEOUT_MS / 1000} 秒没有响应`));
    });
    const onClientClose = () => {
      if (!res.writableEnded) upstream.destroy(new Error("client disconnected"));
    };
    res.on("close", onClientClose);
    upstream.on("error", error => {
      console.error(`Upstream Windsurf error: ${error.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Upstream Windsurf error: ${error.message}`);
      res.off("close", onClientClose);
      resolve();
    });
    upstream.end(body);
  });
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part) return "";
    if (part.type === "text") return part.text || "";
    if (part.type === "tool_result") {
      const value = typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
      return value;
    }
    if (part.type === "image") return "[image omitted]";
    return "";
  }).filter(Boolean).join("\n");
}

function toOpenAiMessages(systemPrompt, messages) {
  const out = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (const message of messages || []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      out.push({ role, content: message.content });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    if (role === "assistant") {
      const text = blocks.filter(part => part.type === "text").map(part => part.text || "").join("\n");
      const reasoningContent = blocks.filter(part => part.type === "thinking").map(part => part.thinking || "").join("\n");
      const toolCalls = blocks.filter(part => part.type === "tool_use").map(part => ({
        id: part.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    const userText = blocks.filter(part => part.type === "text" || part.type === "image").map(part => contentToText([part])).filter(Boolean).join("\n");
    if (userText) out.push({ role: "user", content: userText });
    for (const part of blocks.filter(part => part.type === "tool_result")) {
      out.push({
        role: "tool",
        tool_call_id: part.tool_use_id || "",
        content: contentToText([part]),
      });
    }
  }

  return out.filter(message => message.role !== "tool" || message.tool_call_id);
}

function toOpenAiTools(tools, enableTools = ENABLE_TOOLS) {
  if (!enableTools) return undefined;
  const converted = (tools || []).filter(tool => tool?.name).map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));
  return converted.length ? converted : undefined;
}

function toResponsesTools(tools, enableTools = ENABLE_TOOLS) {
  if (!enableTools) return undefined;
  const converted = (tools || []).filter(tool => tool?.name).map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: tool.input_schema || { type: "object", properties: {} },
  }));
  return converted.length ? converted : undefined;
}

function toOpenAiToolChoice(toolChoice, enableTools = ENABLE_TOOLS) {
  if (!enableTools || !toolChoice) return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function toResponsesInput(systemPrompt, messages) {
  const out = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (const message of messages || []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      out.push({ role, content: message.content });
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    if (role === "assistant") {
      const text = blocks.filter(part => part.type === "text").map(part => part.text || "").join("\n");
      if (text) out.push({ role: "assistant", content: text });
      for (const part of blocks.filter(part => part.type === "tool_use" && part.name)) {
        out.push({
          type: "function_call",
          call_id: part.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
      }
      continue;
    }

    const userText = blocks.filter(part => part.type === "text" || part.type === "image").map(part => contentToText([part])).filter(Boolean).join("\n");
    if (userText) out.push({ role: "user", content: userText });
    for (const part of blocks.filter(part => part.type === "tool_result")) {
      out.push({
        type: "function_call_output",
        call_id: part.tool_use_id || "",
        output: contentToText([part]),
      });
    }
  }

  return out.filter(item => item.type !== "function_call_output" || item.call_id);
}

function baseUrlHasVersionPath(baseUrl = OPENAI_BASE_URL) {
  try {
    const pathname = new URL(baseUrl).pathname.replace(/\/+$/, "");
    return /\/v\d+$/i.test(pathname);
  } catch {
    return false;
  }
}

function upstreamEndpoint(route = buildDefaultRoute()) {
  if (/^https?:\/\//i.test(route.apiPath)) return route.apiPath;
  const defaultLeaf = route.wireApi === "responses"
    ? "responses"
    : (route.wireApi === "anthropic" ? "messages" : "chat/completions");
  const defaultPath = baseUrlHasVersionPath(route.baseUrl) ? `/${defaultLeaf}` : `/v1/${defaultLeaf}`;
  const selectedPath = route.apiPath || defaultPath;
  const path = selectedPath.startsWith("/") ? selectedPath : `/${selectedPath}`;
  return `${route.baseUrl}${path}`;
}

function upstreamKindLabel(route) {
  return route.wireApi === "anthropic" ? "Anthropic-compatible" : "OpenAI-compatible";
}

function anthropicEffort(route) {
  return ["low", "medium", "high", "xhigh", "max"].includes(route.thinkingEffort)
    ? route.thinkingEffort
    : "";
}

function anthropicThinking(route, maxTokens) {
  const output = {
    maxTokens: maxTokens > 0 ? maxTokens : 8192,
    thinking: undefined,
  };
  if (route.thinkingMode === "disabled") {
    output.thinking = { type: "disabled" };
  } else if (route.thinkingMode === "adaptive") {
    output.thinking = { type: "adaptive" };
  } else if (route.thinkingMode === "enabled") {
    let budget = Number(route.thinkingBudgetTokens || 0);
    if (budget <= 0) budget = Math.min(4096, Math.max(1024, output.maxTokens - 1));
    if (budget >= output.maxTokens) output.maxTokens = budget + 1024;
    output.thinking = { type: "enabled", budget_tokens: budget };
  }
  return output;
}

function anthropicPayload(parsed, model, route, maxTokens) {
  const thinking = anthropicThinking(route, maxTokens);
  const effort = anthropicEffort(route);
  let toolChoice = route.enableTools ? parsed.toolChoice : undefined;
  if (thinking.thinking && (toolChoice?.type === "any" || toolChoice?.type === "tool")) {
    toolChoice = { type: "auto" };
  }
  return {
    model,
    messages: parsed.messages || [],
    stream: true,
    max_tokens: thinking.maxTokens,
    ...(parsed.systemPrompt ? { system: parsed.systemPrompt } : {}),
    ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    ...(route.enableTools && parsed.tools?.length ? { tools: parsed.tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function responsesReasoning(route) {
  const effort = route.thinkingMode === "disabled"
    ? "none"
    : route.thinkingEffort;
  return effort && effort !== "default" ? { effort } : undefined;
}

function openAiChatThinking(route) {
  const fields = {};
  if (route.thinkingEffort && route.thinkingEffort !== "default") {
    fields.reasoning_effort = route.thinkingEffort;
  }
  if (route.thinkingMode === "disabled") {
    fields.thinking = { type: "disabled" };
  } else if (route.thinkingMode === "enabled" || route.thinkingMode === "adaptive") {
    fields.thinking = { type: "enabled" };
  }
  return fields;
}

function hasThinkingPayload(payload) {
  return Boolean(
    payload &&
    (payload.thinking || payload.output_config || payload.reasoning || payload.reasoning_effort)
  );
}

function stripThinkingPayload(payload) {
  const copy = JSON.parse(JSON.stringify(payload || {}));
  delete copy.thinking;
  delete copy.output_config;
  delete copy.reasoning;
  delete copy.reasoning_effort;
  return copy;
}

function shouldRetryWithoutThinking(status, text, payload) {
  if (!hasThinkingPayload(payload)) return false;
  if (![400, 422].includes(Number(status))) return false;
  const message = String(text || "").toLowerCase();
  if (!message) return true;
  return [
    "thinking",
    "reasoning",
    "reasoning_effort",
    "output_config",
    "effort",
    "budget_tokens",
    "unknown parameter",
    "unknown field",
    "unrecognized",
    "unsupported",
    "not supported",
    "invalid field",
    "extra inputs",
    "不支持",
    "未知",
    "无效",
  ].some(pattern => message.includes(pattern));
}

function setLastRequest(status, model, wireApi) {
  lastRequestStatus = {
    status,
    model: model || "",
    wireApi: wireApi || "",
    at: new Date().toISOString(),
  };
}

function upstreamHeaders(route) {
  const headers = {
    "content-type": "application/json",
    "accept": "text/event-stream",
  };
  if (route.wireApi === "anthropic") {
    headers["x-api-key"] = route.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["authorization"] = `Bearer ${route.apiKey}`;
  }
  return headers;
}

function parseSseEvents(buffer) {
  const events = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() || "";
  for (const block of blocks) {
    const dataLines = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
    for (const payload of dataLines) {
      if (!payload) continue;
      if (payload === "[DONE]") {
        events.push({ done: true });
        continue;
      }
      try {
        events.push({ done: false, data: JSON.parse(payload) });
      } catch {
        // ignore malformed SSE fragments
      }
    }
  }
  return { events, rest };
}

function finishReasonToProto(reason, hasToolCalls) {
  if (hasToolCalls || reason === "tool_calls" || reason === "function_call" || reason === "tool_use") return STOP_REASON.FUNCTION_CALL;
  if (reason === "length" || reason === "max_tokens") return STOP_REASON.MAX_TOKENS;
  if (reason === "error") return STOP_REASON.ERROR;
  return STOP_REASON.STOP_PATTERN;
}

async function handleGetChatMessage(req, res, body) {
  const requestId = `cascade_${crypto.randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const parsed = parseGetChatMessageRequest(body, req.headers);
  const route = resolveModelRoute(parsed.requestedModel || "");
  const resolvedModel = route.model || (parsed.requestedModel && !parsed.requestedModel.startsWith("MODEL_") ? parsed.requestedModel : "deepseek-chat");
  const messageId = `native_${crypto.randomUUID()}`;
  const useAnthropic = route.wireApi === "anthropic";
  const useResponses = route.wireApi === "responses";
  const maxTokens = Number(route.maxTokens || 0);
  const tools = useAnthropic
    ? (route.enableTools ? parsed.tools : undefined)
    : (useResponses ? toResponsesTools(parsed.tools, route.enableTools) : toOpenAiTools(parsed.tools, route.enableTools));
  const toolChoice = useAnthropic ? parsed.toolChoice : toOpenAiToolChoice(parsed.toolChoice, route.enableTools);

  const payload = useAnthropic
    ? anthropicPayload(parsed, resolvedModel, route, maxTokens)
    : useResponses
    ? {
        model: resolvedModel,
        input: toResponsesInput(parsed.systemPrompt, parsed.messages),
        stream: true,
        ...(maxTokens > 0 ? { max_output_tokens: maxTokens } : {}),
        ...(responsesReasoning(route) ? { reasoning: responsesReasoning(route) } : {}),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      }
    : {
        model: resolvedModel,
        messages: toOpenAiMessages(parsed.systemPrompt, parsed.messages),
        stream: true,
        ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
        ...openAiChatThinking(route),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      };

  const inputCount = useResponses ? payload.input.length : payload.messages.length;
  const endpoint = upstreamEndpoint(route);
  const rawRequest = LOG_FULL_UPSTREAM_TRAFFIC ? JSON.stringify({
    method: "POST",
    endpoint,
    windsurfModelId: parsed.requestedModel || "",
    resolvedModel,
    wireApi: route.wireApi,
    payload,
  }, null, 2) : "";
  let rawResponse = "";
  let degraded = false;
  const captureResponse = value => {
    if (!LOG_FULL_UPSTREAM_TRAFFIC) return;
    rawResponse += `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
  };
  const writeRequestLog = (level, status, extra = {}) => {
    const latencyMs = Date.now() - startedAt;
    const summary = `Cascade ${status}：${parsed.requestedModel || "(none)"} -> ${resolvedModel}，${latencyMs} ms`;
    emitLogEntry({
      level,
      source: "proxy",
      operation: "cascade_request",
      requestId,
      message: summary,
      summary,
      detail: {
        status,
        latencyMs,
        windsurfModelId: parsed.requestedModel || "",
        route: route.name,
        endpoint,
        wireApi: route.wireApi,
        requestedModel: parsed.requestedModel || "",
        resolvedModel,
        inputCount,
        tools: tools?.length || 0,
        thinkingMode: route.thinkingMode,
        thinkingEffort: route.thinkingEffort,
        thinkingBudgetTokens: route.thinkingBudgetTokens,
        degraded,
        ...extra,
      },
      rawRequest,
      rawResponse,
    });
  };
  console.log(`GetChatMessage ${parsed.requestedModel || "(none)"} -> ${resolvedModel}; route=${route.name}; wire=${route.wireApi}; endpoint=${endpoint}; input=${inputCount}; tools=${tools?.length || 0}; thinking=${route.thinkingMode}/${route.thinkingEffort}/${route.thinkingBudgetTokens}`);
  setLastRequest("进行中", resolvedModel, route.wireApi);
  res.writeHead(200, streamHeaders());

  const abort = new AbortController();
  let timeoutReason = "";
  let upstreamTimer = null;
  const abortUpstream = reason => {
    if (abort.signal.aborted) return;
    timeoutReason = reason;
    abort.abort(new Error(reason));
  };
  const resetUpstreamTimer = () => {
    if (upstreamTimer) clearTimeout(upstreamTimer);
    upstreamTimer = setTimeout(() => {
      abortUpstream(`上游 ${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒没有返回数据`);
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    upstreamTimer.unref?.();
  };
  const onClientClose = () => {
    if (!res.writableEnded) abortUpstream("client disconnected");
  };
  res.on("close", onClientClose);
  resetUpstreamTimer();

  try {
    let requestPayload = payload;
    let upstream = await fetch(endpoint, {
      method: "POST",
      headers: upstreamHeaders(route),
      body: JSON.stringify(requestPayload),
      signal: abort.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      captureResponse(text);
      if (shouldRetryWithoutThinking(upstream.status, text, requestPayload)) {
        const fallbackPayload = stripThinkingPayload(requestPayload);
        console.warn(`Upstream rejected thinking parameters (${upstream.status}); retrying without thinking settings.`);
        upstream = await fetch(endpoint, {
          method: "POST",
          headers: upstreamHeaders(route),
          body: JSON.stringify(fallbackPayload),
          signal: abort.signal,
        });
        if (upstream.ok) {
          requestPayload = fallbackPayload;
          setLastRequest("成功（已降级）", resolvedModel, route.wireApi);
          console.warn("Retry without thinking settings succeeded.");
          degraded = true;
        } else {
          const retryText = await upstream.text();
          captureResponse(retryText);
          setLastRequest(`失败 HTTP ${upstream.status}`, resolvedModel, route.wireApi);
          res.write(wrapEnvelope(buildErrorChunk(messageId, `${upstreamKindLabel(route)} upstream HTTP ${upstream.status}: ${retryText.slice(0, 1200)}\n\nOriginal thinking-parameter error ${text.slice(0, 800)}`)));
          res.write(endOfStreamEnvelope());
          res.end();
          writeRequestLog("error", `失败 HTTP ${upstream.status}`, { upstreamStatus: upstream.status, error: retryText.slice(0, 1200) });
          return;
        }
      } else {
        setLastRequest(`失败 HTTP ${upstream.status}`, resolvedModel, route.wireApi);
        res.write(wrapEnvelope(buildErrorChunk(messageId, `${upstreamKindLabel(route)} upstream HTTP ${upstream.status}: ${text.slice(0, 1200)}`)));
        res.write(endOfStreamEnvelope());
        res.end();
        writeRequestLog("error", `失败 HTTP ${upstream.status}`, { upstreamStatus: upstream.status, error: text.slice(0, 1200) });
        return;
      }
    }

    let tokenCount = 0;
    let sseBuffer = "";
    let finishReason = "stop";
    const toolCalls = new Map();
    let upstreamComplete = false;

    for await (const chunk of upstream.body) {
      resetUpstreamTimer();
      sseBuffer += Buffer.from(chunk).toString("utf8");
      const parsedEvents = parseSseEvents(sseBuffer);
      sseBuffer = parsedEvents.rest;

      for (const event of parsedEvents.events) {
        if (!event.done) captureResponse(event.data || {});
        if (event.done) {
          upstreamComplete = true;
          break;
        }
        if (useAnthropic) {
          const data = event.data || {};
          if (data.type === "error") {
            finishReason = "error";
            const errorText = data.error?.message || data.message || JSON.stringify(data);
            res.write(wrapEnvelope(buildErrorChunk(messageId, `Anthropic-compatible upstream error: ${errorText.slice(0, 1200)}`)));
            continue;
          }

          if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
            const index = Number.isInteger(data.index) ? data.index : toolCalls.size;
            const input = data.content_block.input && Object.keys(data.content_block.input).length
              ? JSON.stringify(data.content_block.input)
              : "";
            toolCalls.set(index, {
              id: data.content_block.id || "",
              name: data.content_block.name || "",
              arguments: input,
            });
            continue;
          }

          if (data.type === "content_block_delta") {
            const delta = data.delta || {};
            if (delta.type === "text_delta" && delta.text) {
              tokenCount += 1;
              res.write(wrapEnvelope(buildTextDelta(messageId, delta.text, tokenCount)));
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              res.write(wrapEnvelope(buildThinkingDelta(messageId, delta.thinking)));
            } else if (delta.type === "signature_delta" && delta.signature) {
              res.write(wrapEnvelope(buildSignatureDelta(messageId, delta.signature)));
            } else if (delta.type === "input_json_delta") {
              const index = Number.isInteger(data.index) ? data.index : 0;
              const current = toolCalls.get(index) || { id: "", name: "", arguments: "" };
              current.arguments += delta.partial_json || "";
              toolCalls.set(index, current);
            }
            continue;
          }

          if (data.type === "message_delta" && data.delta?.stop_reason) {
            finishReason = data.delta.stop_reason;
          }
          if (data.type === "message_stop") {
            upstreamComplete = true;
            break;
          }
        } else if (useResponses) {
          const data = event.data || {};
          if (data.type === "error" || data.type === "response.failed") {
            finishReason = "error";
            const errorText = data.error?.message || data.message || JSON.stringify(data);
            res.write(wrapEnvelope(buildErrorChunk(messageId, `OpenAI-compatible upstream error: ${errorText.slice(0, 1200)}`)));
            continue;
          }

          if (data.type === "response.completed") {
            finishReason = "stop";
            upstreamComplete = true;
          }
          if (data.type === "response.incomplete") {
            finishReason = "length";
            upstreamComplete = true;
          }

          const textDelta = data.type === "response.output_text.delta" ? data.delta || "" : "";
          if (textDelta) {
            tokenCount += 1;
            res.write(wrapEnvelope(buildTextDelta(messageId, textDelta, tokenCount)));
          }
          const reasoningDelta =
            data.type === "response.reasoning_summary_text.delta" || data.type === "response.reasoning_text.delta"
              ? data.delta || ""
              : "";
          if (reasoningDelta) {
            res.write(wrapEnvelope(buildThinkingDelta(messageId, reasoningDelta)));
          }

          if ((data.type === "response.output_item.added" || data.type === "response.output_item.done") && data.item?.type === "function_call") {
            const index = Number.isInteger(data.output_index) ? data.output_index : toolCalls.size;
            const current = toolCalls.get(index) || { id: "", name: "", arguments: "" };
            current.id = data.item.call_id || data.item.id || current.id;
            current.name = data.item.name || current.name;
            if (data.item.arguments) current.arguments = data.item.arguments;
            toolCalls.set(index, current);
          }

          if (data.type === "response.function_call_arguments.delta") {
            const index = Number.isInteger(data.output_index) ? data.output_index : 0;
            const current = toolCalls.get(index) || { id: data.item_id || "", name: "", arguments: "" };
            current.id = current.id || data.item_id || "";
            current.arguments += data.delta || "";
            toolCalls.set(index, current);
          }

          if (data.type === "response.function_call_arguments.done") {
            const index = Number.isInteger(data.output_index) ? data.output_index : 0;
            const current = toolCalls.get(index) || { id: data.item_id || "", name: "", arguments: "" };
            current.id = current.id || data.item_id || "";
            current.name = data.name || current.name;
            if (data.arguments) current.arguments = data.arguments;
            toolCalls.set(index, current);
          }
          if (upstreamComplete) break;
        } else {
          const choice = event.data?.choices?.[0] || {};
          const delta = choice.delta || {};
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const reasoningDelta = delta.reasoning_content || "";
          if (reasoningDelta) {
            res.write(wrapEnvelope(buildThinkingDelta(messageId, reasoningDelta)));
          }

          const textDelta = delta.content || "";
          if (textDelta) {
            tokenCount += 1;
            res.write(wrapEnvelope(buildTextDelta(messageId, textDelta, tokenCount)));
          }

          for (const tc of delta.tool_calls || []) {
            const index = Number.isInteger(tc.index) ? tc.index : 0;
            const current = toolCalls.get(index) || { id: "", name: "", arguments: "" };
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name += tc.function.name;
            if (tc.function?.arguments) current.arguments += tc.function.arguments;
            toolCalls.set(index, current);
          }
        }
      }
      if (upstreamComplete) break;
    }

    const finalToolCalls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call], index) => ({
        id: call.id || `call_${index}`,
        name: call.name,
        arguments_json: call.arguments || "{}",
      }))
      .filter(call => call.name);

    if (finalToolCalls.length) {
      res.write(wrapEnvelope(buildToolCallDelta(messageId, finalToolCalls)));
    }

    res.write(wrapEnvelope(buildStopChunk(messageId, finishReasonToProto(finishReason, finalToolCalls.length > 0), resolvedModel)));
    res.write(endOfStreamEnvelope());
    res.end();
    if (lastRequestStatus.status === "进行中") setLastRequest("成功", resolvedModel, route.wireApi);
    writeRequestLog(finishReason === "error" ? "error" : "info", finishReason === "error" ? "失败" : degraded ? "成功（已降级）" : "成功", { finishReason, tokenCount });
  } catch (error) {
    const message = timeoutReason || (error?.name === "AbortError" ? "client disconnected" : (error?.message || String(error)));
    const timeout = Boolean(timeoutReason && timeoutReason !== "client disconnected");
    setLastRequest(error?.name === "AbortError" && !timeout ? "已取消" : timeout ? "上游超时" : "失败", resolvedModel, route.wireApi);
    if (timeout) console.warn(`Upstream timeout: ${message}`);
    if (!res.writableEnded) {
      res.write(wrapEnvelope(buildErrorChunk(messageId, `Native proxy error: ${message}`)));
      res.write(endOfStreamEnvelope());
      res.end();
    }
    writeRequestLog(timeout ? "warn" : "error", timeout ? "上游超时" : "失败", { error: message });
  } finally {
    if (upstreamTimer) clearTimeout(upstreamTimer);
    res.off("close", onClientClose);
  }
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    let localHost;
    try {
      localHost = new URL(`http://${req.headers.host || ""}`);
    } catch {
      // A missing or malformed Host is not a trusted local address.
    }
    if (!localHost || !["localhost", "127.0.0.1", "[::1]"].includes(localHost.hostname.toLowerCase())) {
      jsonResponse(res, 403, { error: "仅接受本机地址的请求" });
      return;
    }
    if (req.headers.origin) {
      let trustedOrigin = false;
      try {
        const origin = new URL(req.headers.origin);
        trustedOrigin = ["vscode-file:", "vscode-webview:", "tauri:"].includes(origin.protocol)
          || (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname.toLowerCase()) && Number(origin.port || 80) === PORT);
      } catch {
        // Opaque browser origins are not trusted native clients.
      }
      if (!trustedOrigin) {
        jsonResponse(res, 403, { error: "跨站请求已被拒绝，请通过原生客户端连接" });
        return;
      }
    }
    const url = new URL(req.url || "/", localHost);

    if (req.method === "GET" && url.pathname === "/health") {
      const defaultRoute = buildDefaultRoute();
      jsonResponse(res, 200, {
        ok: true,
        native_cascade_adapter: true,
        instance_id: INSTANCE_ID,
        pid: process.pid,
        port: PORT,
        upstream: upstreamEndpoint(defaultRoute),
        wire_api: defaultRoute.wireApi,
        model: defaultRoute.model || null,
        thinking_mode: defaultRoute.thinkingMode,
        thinking_effort: defaultRoute.thinkingEffort,
        thinking_budget_tokens: defaultRoute.thinkingBudgetTokens,
        last_request_status: lastRequestStatus.status,
        last_request_model: lastRequestStatus.model,
        last_request_wire_api: lastRequestStatus.wireApi,
        last_request_at: lastRequestStatus.at,
        model_routes: Object.keys(MODEL_ROUTES),
        tools: ENABLE_TOOLS,
      });
      return;
    }

    if (url.pathname.startsWith("/control/")) {
      if (req.headers["x-control-token"] !== CONTROL_TOKEN) {
        jsonResponse(res, 403, { ok: false, error: "forbidden" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/control/reload") {
        applyRuntimeConfig(toRuntimeConfig(readConfig(CONFIG_PATH)));
        jsonResponse(res, 200, { ok: true, reloaded: true });
        emitEvent("config-reloaded", { routes: Object.keys(MODEL_ROUTES).length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/control/shutdown") {
        jsonResponse(res, 200, { ok: true, shuttingDown: true });
        setTimeout(() => shutdown("control"), 20);
        return;
      }
      jsonResponse(res, 404, { ok: false, error: "unknown control command" });
      return;
    }

    if (url.pathname.startsWith("/profile") || url.pathname.startsWith("/login") || url.pathname.startsWith("/signup") || url.pathname.startsWith("/redirect/")) {
      redirect(res, `https://${REAL_WEBSITE_HOST}${req.url}`);
      return;
    }
    if (url.search.includes("client_id=codeium") || url.search.includes("scope=openid") || url.pathname.includes("authorize")) {
      redirect(res, `https://${REAL_REGISTER_HOST}${req.url}`);
      return;
    }

    const body = await readRaw(req);
    const method = getRpcMethod(url.pathname);
    if (method === "GetChatMessage") {
      await handleGetChatMessage(req, res, body);
      return;
    }

    console.log(`${req.method} ${url.pathname} -> Windsurf (${body.length}b)`);
    await proxyToWindsurf(req, res, body);
  } catch (error) {
    console.error(error?.stack || error);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: error?.message || String(error) });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  emitEvent("proxy-ready", {
    instanceId: INSTANCE_ID,
    pid: process.pid,
    port: PORT,
    controlTokenRequired: true
  });
  console.log(`Windsurf native Cascade proxy on http://127.0.0.1:${PORT}`);
  const defaultRoute = buildDefaultRoute();
  console.log(`${upstreamKindLabel(defaultRoute)} endpoint: ${upstreamEndpoint(defaultRoute)}`);
  console.log(`Wire API: ${defaultRoute.wireApi}`);
  console.log(`Model override: ${defaultRoute.model || "(use client model)"}`);
  console.log(`Thinking: mode=${defaultRoute.thinkingMode}; effort=${defaultRoute.thinkingEffort}; budget=${defaultRoute.thinkingBudgetTokens}`);
  console.log(`Model routes: ${Object.keys(MODEL_ROUTES).length || 0}`);
});

fs.watchFile(CONFIG_PATH, { interval: 1000 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) return;
  try {
    applyRuntimeConfig(toRuntimeConfig(readConfig(CONFIG_PATH)));
    emitEvent("config-reloaded", {
      routes: Object.keys(MODEL_ROUTES).length,
      model: OPENAI_MODEL,
      wireApi: OPENAI_WIRE_API
    });
  } catch (error) {
    console.error(`Reload config failed: ${error?.message || error}`);
  }
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  fs.unwatchFile(CONFIG_PATH);
  emitEvent("proxy-stopping", { reason });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
