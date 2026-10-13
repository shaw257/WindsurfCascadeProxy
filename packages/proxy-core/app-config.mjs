import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SCHEMA_VERSION = 1;

export function defaultConfig() {
  const connectionId = crypto.randomUUID();
  return {
    schemaVersion: SCHEMA_VERSION,
    onboardingCompleted: false,
    connections: [
      {
        id: connectionId,
        name: "自定义连接",
        providerTemplate: "custom",
        baseUrl: "",
        apiKey: "",
        wireApi: "chat",
        defaultModel: "",
        fetchedModels: [],
        modelsFetchedAt: "",
        thinkingMode: "default",
        thinkingEffort: "default",
        thinkingBudgetTokens: 0
      }
    ],
    routes: [],
    runtime: {
      defaultConnectionId: connectionId,
      nodePath: "",
      windsurfPath: "",
      port: 3009,
      launchWindsurfOnStart: true,
      closeBehavior: "ask",
      logFullUpstreamTraffic: false,
      minimizeToTrayOnClose: true
    }
  };
}

export function readConfig(configPath) {
  const fallback = defaultConfig();
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("配置文件格式无效。");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("不支持的配置版本。");
  }
  return normalizeConfig(raw, fallback);
}

export function normalizeConfig(value, fallback = defaultConfig()) {
  if (!value || typeof value !== "object") return fallback;
  if (!Array.isArray(value.connections)) return fromLegacyConfig(value, fallback);

  const connections = value.connections
    .filter(item => item && typeof item === "object")
    .map(normalizeConnection)
    .filter(item => item.id);
  if (!connections.length) connections.push(...fallback.connections);

  const routes = Array.isArray(value.routes)
    ? value.routes.map(normalizeRoute).filter(item => item.windsurfModelId)
    : [];
  const runtime = normalizeRuntime({
    ...fallback.runtime,
    ...(value.runtime && typeof value.runtime === "object" ? value.runtime : {})
  }, fallback.runtime);
  if (!connections.some(item => item.id === runtime.defaultConnectionId)) {
    runtime.defaultConnectionId = connections[0].id;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    onboardingCompleted: Boolean(value.onboardingCompleted),
    connections,
    routes,
    runtime
  };
}

export function normalizeConnection(value) {
  return {
    id: String(value.id || crypto.randomUUID()),
    name: String(value.name || "未命名连接"),
    providerTemplate: String(value.providerTemplate || "custom"),
    baseUrl: stripTrailingSlash(value.baseUrl || value.openaiBaseUrl || ""),
    apiKey: String(value.apiKey || value.openaiApiKey || ""),
    wireApi: normalizeWireApi(value.wireApi || value.openaiWireApi),
    defaultModel: String(value.defaultModel || value.model || value.openaiModel || ""),
    fetchedModels: Array.isArray(value.fetchedModels) ? [...new Set(value.fetchedModels.filter(Boolean).map(String))].sort() : [],
    modelsFetchedAt: String(value.modelsFetchedAt || ""),
    thinkingMode: normalizeThinkingMode(value.thinkingMode),
    thinkingEffort: normalizeThinkingEffort(value.thinkingEffort),
    thinkingBudgetTokens: normalizeBudget(value.thinkingBudgetTokens, 0)
  };
}

export function normalizeRoute(value) {
  return {
    id: String(value.id || crypto.randomUUID()),
    windsurfModelId: String(value.windsurfModelId || value.windsurfModel || ""),
    connectionId: String(value.connectionId || ""),
    model: String(value.model || ""),
    thinkingMode: normalizeOptionalThinkingMode(value.thinkingMode),
    thinkingEffort: normalizeOptionalThinkingEffort(value.thinkingEffort),
    thinkingBudgetTokens: value.thinkingBudgetTokens === "" || value.thinkingBudgetTokens == null
      ? null
      : normalizeBudget(value.thinkingBudgetTokens, null)
  };
}

export function resolveConnection(config, connectionId = "") {
  const selectedId = connectionId || config.runtime.defaultConnectionId;
  return config.connections.find(item => item.id === selectedId) || config.connections[0] || null;
}

export function resolveRoute(config, windsurfModelId = "") {
  const route = config.routes.find(item => item.windsurfModelId === windsurfModelId)
    || config.routes.find(item => item.windsurfModelId === "*");
  const connection = resolveConnection(config, route?.connectionId);
  if (!connection) throw new Error("没有可用的上游连接。");
  return {
    name: route?.windsurfModelId || "default",
    windsurfModel: windsurfModelId,
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    model: route?.model || connection.defaultModel,
    wireApi: connection.wireApi,
    thinkingMode: route?.thinkingMode || connection.thinkingMode,
    thinkingEffort: route?.thinkingEffort || connection.thinkingEffort,
    thinkingBudgetTokens: route?.thinkingBudgetTokens ?? connection.thinkingBudgetTokens
  };
}

export function toRuntimeConfig(config) {
  const defaultRoute = resolveRoute(config);
  const modelRoutes = {};
  for (const item of config.routes) {
    const route = resolveRoute(config, item.windsurfModelId);
    modelRoutes[item.windsurfModelId] = {
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      wireApi: route.wireApi,
      thinkingMode: route.thinkingMode,
      thinkingEffort: route.thinkingEffort,
      thinkingBudgetTokens: route.thinkingBudgetTokens
    };
  }
  return {
    upstreamProvider: defaultRoute.wireApi === "anthropic" ? "anthropic-compatible" : "openai-compatible",
    openaiBaseUrl: defaultRoute.baseUrl,
    openaiApiKey: defaultRoute.apiKey,
    openaiModel: defaultRoute.model,
    openaiWireApi: defaultRoute.wireApi,
    thinkingMode: defaultRoute.thinkingMode,
    thinkingEffort: defaultRoute.thinkingEffort,
    thinkingBudgetTokens: defaultRoute.thinkingBudgetTokens,
    modelRoutes,
    windsurfPath: config.runtime.windsurfPath,
    port: config.runtime.port,
    logFullUpstreamTraffic: false
  };
}

export function redact(value, secrets = []) {
  let output = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) {
    output = output.split(secret).join("[REDACTED]");
    output = output.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
  }
  return output
    .replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/ig, "$1[REDACTED]")
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/ig, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

export function joinEndpoint(baseUrl, leaf) {
  const clean = stripTrailingSlash(baseUrl);
  const suffix = String(leaf || "").replace(/^\/+/, "");
  if (/\/v1$/i.test(clean)) return `${clean}/${suffix.replace(/^v1\//i, "")}`;
  return `${clean}/v1/${suffix.replace(/^v1\//i, "")}`;
}

function fromLegacyConfig(value, fallback) {
  const id = fallback.connections[0].id;
  return normalizeConfig({
    schemaVersion: SCHEMA_VERSION,
    onboardingCompleted: false,
    connections: [{
      id,
      name: "默认连接",
      baseUrl: value.openaiBaseUrl,
      apiKey: value.openaiApiKey,
      wireApi: value.openaiWireApi,
      defaultModel: value.openaiModel,
      thinkingMode: value.thinkingMode,
      thinkingEffort: value.thinkingEffort,
      thinkingBudgetTokens: value.thinkingBudgetTokens
    }],
    routes: Object.entries(value.modelRoutes || {}).map(([windsurfModelId, route]) => ({
      id: crypto.randomUUID(),
      windsurfModelId,
      connectionId: id,
      model: route.model || route.openaiModel || "",
      thinkingMode: route.thinkingMode || "",
      thinkingEffort: route.thinkingEffort || "",
      thinkingBudgetTokens: route.thinkingBudgetTokens
    })),
    runtime: {
      ...fallback.runtime,
      defaultConnectionId: id,
      windsurfPath: value.windsurfPath || "",
      port: Number(value.port || 3009),
      launchWindsurfOnStart: value.launchWindsurfOnStart !== false,
      closeBehavior: value.minimizeToTrayOnClose === false ? "ask" : "minimizeToTray",
      logFullUpstreamTraffic: false
    }
  }, fallback);
}

function normalizeRuntime(value, fallback) {
  const closeBehavior = normalizeCloseBehavior(value.closeBehavior)
    || (value.minimizeToTrayOnClose === false ? "ask" : value.minimizeToTrayOnClose === true ? "minimizeToTray" : fallback.closeBehavior);
  return {
    ...value,
    port: Number(value.port || fallback.port || 3009),
    launchWindsurfOnStart: value.launchWindsurfOnStart !== false,
    closeBehavior,
    logFullUpstreamTraffic: false,
    minimizeToTrayOnClose: closeBehavior === "minimizeToTray"
  };
}

function normalizeCloseBehavior(value) {
  const behavior = String(value || "");
  return ["ask", "minimizeToTray", "quitApp"].includes(behavior) ? behavior : "";
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function normalizeWireApi(value) {
  const wire = String(value || "chat").toLowerCase();
  if (wire === "responses") return "responses";
  if (["anthropic", "messages", "claude"].includes(wire)) return "anthropic";
  return "chat";
}

function normalizeThinkingMode(value) {
  const mode = String(value || "default").toLowerCase();
  return ["disabled", "adaptive", "enabled"].includes(mode) ? mode : "default";
}

function normalizeOptionalThinkingMode(value) {
  if (value === null || value === undefined || value === "") return "";
  return normalizeThinkingMode(value);
}

function normalizeThinkingEffort(value) {
  const effort = String(value || "default").toLowerCase();
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)
    ? effort
    : "default";
}

function normalizeOptionalThinkingEffort(value) {
  if (value === null || value === undefined || value === "") return "";
  return normalizeThinkingEffort(value);
}

function normalizeBudget(value, fallback) {
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget < 0) return fallback;
  return Math.min(Math.floor(budget), 1_000_000);
}

export function configDirectory(configPath) {
  return path.dirname(path.resolve(configPath));
}
