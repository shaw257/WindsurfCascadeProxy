import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig, EnvironmentReport, LogEntry, OperationResult, TestResult } from "./types";

const nativeApi = {
  loadConfig: () => invoke<AppConfig>("load_config"),
  saveConfig: (config: AppConfig) => invoke<OperationResult>("save_config", { config }),
  detectEnvironment: () => invoke<EnvironmentReport>("detect_environment"),
  preflight: () => invoke<OperationResult>("preflight"),
  startProxy: () => invoke<OperationResult>("start_proxy"),
  stopProxy: () => invoke<OperationResult>("stop_proxy"),
  openWindsurf: () => invoke<void>("open_windsurf"),
  hideWindow: () => invoke<void>("hide_main_window"),
  testConnection: (connectionId?: string, windsurfModelId?: string) =>
    invoke<TestResult>("test_connection", { connectionId, windsurfModelId }),
  fetchModels: (connectionId: string) => invoke<{ models: string[]; latencyMs: number }>("fetch_models", { connectionId }),
  checkPatch: () => invoke<EnvironmentReport["patch"]>("check_patch"),
  applyPatch: () => invoke<EnvironmentReport["patch"]>("apply_patch"),
  restorePatch: () => invoke<EnvironmentReport["patch"]>("restore_patch"),
  getLogs: () => invoke<LogEntry[]>("get_logs"),
  clearLogs: (deleteFiles: boolean) => invoke<void>("clear_logs", { deleteFiles }),
  exportDiagnostics: (destination: string) => invoke<string>("export_diagnostics", { destination }),
  quit: () => invoke<void>("app_quit"),
  onLog: (handler: (entry: LogEntry) => void): Promise<UnlistenFn> =>
    listen<LogEntry>("log-line", event => handler(event.payload)),
  onExitConfirmation: (handler: () => void): Promise<UnlistenFn> =>
    listen("request-exit-confirmation", handler),
  onProxyStateChanged: (handler: () => void): Promise<UnlistenFn> =>
    listen("proxy-state-changed", handler),
  onTrayError: (handler: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>("tray-operation-error", event => handler(event.payload))
};

const previewConfig: AppConfig = {
  schemaVersion: 1,
  onboardingCompleted: false,
  connections: [
    {
      id: "deepseek-default",
      name: "DeepSeek 官方",
      providerTemplate: "deepseek-openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      wireApi: "chat",
      defaultModel: "deepseek-chat",
      fetchedModels: ["deepseek-chat", "deepseek-reasoner"],
      modelsFetchedAt: new Date().toISOString(),
      thinkingMode: "default",
      thinkingEffort: "default",
      thinkingBudgetTokens: 0
    }
  ],
  routes: [
    {
      id: "sonnet",
      windsurfModelId: "MODEL_CLAUDE_4_SONNET_BYOK",
      connectionId: "deepseek-default",
      model: "deepseek-chat",
      thinkingMode: "",
      thinkingEffort: "",
      thinkingBudgetTokens: null
    }
  ],
  runtime: {
    defaultConnectionId: "deepseek-default",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    windsurfPath: "D:\\Software\\Windsurf\\Windsurf.exe",
    port: 3009,
    launchWindsurfOnStart: true,
    closeBehavior: "ask",
    logFullUpstreamTraffic: false,
    minimizeToTrayOnClose: true
  }
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let browserConfig = clone(previewConfig);
let browserRunning = false;

const browserApi = {
  loadConfig: async () => clone(browserConfig),
  saveConfig: async (config: AppConfig): Promise<OperationResult> => {
    browserConfig = clone(config);
    return { ok: true, summary: "配置已保存（浏览器预览）", detail: {} };
  },
  detectEnvironment: async (): Promise<EnvironmentReport> => ({
    appVersion: "0.2.0-preview",
    platform: "browser",
    architecture: "x64",
    node: {
      found: true,
      path: browserConfig.runtime.nodePath,
      version: "24.15.0",
      supported: true,
      detail: "Node.js 版本符合要求"
    },
    windsurfFound: true,
    windsurfPath: browserConfig.runtime.windsurfPath,
    portAvailable: true,
    proxyRunning: browserRunning,
    proxyPid: browserRunning ? 12345 : undefined,
    configPath: "浏览器预览/config.json",
    dataDirectory: "浏览器预览",
    patch: {
      ok: true,
      build: { version: "1.110.1", known: true },
      patches: [
        { name: "api server context url", status: "applied" },
        { name: "restart url", status: "applied" }
      ]
    }
  }),
  preflight: async (): Promise<OperationResult> => ({ ok: true, summary: "启动条件已满足", detail: {} }),
  startProxy: async (): Promise<OperationResult> => {
    browserRunning = true;
    return { ok: true, summary: "代理已启动（浏览器预览）", detail: { port: browserConfig.runtime.port } };
  },
  stopProxy: async (): Promise<OperationResult> => {
    browserRunning = false;
    return { ok: true, summary: "代理已停止（浏览器预览）", detail: {} };
  },
  openWindsurf: async () => undefined,
  hideWindow: async () => undefined,
  testConnection: async (): Promise<TestResult> => ({
    ok: true,
    requestModel: browserConfig.connections[0]?.defaultModel || "",
    returnedModel: browserConfig.connections[0]?.defaultModel || "",
    wireApi: browserConfig.connections[0]?.wireApi || "chat",
    latencyMs: 286,
    responseText: "pong",
    status: 200,
    thinkingEffort: browserConfig.connections[0]?.thinkingEffort || "default",
    degraded: false,
    raw: "{}",
    requestId: "preview-test",
    rawRequest: "{\"input\":\"Reply with exactly: pong\"}",
    rawResponse: "{}"
  }),
  fetchModels: async () => ({ models: ["deepseek-chat", "deepseek-reasoner"], latencyMs: 173 }),
  checkPatch: async () => (await browserApi.detectEnvironment()).patch,
  applyPatch: async () => (await browserApi.detectEnvironment()).patch,
  restorePatch: async () => ({ ok: true, patches: [] }),
  getLogs: async (): Promise<LogEntry[]> => [
    { at: new Date().toISOString(), level: "info", source: "app", message: "浏览器预览已就绪。" }
  ],
  clearLogs: async () => undefined,
  exportDiagnostics: async (destination: string) => destination,
  quit: async () => undefined,
  onLog: async () => (() => undefined) as UnlistenFn,
  onExitConfirmation: async () => (() => undefined) as UnlistenFn,
  onProxyStateChanged: async () => (() => undefined) as UnlistenFn,
  onTrayError: async () => (() => undefined) as UnlistenFn
};

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const api = isTauri ? nativeApi : browserApi;
