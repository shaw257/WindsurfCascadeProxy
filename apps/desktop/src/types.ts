export type WireApi = "chat" | "responses" | "anthropic";
export type ThinkingMode = "default" | "disabled" | "adaptive" | "enabled";
export type ThinkingEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ConnectionProfile {
  id: string;
  name: string;
  providerTemplate: string;
  baseUrl: string;
  apiKey: string;
  wireApi: WireApi;
  defaultModel: string;
  fetchedModels: string[];
  modelsFetchedAt?: string | null;
  thinkingMode: ThinkingMode;
  thinkingEffort: ThinkingEffort;
  thinkingBudgetTokens: number;
}

export interface ModelRoute {
  id: string;
  windsurfModelId: string;
  connectionId: string;
  model: string;
  thinkingMode: "" | ThinkingMode;
  thinkingEffort: "" | ThinkingEffort;
  thinkingBudgetTokens: number | null;
}

export interface RuntimeSettings {
  defaultConnectionId: string;
  nodePath: string;
  windsurfPath: string;
  port: number;
  launchWindsurfOnStart: boolean;
  closeBehavior: "ask" | "minimizeToTray" | "quitApp";
  logFullUpstreamTraffic: boolean;
  minimizeToTrayOnClose?: boolean;
}

export interface AppConfig {
  schemaVersion: number;
  onboardingCompleted: boolean;
  connections: ConnectionProfile[];
  routes: ModelRoute[];
  runtime: RuntimeSettings;
}

export interface NodeInfo {
  found: boolean;
  path: string;
  version: string;
  supported: boolean;
  detail: string;
}

export interface EnvironmentReport {
  appVersion: string;
  platform: string;
  architecture: string;
  node: NodeInfo;
  windsurfFound: boolean;
  windsurfPath: string;
  portAvailable: boolean;
  portOwner?: { pid?: number; processName?: string } | null;
  proxyRunning: boolean;
  proxyPid?: number;
  configPath: string;
  dataDirectory: string;
  patch: {
    ok?: boolean;
    error?: string;
    build?: { version?: string; commit?: string; known?: boolean; extensionSha256?: string };
    patches?: Array<{ name: string; status: string }>;
  };
}

export interface OperationResult {
  ok: boolean;
  summary: string;
  detail: Record<string, unknown>;
}

export interface LogEntry {
  at: string;
  level: string;
  source: string;
  message: string;
  operation?: string;
  requestId?: string;
  summary?: string;
  detail?: unknown;
  rawRequest?: string;
  rawResponse?: string;
}

export interface TestResult {
  ok: boolean;
  requestModel: string;
  returnedModel: string;
  wireApi: WireApi;
  latencyMs: number;
  responseText: string;
  status: number;
  thinkingEffort: string;
  degraded: boolean;
  raw: string;
  requestId?: string;
  rawRequest?: string;
  rawResponse?: string;
}
