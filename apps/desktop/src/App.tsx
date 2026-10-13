import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  Clipboard,
  CloudCog,
  Download,
  Eye,
  EyeOff,
  FileArchive,
  FileText,
  FolderOpen,
  Gauge,
  Info,
  ListRestart,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  Trash2,
  X
} from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { version as appVersion } from "../package.json";
import appIcon from "./assets/app-icon.png";
import type {
  AppConfig,
  ConnectionProfile,
  EnvironmentReport,
  LogEntry,
  ModelRoute,
  OperationResult,
  TestResult,
  ThinkingEffort,
  ThinkingMode,
  WireApi
} from "./types";

type Page = "overview" | "connections" | "routes" | "logs" | "diagnostics";
type CloseBehavior = AppConfig["runtime"]["closeBehavior"];
type MessageAction = { label: string; page?: Page; run?: "applyPatch" };
type DialogState =
  | { kind: "message"; title: string; summary: string; detail?: string; tone?: "info" | "error" | "success"; actions?: MessageAction[] }
  | { kind: "route"; route: ModelRoute; isNew: boolean }
  | { kind: "exit" }
  | null;

const modelPresets = [
  "MODEL_CLAUDE_4_OPUS_BYOK",
  "MODEL_CLAUDE_4_OPUS_THINKING_BYOK",
  "MODEL_CLAUDE_4_SONNET_BYOK",
  "MODEL_CLAUDE_4_SONNET_THINKING_BYOK",
  "swe-1-6"
];

const templates: Record<string, Partial<ConnectionProfile>> = {
  custom: {},
  "openai-chat": { name: "OpenAI Chat", providerTemplate: "openai-chat", baseUrl: "https://api.openai.com/v1", wireApi: "chat", defaultModel: "gpt-4.1" },
  "openai-responses": { name: "OpenAI Responses", providerTemplate: "openai-responses", baseUrl: "https://api.openai.com/v1", wireApi: "responses", defaultModel: "gpt-5.1" },
  anthropic: { name: "Anthropic", providerTemplate: "anthropic", baseUrl: "https://api.anthropic.com/v1", wireApi: "anthropic", defaultModel: "claude-sonnet-4-6" }
};

const pageMeta: Record<Page, { title: string; subtitle: string }> = {
  overview: { title: "运行概览", subtitle: "检查环境并启动 Windsurf 原生 Cascade 中转。" },
  connections: { title: "连接管理", subtitle: "集中管理服务商地址、密钥、协议和默认模型。" },
  routes: { title: "模型路由", subtitle: "将 Windsurf 内部模型 ID 映射到不同连接和上游模型。" },
  logs: { title: "运行日志", subtitle: "查看代理、补丁和上游请求的实时状态。" },
  diagnostics: { title: "环境诊断", subtitle: "检查 Node.js、Windsurf、端口和补丁状态。" }
};

function App() {
  const [page, setPage] = useState<Page>("overview");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [initializationError, setInitializationError] = useState("");
  const [savedConfig, setSavedConfig] = useState<AppConfig | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsRef = useRef<LogEntry[]>([]);
  const pageRef = useRef<Page>("overview");
  const logFlushTimer = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [discoveredModelIds, setDiscoveredModelIds] = useState<string[]>([]);

  useEffect(() => {
    pageRef.current = page;
    if (page === "logs") setLogs(logsRef.current);
  }, [page]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const report = await api.detectEnvironment();
      setEnvironment(report);
    } catch (error) {
      showError("状态刷新失败", error);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let environmentTimer: ReturnType<typeof window.setTimeout> | undefined;
    let logsTimer: ReturnType<typeof window.setTimeout> | undefined;

    api.loadConfig()
      .then(loadedConfig => {
        if (cancelled) return;
        setConfig(loadedConfig);
        setSavedConfig(loadedConfig);
        setSelectedConnectionId(loadedConfig.runtime.defaultConnectionId || loadedConfig.connections[0]?.id || "");
        setModelOptions(Object.fromEntries(loadedConfig.connections.map(item => [item.id, item.fetchedModels || []])));
      })
      .catch(error => {
        if (!cancelled) setInitializationError(error instanceof Error ? error.message : String(error));
      });

    environmentTimer = window.setTimeout(() => {
      api.detectEnvironment()
        .then(report => {
          if (!cancelled) setEnvironment(report);
        })
        .catch(error => {
          if (!cancelled) showError("环境检查失败", error);
        });
    }, 60);

    logsTimer = window.setTimeout(() => {
      api.getLogs()
        .then(loadedLogs => {
          if (cancelled) return;
          logsRef.current = loadedLogs;
          if (pageRef.current === "logs") setLogs(loadedLogs);
        })
        .catch(error => {
          if (!cancelled) showError("日志读取失败", error);
        });
    }, 220);

    let stopLog: (() => void) | undefined;
    let stopExit: (() => void) | undefined;
    let stopProxyState: (() => void) | undefined;
    let stopTrayError: (() => void) | undefined;
    api.onLog(entry => {
      logsRef.current = [...logsRef.current.slice(-1999), entry];
      if (pageRef.current !== "logs" || logFlushTimer.current) return;
      logFlushTimer.current = window.setTimeout(() => {
        logFlushTimer.current = null;
        setLogs(logsRef.current);
      }, 120);
    }).then(value => { if (cancelled) value(); else stopLog = value; });
    api.onExitConfirmation(() => setDialog({ kind: "exit" })).then(value => { if (cancelled) value(); else stopExit = value; });
    api.onProxyStateChanged(() => { void refresh(); }).then(value => { if (cancelled) value(); else stopProxyState = value; });
    api.onTrayError(message => showError("托盘操作失败", message)).then(value => { if (cancelled) value(); else stopTrayError = value; });
    return () => {
      cancelled = true;
      if (environmentTimer) window.clearTimeout(environmentTimer);
      if (logsTimer) window.clearTimeout(logsTimer);
      if (logFlushTimer.current) window.clearTimeout(logFlushTimer.current);
      stopLog?.();
      stopExit?.();
      stopProxyState?.();
      stopTrayError?.();
    };
  }, []);

  const showError = (title: string, error: unknown) => {
    setDialog({
      kind: "message",
      title,
      summary: error instanceof Error ? error.message : String(error),
      detail: error instanceof Error ? error.stack : "",
      tone: "error",
      actions: repairActionsFor(title, error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : "")
    });
  };

  const run = async <T,>(name: string, task: () => Promise<T>, onSuccess?: (result: T) => void) => {
    if (busy) return;
    setBusy(name);
    try {
      const result = await task();
      onSuccess?.(result);
      return result;
    } catch (error) {
      showError(`${name}失败`, error);
    } finally {
      setBusy("");
      await refresh();
    }
  };

  const sanitizeConfigForSave = (next: AppConfig) => ({
    ...next,
    runtime: { ...next.runtime, logFullUpstreamTraffic: false }
  });

  const saveConfig = async (next = config, silent = false) => {
    if (!next) return;
    const sanitized = sanitizeConfigForSave(next);
    return run("保存配置", () => api.saveConfig(sanitized), result => {
      setConfig(sanitized);
      setSavedConfig(sanitized);
      if (!silent) {
        const summary = result.detail?.portChanged
          ? "配置已保存。端口已变更，请重新安装补丁，并重启代理和 Windsurf。"
          : result.summary;
        setDialog({ kind: "message", title: "保存配置", summary, tone: "success" });
      }
    });
  };

  const saveCurrentConfig = async (next = config) => {
    if (!next) return;
    const sanitized = sanitizeConfigForSave(next);
    await api.saveConfig(sanitized);
    setConfig(sanitized);
    setSavedConfig(sanitized);
  };

  const handleStart = async () => {
    if (!config) return;
    setBusy("启动代理");
    try {
      await saveCurrentConfig();
      const check = await api.preflight();
      if (!check.ok) {
        const requiresPatch = Boolean(check.detail.requiresPatchConfirmation);
        if (requiresPatch && window.confirm("Windsurf 补丁未安装或已失效。是否立即安装补丁？")) {
          await api.applyPatch();
        } else {
          setDialog({ kind: "message", title: "启动前检查", summary: check.summary, detail: JSON.stringify(check.detail, null, 2), tone: "error" });
          return;
        }
      }
      const started = await api.startProxy();
      if (!started.ok) throw new Error(started.summary);
      if (config.runtime.launchWindsurfOnStart) await api.openWindsurf();
    } catch (error) {
      showError("启动失败", error);
    } finally {
      setBusy("");
      await refresh();
    }
  };

  const completeOnboarding = async () => {
    if (!config) return;
    const next = { ...config, onboardingCompleted: true };
    setConfig(next);
    await saveConfig(next, true);
  };

  const discoverFromLogs = () => {
    const discovered = discoverModelIds(logsRef.current);
    setDiscoveredModelIds(discovered);
    return discovered;
  };

  const configNotice = useMemo(() => {
    if (!config || !savedConfig) return "";
    if (configHash(config) === configHash(savedConfig)) return "";
    if (config.runtime.port !== savedConfig.runtime.port) {
      return "本地端口已修改。保存后需要重新安装补丁，并重启代理和 Windsurf。";
    }
    return "配置有未保存修改，保存后代理会尽量热加载；路径或端口类修改可能需要重启。";
  }, [config, savedConfig]);

  if (!config) {
    if (initializationError) {
      return <div className="loading-screen"><section className="initialization-error" role="alert">
        <h1>无法读取配置</h1><p>{initializationError}</p>
        <div className="button-row"><button className="primary" onClick={() => window.location.reload()}><RefreshCw />重试</button><button className="secondary" onClick={() => navigator.clipboard.writeText(initializationError)}><Clipboard />复制错误</button><button className="secondary" onClick={() => api.quit().catch(error => setInitializationError(String(error)))}>退出应用</button></div>
      </section></div>;
    }
    return <div className="loading-screen"><LoaderCircle className="spin" />正在初始化应用…</div>;
  }

  const meta = pageMeta[page];
  const selectedConnection = config.connections.find(item => item.id === selectedConnectionId) || config.connections[0];
  const defaultConnection = config.connections.find(item => item.id === config.runtime.defaultConnectionId) || config.connections[0];
  const patchReady = environment?.patch?.patches?.every(item => item.status === "applied") ?? false;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={appIcon} alt="" />
          <div>
            <strong>Cascade 代理</strong>
            <span>Windsurf 原生中转</span>
          </div>
        </div>
        <nav>
          <NavButton active={page === "overview"} icon={<CircleGauge />} label="运行概览" onClick={() => setPage("overview")} />
          <NavButton active={page === "connections"} icon={<CloudCog />} label="连接管理" onClick={() => setPage("connections")} />
          <NavButton active={page === "routes"} icon={<Route />} label="模型路由" onClick={() => setPage("routes")} badge={config.routes.length} />
          <NavButton active={page === "logs"} icon={<FileText />} label="运行日志" onClick={() => setPage("logs")} />
          <NavButton active={page === "diagnostics"} icon={<Activity />} label="环境诊断" onClick={() => setPage("diagnostics")} />
        </nav>
        <div className="sidebar-status">
          <div className="status-heading">
            <span className={`status-dot ${environment?.proxyRunning ? "online" : ""}`} />
            <strong>{environment?.proxyRunning ? "代理运行中" : "代理未启动"}</strong>
            <button className="icon-button dark status-refresh" title="刷新状态" disabled={refreshing} onClick={refresh}><RefreshCw className={refreshing ? "spin" : ""} /></button>
          </div>
          <dl>
            <div><dt>端口</dt><dd>{config.runtime.port}</dd></div>
            <div><dt>协议</dt><dd>{wireLabel(defaultConnection?.wireApi)}</dd></div>
            <div><dt>模型</dt><dd title={defaultConnection?.defaultModel}>{defaultConnection?.defaultModel || "未设置"}</dd></div>
            <div><dt>补丁</dt><dd>{patchReady ? "已安装" : "需检查"}</dd></div>
          </dl>
        </div>
        <div className="sidebar-actions">
          <button
            className={`${environment?.proxyRunning ? "danger dark" : "primary"} large`}
            disabled={Boolean(busy)}
            onClick={() => environment?.proxyRunning ? run("停止代理", api.stopProxy) : handleStart()}
          >
            {busy === "启动代理" || busy === "停止代理"
              ? <LoaderCircle className="spin" />
              : environment?.proxyRunning ? <Square /> : <Play />}
            {environment?.proxyRunning
              ? "停止代理"
              : config.runtime.launchWindsurfOnStart ? "启动并打开 Windsurf" : "启动代理"}
          </button>
        </div>
        <span className="version">v{environment?.appVersion || appVersion} · {environment?.platform || "desktop"}</span>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
          <div className="header-actions">
            {busy && <span className="busy-label"><LoaderCircle className="spin" />{busy}…</span>}
          </div>
        </header>

        <div className="content">
          {!config.onboardingCompleted && (
            <Onboarding
              config={config}
              environment={environment}
              patchReady={patchReady}
              onNavigate={setPage}
              onStart={handleStart}
              onComplete={completeOnboarding}
            />
          )}
          {configNotice && (
            <div className="notice-banner">
              <Info />
              <span>{configNotice}</span>
              <button className="secondary compact-button" disabled={Boolean(busy)} onClick={() => saveConfig()}>保存配置</button>
            </div>
          )}
          {page === "overview" && (
            <Overview
              config={config}
              setConfig={setConfig}
              environment={environment}
              patchReady={patchReady}
              onPreflight={() => run("启动前检查", async () => {
                await saveCurrentConfig();
                return api.preflight();
              }, result => setDialog(operationDialog("启动前检查", result)))}
              onNavigate={setPage}
            />
          )}
          {page === "connections" && selectedConnection && (
            <ConnectionsPage
              config={config}
              setConfig={setConfig}
              selectedId={selectedConnection.id}
              setSelectedId={setSelectedConnectionId}
              models={modelOptions[selectedConnection.id] || []}
              busy={busy}
              onClearModels={connectionId => setModelOptions(current => ({ ...current, [connectionId]: [] }))}
              onSave={() => saveConfig()}
              onTest={() => run("测试连接", async () => {
                await saveCurrentConfig();
                return api.testConnection(selectedConnection.id);
              }, result => setDialog(testDialog(result)))}
              onFetch={() => run("从上游拉取模型", async () => {
                await saveCurrentConfig();
                const result = await api.fetchModels(selectedConnection.id);
                const next = {
                  ...config,
                  connections: config.connections.map(item => item.id === selectedConnection.id
                    ? { ...item, fetchedModels: result.models, modelsFetchedAt: new Date().toISOString() }
                    : item)
                };
                await saveCurrentConfig(next);
                return result;
              }, result => {
                setModelOptions(current => ({ ...current, [selectedConnection.id]: result.models }));
                setDialog({ kind: "message", title: "从上游拉取模型", summary: `已获取 ${result.models.length} 个模型，耗时 ${result.latencyMs} ms。`, tone: "success" });
              })}
            />
          )}
          {page === "routes" && (
            <RoutesPage
              config={config}
              onAdd={() => setDialog({ kind: "route", isNew: true, route: blankRoute(config.runtime.defaultConnectionId) })}
              onEdit={route => setDialog({ kind: "route", isNew: false, route: { ...route } })}
              onTest={route => run("测试路由", async () => {
                await saveCurrentConfig();
                return api.testConnection(undefined, route.windsurfModelId);
              }, result => setDialog(testDialog(result, "测试路由")))}
              onDelete={id => {
                const next = { ...config, routes: config.routes.filter(item => item.id !== id) };
                setConfig(next);
                saveConfig(next, true);
              }}
            />
          )}
          {page === "logs" && (
            <LogsPage
              logs={logs}
              onClearDisplay={() => {
                logsRef.current = [];
                setLogs([]);
              }}
              onClearFiles={() => run("删除日志文件", () => api.clearLogs(true), () => {
                logsRef.current = [];
                setLogs([]);
              })}
              onExport={async () => {
                const destination = await save({ defaultPath: "WindsurfCascadeProxy-diagnostics.zip", filters: [{ name: "ZIP", extensions: ["zip"] }] });
                if (destination) run("导出诊断包", () => api.exportDiagnostics(destination), path => setDialog({ kind: "message", title: "诊断包已导出", summary: path, tone: "success" }));
              }}
            />
          )}
          {page === "diagnostics" && (
            <DiagnosticsPage
              config={config}
              setConfig={setConfig}
              environment={environment}
              busy={busy}
              onSave={() => saveConfig()}
              onBrowseNode={async () => {
                const value = await open({ multiple: false, title: "选择 Node.js 可执行文件" });
                if (typeof value === "string") setConfig({ ...config, runtime: { ...config.runtime, nodePath: value } });
              }}
              onBrowseWindsurf={async () => {
                const value = await open({ multiple: false, directory: environment?.platform === "macos", title: "选择 Windsurf" });
                if (typeof value === "string") setConfig({ ...config, runtime: { ...config.runtime, windsurfPath: value } });
              }}
              onRefresh={refresh}
              onApply={() => {
                if (window.confirm("安装补丁会修改 Windsurf 内部文件。程序会先创建备份，是否继续？")) {
                  run("安装补丁", api.applyPatch, result => setDialog({ kind: "message", title: "安装补丁", summary: "补丁安装完成，请重启 Windsurf。", detail: JSON.stringify(result, null, 2), tone: "success" }));
                }
              }}
              onRestore={() => {
                if (window.confirm("确定恢复 Windsurf 原始文件吗？恢复后请重启 Windsurf。")) {
                  run("恢复补丁", api.restorePatch, result => setDialog({ kind: "message", title: "恢复补丁", summary: "已恢复原始文件。", detail: JSON.stringify(result, null, 2), tone: "success" }));
                }
              }}
              onOpenConfig={() => navigator.clipboard.writeText(environment?.configPath || "")}
              onResetLayout={() => {
                const next = {
                  ...config,
                  onboardingCompleted: false,
                  runtime: {
                    ...config.runtime,
                    closeBehavior: "ask" as CloseBehavior,
                    logFullUpstreamTraffic: false
                  }
                };
                setConfig(next);
                setPage("overview");
                saveConfig(next, true);
                setDialog({ kind: "message", title: "已恢复默认布局", summary: "首次引导已重新显示，关闭行为和调试日志已恢复默认。连接、路由和密钥没有被清空。", tone: "success" });
              }}
            />
          )}
        </div>
      </main>

      {dialog?.kind === "message" && <MessageDialog
        value={dialog}
        onClose={() => setDialog(null)}
        onAction={action => {
          if (action.page) {
            setPage(action.page);
            setDialog(null);
            return;
          }
          if (action.run === "applyPatch") {
            setDialog(null);
            if (window.confirm("安装补丁会修改 Windsurf 内部文件。程序会先创建备份，是否继续？")) {
              run("安装补丁", api.applyPatch, result => setDialog({ kind: "message", title: "安装补丁", summary: "补丁安装完成，请重启 Windsurf。", detail: JSON.stringify(result, null, 2), tone: "success" }));
            }
          }
        }}
      />}
      {dialog?.kind === "exit" && <ExitDialog
        onClose={() => setDialog(null)}
        onChoose={async (behavior, remember) => {
          if (remember) {
            const next = { ...config, runtime: { ...config.runtime, closeBehavior: behavior } };
            await saveCurrentConfig(next);
          }
          setDialog(null);
          if (behavior === "minimizeToTray") await api.hideWindow();
          if (behavior === "quitApp") await api.quit();
        }}
      />}
      {dialog?.kind === "route" && (
        <RouteDialog
          value={dialog.route}
          connections={config.connections}
          modelChoices={[...new Set([...modelPresets, ...discoveredModelIds])]}
          connectionModelOptions={modelOptions}
          discoveredCount={discoveredModelIds.length}
          onDiscover={discoverFromLogs}
          onClose={() => setDialog(null)}
          onSave={route => {
            const routes = dialog.isNew
              ? [...config.routes, route]
              : config.routes.map(item => item.id === route.id ? route : item);
            const next = { ...config, routes };
            setConfig(next);
            setDialog(null);
            saveConfig(next, true);
          }}
        />
      )}
    </div>
  );
}

function NavButton({ active, icon, label, badge, onClick }: { active: boolean; icon: React.ReactNode; label: string; badge?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span>{badge !== undefined && <b>{badge}</b>}</button>;
}

function Onboarding({ config, environment, patchReady, onNavigate, onStart, onComplete }: {
  config: AppConfig; environment: EnvironmentReport | null; patchReady: boolean;
  onNavigate: (page: Page) => void; onStart: () => void; onComplete: () => void;
}) {
  const connectionReady = config.connections.some(item => item.apiKey && item.baseUrl && item.defaultModel);
  const steps = [
    { label: "Node.js 20+", done: Boolean(environment?.node.supported), action: () => onNavigate("diagnostics") },
    { label: "Windsurf 路径", done: Boolean(environment?.windsurfFound), action: () => onNavigate("diagnostics") },
    { label: "上游连接", done: connectionReady, action: () => onNavigate("connections") },
    { label: "Windsurf 补丁", done: patchReady, action: () => onNavigate("diagnostics") },
    { label: "启动代理", done: Boolean(environment?.proxyRunning), action: onStart }
  ];
  const allDone = steps.every(item => item.done);
  return (
    <section className="onboarding">
      <div>
        <span className="eyebrow">首次使用</span>
        <h2>完成五项检查后即可使用原生 Cascade</h2>
      </div>
      <div className="onboarding-steps">
        {steps.map((step, index) => (
          <button key={step.label} className={step.done ? "done" : ""} onClick={step.action}>
            <span>{step.done ? <Check /> : index + 1}</span>
            {step.label}
            <ChevronRight />
          </button>
        ))}
      </div>
      {allDone && <button className="text-button" onClick={onComplete}>完成引导</button>}
    </section>
  );
}

function Overview({ config, setConfig, environment, patchReady, onPreflight, onNavigate }: {
  config: AppConfig; setConfig: (value: AppConfig) => void; environment: EnvironmentReport | null; patchReady: boolean;
  onPreflight: () => void; onNavigate: (page: Page) => void;
}) {
  const connection = config.connections.find(item => item.id === config.runtime.defaultConnectionId) || config.connections[0];
  return (
    <>
      <section className="hero-status">
        <div className={`hero-icon ${environment?.proxyRunning ? "running" : ""}`}>{environment?.proxyRunning ? <Activity /> : <Gauge />}</div>
        <div className="hero-copy">
          <span className="eyebrow">{environment?.proxyRunning ? "服务正常" : "等待启动"}</span>
          <h2>{environment?.proxyRunning ? `代理正在监听 127.0.0.1:${config.runtime.port}` : "启动前会自动检查环境和补丁"}</h2>
          <p>{environment?.proxyRunning ? "Windsurf Cascade 请求会根据模型路由转发到对应上游。" : "遇到补丁失效时会先请求确认，不会静默修改 Windsurf。"}</p>
        </div>
        <div className="hero-actions">
          <button className="secondary" onClick={onPreflight}><ShieldCheck />启动前检查</button>
        </div>
      </section>

      <div className="metric-grid">
        <Metric label="Node.js" value={environment?.node.supported ? `v${environment.node.version}` : "不可用"} detail={environment?.node.detail || "正在检查"} ok={environment?.node.supported} onClick={() => onNavigate("diagnostics")} />
        <Metric label="Windsurf" value={environment?.windsurfFound ? "已找到" : "未找到"} detail={environment?.windsurfPath || "请指定安装路径"} ok={environment?.windsurfFound} onClick={() => onNavigate("diagnostics")} />
        <Metric label="补丁状态" value={patchReady ? "已安装" : "需处理"} detail={environment?.patch?.build?.version ? `Windsurf ${environment.patch.build.version}` : "检查目标文件"} ok={patchReady} onClick={() => onNavigate("diagnostics")} />
        <Metric label="模型路由" value={`${config.routes.length} 条`} detail={config.routes.length ? "按模型 ID 分流" : "全部使用默认连接"} ok onClick={() => onNavigate("routes")} />
      </div>

      <section className="settings-band">
        <div className="section-heading">
          <div><h2>快速设置</h2><p>平时更换上游时，只需切换默认连接或默认模型。</p></div>
          <button className="secondary" onClick={() => onNavigate("connections")}><Settings2 />管理连接</button>
        </div>
        <div className="quick-grid">
          <label>
            <span>默认连接</span>
            <select value={config.runtime.defaultConnectionId} onChange={event => setConfig({ ...config, runtime: { ...config.runtime, defaultConnectionId: event.target.value } })}>
              {config.connections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span>默认模型</span>
            <input value={connection?.defaultModel || ""} onChange={event => {
              const connections = config.connections.map(item => item.id === connection.id ? { ...item, defaultModel: event.target.value } : item);
              setConfig({ ...config, connections });
            }} />
          </label>
          <label className="toggle-field">
            <input type="checkbox" checked={config.runtime.launchWindsurfOnStart} onChange={event => setConfig({ ...config, runtime: { ...config.runtime, launchWindsurfOnStart: event.target.checked } })} />
            <span>启动代理后打开 Windsurf</span>
          </label>
        </div>
      </section>
    </>
  );
}

function Metric({ label, value, detail, ok, onClick }: { label: string; value: string; detail: string; ok?: boolean; onClick?: () => void }) {
  return <button className="metric" onClick={onClick} disabled={!onClick}><span className={`metric-state ${ok ? "ok" : "warn"}`}>{ok ? <Check /> : <AlertCircle />}</span><div><span>{label}</span><strong>{value}</strong><small title={detail}>{detail}</small></div></button>;
}

function ConnectionsPage({ config, setConfig, selectedId, setSelectedId, models, busy, onClearModels, onSave, onTest, onFetch }: {
  config: AppConfig; setConfig: (value: AppConfig) => void; selectedId: string; setSelectedId: (id: string) => void;
  models: string[]; busy: string; onClearModels: (connectionId: string) => void; onSave: () => void; onTest: () => void; onFetch: () => void;
}) {
  const selected = config.connections.find(item => item.id === selectedId) || config.connections[0];
  const [showKey, setShowKey] = useState(false);
  const update = (patch: Partial<ConnectionProfile>) => {
    const clearsCachedModels = ["baseUrl", "wireApi", "providerTemplate"].some(key => Object.prototype.hasOwnProperty.call(patch, key));
    const nextConnection = {
      ...selected,
      ...patch,
      ...(clearsCachedModels ? { fetchedModels: [], modelsFetchedAt: "" } : {})
    };
    setConfig({ ...config, connections: config.connections.map(item => item.id === selected.id ? nextConnection : item) });
    if (clearsCachedModels) onClearModels(selected.id);
  };
  const addConnection = () => {
    const item: ConnectionProfile = {
      id: crypto.randomUUID(),
      name: "新连接",
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
    };
    setConfig({ ...config, connections: [...config.connections, item] });
    setSelectedId(item.id);
  };
  return (
    <div className="split-layout">
      <aside className="item-list">
        <div className="list-heading"><strong>上游连接</strong><button className="icon-button" title="新增连接" onClick={addConnection}><Plus /></button></div>
        {config.connections.map(item => (
          <button key={item.id} className={selected.id === item.id ? "selected" : ""} onClick={() => setSelectedId(item.id)}>
            <CloudCog />
            <span><strong>{item.name}</strong><small>{wireLabel(item.wireApi)} · {item.defaultModel || "未设置模型"}</small></span>
            {config.runtime.defaultConnectionId === item.id && <b>默认</b>}
          </button>
        ))}
      </aside>
      <section className="editor-pane">
        <div className="section-heading sticky-actions">
          <div><h2>{selected.name}</h2><p>连接配置可以被多个 Windsurf 模型路由复用。</p></div>
          <div className="button-row">
            <button className="secondary" disabled={Boolean(busy)} onClick={onTest}><Network />测试连接</button>
            <button className="secondary" disabled={Boolean(busy)} onClick={onFetch}><Download />从上游拉取模型</button>
            <button className="primary" disabled={Boolean(busy)} onClick={onSave}><Save />保存配置</button>
          </div>
        </div>
        <div className="form-section">
          <div className="subsection-heading"><h3>基础信息</h3></div>
          <div className="form-grid">
            <Field label="连接名称"><input value={selected.name} onChange={event => update({ name: event.target.value })} /></Field>
            <Field label="服务商模板">
              <select value={templates[selected.providerTemplate] ? selected.providerTemplate : "custom"} onChange={event => {
                const template = templates[event.target.value] || {};
                update({ ...template, providerTemplate: event.target.value });
              }}>
                <option value="custom">自定义</option>
                <option value="openai-chat">OpenAI Chat</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="form-section">
          <div className="subsection-heading"><h3>上游接口</h3></div>
          <div className="form-grid">
            <Field label="接口地址" wide><input value={selected.baseUrl} placeholder="https://api.example.com/v1" onChange={event => update({ baseUrl: event.target.value })} /></Field>
            <Field label="API 密钥" wide>
              <div className="input-action"><input type={showKey ? "text" : "password"} value={selected.apiKey} onChange={event => update({ apiKey: event.target.value })} /><button title={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff /> : <Eye />}</button></div>
            </Field>
          </div>
        </div>
        <div className="form-section">
          <div className="subsection-heading"><h3>协议与模型</h3></div>
          <div className="form-grid">
            <Field label="接口类型">
              <select value={selected.wireApi} onChange={event => update({ wireApi: event.target.value as WireApi })}>
                <option value="chat">OpenAI Chat</option>
                <option value="responses">OpenAI Responses</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </Field>
            <Field label="默认模型">
              <ModelSelector
                value={selected.defaultModel}
                options={models}
                placeholder="可以手动填写模型 ID"
                onChange={value => update({ defaultModel: value })}
              />
            </Field>
            {selected.fetchedModels?.length > 0 && (
              <p className="field-help wide">
                已缓存 {selected.fetchedModels.length} 个上游模型
                {selected.modelsFetchedAt ? `，最后刷新 ${new Date(selected.modelsFetchedAt).toLocaleString("zh-CN", { hour12: false })}` : ""}。
              </p>
            )}
          </div>
        </div>
        <div className="form-section">
          <div className="subsection-heading"><h3>思考设置</h3></div>
          <div className="form-grid">
            <ThinkingFields value={selected} onChange={update} />
          </div>
        </div>
      </section>
    </div>
  );
}

function ThinkingFields({ value, onChange, inherited = false }: {
  value: Pick<ConnectionProfile, "wireApi" | "thinkingMode" | "thinkingEffort" | "thinkingBudgetTokens">;
  onChange: (patch: Partial<ConnectionProfile>) => void;
  inherited?: boolean;
}) {
  const anthropic = value.wireApi === "anthropic";
  const effortOptions: Array<[ThinkingEffort, string]> = [
    ["default", inherited ? "继承连接" : "默认（不指定）"],
    ["none", "无"],
    ["minimal", "最小"],
    ["low", "低"],
    ["medium", "中"],
    ["high", "高"],
    ["xhigh", "极高"],
    ["max", "最高"]
  ];
  return (
    <>
      {anthropic && <Field label="思考模式">
        <select value={value.thinkingMode} onChange={event => onChange({ thinkingMode: event.target.value as ThinkingMode })}>
          <option value="default">{inherited ? "继承连接" : "默认（不指定）"}</option>
          <option value="disabled">关闭</option>
          <option value="adaptive">自适应</option>
          <option value="enabled">手动开启</option>
        </select>
      </Field>}
      <Field label={anthropic ? "思考强度" : value.wireApi === "responses" ? "推理强度（reasoning.effort）" : "推理强度（reasoning_effort）"}>
        <select value={value.thinkingEffort} onChange={event => onChange({ thinkingEffort: event.target.value as ThinkingEffort })}>
          {effortOptions.filter(([key]) => anthropic || key !== "max").map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
      {anthropic && value.thinkingMode === "enabled" && <Field label="思考预算（0=自动）">
        <input type="number" min={0} max={1_000_000} value={value.thinkingBudgetTokens} onChange={event => onChange({ thinkingBudgetTokens: Number(event.target.value) })} />
      </Field>}
      <p className="field-help wide">
        {anthropic
          ? "Anthropic 使用 thinking 和 output_config.effort；只有“手动开启”使用预算。"
          : value.wireApi === "responses"
            ? "OpenAI Responses 只发送 reasoning.effort；不支持时自动去掉参数重试一次。"
            : "OpenAI Chat 只发送 reasoning_effort；不支持时自动去掉参数重试一次。"}
      </p>
    </>
  );
}

function RoutesPage({ config, onAdd, onEdit, onTest, onDelete }: {
  config: AppConfig; onAdd: () => void; onEdit: (route: ModelRoute) => void; onTest: (route: ModelRoute) => void; onDelete: (id: string) => void;
}) {
  return (
    <section>
      <div className="section-heading">
        <div><h2>Windsurf 模型映射</h2><p>未命中路由的请求使用默认连接。双击一行也可以编辑。</p></div>
        <div className="button-row"><button className="primary" onClick={onAdd}><Plus />新增路由</button></div>
      </div>
      <div className="data-table">
        <table className="routes-table">
          <thead><tr><th>Windsurf 模型 ID</th><th>连接</th><th>中转模型</th><th>思考设置</th><th aria-label="操作" /></tr></thead>
          <tbody>
            {config.routes.length === 0 && <tr><td colSpan={5}><EmptyState icon={<Route />} title="还没有模型路由" detail="所有请求暂时使用默认连接。可以新增路由，让不同 Windsurf 模型走不同上游。" action={<button className="primary" onClick={onAdd}><Plus />新增路由</button>} /></td></tr>}
            {config.routes.map(route => {
              const connection = config.connections.find(item => item.id === route.connectionId);
              const routeModel = route.model || connection?.defaultModel || "未设置";
              const thinkingOverride = Boolean(route.thinkingMode || route.thinkingEffort || route.thinkingBudgetTokens);
              const resolvedThinkingEffort = route.thinkingEffort || connection?.thinkingEffort || "default";
              return (
                <tr key={route.id} onDoubleClick={() => onEdit(route)}>
                  <td className="mono route-readable" title={route.windsurfModelId}>{route.windsurfModelId}</td>
                  <td className="route-readable" title={connection?.name || "连接已删除"}>{connection?.name || "连接已删除"}</td>
                  <td>
                    <div className="route-cell">
                      <span title={routeModel}>{routeModel}</span>
                      <RouteTag tone={route.model ? "override" : "inherit"}>{route.model ? "覆盖" : "继承"}</RouteTag>
                    </div>
                  </td>
                  <td>
                    <div className="route-cell">
                      <span title={thinkingEffortLabel(resolvedThinkingEffort)}>{thinkingEffortLabel(resolvedThinkingEffort)}</span>
                      <RouteTag tone={thinkingOverride ? "override" : "inherit"}>{thinkingOverride ? "覆盖" : "继承"}</RouteTag>
                    </div>
                  </td>
                  <td className="row-actions">
                    <button title="测试路由" onClick={() => onTest(route)}><Network /></button>
                    <button title="编辑路由" onClick={() => onEdit(route)}><Pencil /></button>
                    <button title="删除路由" onClick={() => onDelete(route.id)}><Trash2 /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RouteTag({ tone, children }: { tone: "inherit" | "override"; children: React.ReactNode }) {
  return <span className={`route-tag ${tone}`}>{children}</span>;
}

function LogsPage({ logs, onClearDisplay, onClearFiles, onExport }: { logs: LogEntry[]; onClearDisplay: () => void; onClearFiles: () => void; onExport: () => void }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"summary" | "raw">("summary");
  const visible = useMemo(() => logs.filter(item => {
    const haystack = logSearchText(item).toLowerCase();
    return (!errorsOnly || ["error", "warn"].includes(item.level)) && (!query || haystack.includes(query.toLowerCase()));
  }), [logs, errorsOnly, query]);
  const displayLimit = 500;
  const displayed = visible.length > displayLimit ? visible.slice(-displayLimit) : visible;
  const copyErrors = () => navigator.clipboard.writeText(logs.filter(item => ["error", "warn"].includes(item.level)).map(item => `${item.at} ${item.message}`).join("\n"));
  const copyVisible = () => navigator.clipboard.writeText(displayed.map(item => view === "raw" ? logRawText(item) : `${item.at} [${item.level}] [${item.source}] ${item.summary || item.message}`).join("\n\n"));
  return (
    <section>
      <div className="section-heading">
        <div><h2>实时日志</h2><p>日志会自动轮转，API 密钥和认证头会被脱敏。</p></div>
        <div className="button-row"><button className="secondary" onClick={copyVisible}><Clipboard />复制当前视图</button><button className="secondary" onClick={copyErrors}><Clipboard />复制错误</button><button className="secondary" onClick={onExport}><FileArchive />导出诊断包</button></div>
      </div>
      <div className="log-toolbar">
        <div className="segmented">
          <button className={view === "summary" ? "active" : ""} onClick={() => setView("summary")}>摘要版</button>
          <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>原始版</button>
        </div>
        <label className="search-field"><Search /><input value={query} placeholder="搜索日志" onChange={event => setQuery(event.target.value)} /></label>
        <label className="toggle-field compact"><input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)} /><span>只看错误</span></label>
        <span>{visible.length > displayLimit ? `显示最近 ${displayLimit} / ${visible.length} 条` : `${visible.length} 条`}</span>
      </div>
      <div className={`log-view ${view === "raw" ? "raw" : ""}`}>
        {visible.length === 0 && <div className="log-empty">暂无符合条件的日志</div>}
        {displayed.map((entry, index) => view === "raw"
          ? <pre key={`${entry.at}-${index}`} className={`log-raw ${entry.level}`}>{logRawText(entry)}</pre>
          : <div key={`${entry.at}-${index}`} className={`log-line ${entry.level}`}><time>{formatTime(entry.at)}</time><b>{entry.source}</b><span>{entry.summary || entry.message}{entry.requestId ? `  #${entry.requestId}` : ""}</span></div>)}
      </div>
      <div className="footer-actions"><button className="secondary" onClick={onClearDisplay}><X />清空窗口</button><button className="secondary danger-text" onClick={onClearFiles}><Trash2 />删除日志文件</button></div>
    </section>
  );
}

function DiagnosticsPage({ config, setConfig, environment, busy, onSave, onBrowseNode, onBrowseWindsurf, onRefresh, onApply, onRestore, onOpenConfig, onResetLayout }: {
  config: AppConfig;
  setConfig: (value: AppConfig) => void;
  environment: EnvironmentReport | null;
  busy: string;
  onSave: () => void;
  onBrowseNode: () => void;
  onBrowseWindsurf: () => void;
  onRefresh: () => void;
  onApply: () => void;
  onRestore: () => void;
  onOpenConfig: () => void;
  onResetLayout: () => void;
}) {
  const portOwner = environment?.portOwner;
  const portDetail = environment?.proxyRunning
    ? `由本程序代理占用，PID ${environment.proxyPid}`
    : environment?.portAvailable
      ? "启动前必须可用"
      : portOwner
        ? `被 ${portOwner.processName || "未知进程"} 占用，PID ${portOwner.pid || "未知"}。请更换端口。`
        : "端口被其他程序占用，请在本机运行设置中更换端口。";
  const checks = [
    { label: "Node.js", value: environment?.node.found ? `v${environment.node.version}` : "未找到", detail: environment?.node.path || environment?.node.detail, ok: environment?.node.supported },
    { label: "Windsurf", value: environment?.windsurfFound ? "已找到" : "未找到", detail: environment?.windsurfPath, ok: environment?.windsurfFound },
    { label: "本地端口", value: environment?.portAvailable ? "可用" : "被占用", detail: portDetail, ok: environment?.portAvailable },
    { label: "补丁文件", value: environment?.patch?.patches?.every(item => item.status === "applied") ? "已安装" : "需处理", detail: environment?.patch?.error || `构建 ${environment?.patch?.build?.version || "未知"}`, ok: environment?.patch?.patches?.every(item => item.status === "applied") }
  ];
  const patchDescription = environment?.platform === "macos"
    ? "安装前会确认 Windsurf 已退出，完整备份 Windsurf.app，并在修改后执行本机临时签名。"
    : "安装前会备份被修改文件，恢复补丁可还原到安装前状态。";
  return (
    <section>
      <div className="section-heading">
        <div><h2>环境检查</h2><p>先确认 Node.js、Windsurf、端口和补丁状态，再调整本机设置。</p></div>
        <button className="secondary" disabled={Boolean(busy)} onClick={onRefresh}><RefreshCw />重新检查</button>
      </div>
      <div className="diagnostic-list">
        {checks.map(item => <div key={item.label}><span className={`check-icon ${item.ok ? "ok" : "warn"}`}>{item.ok ? <Check /> : <AlertCircle />}</span><div><strong>{item.label}</strong><p>{item.detail || "暂无详细信息"}</p></div><b>{item.value}</b></div>)}
      </div>
      <section className="patch-section">
        <div>
          <h2>Windsurf 接管补丁</h2>
          <p>{patchDescription}</p>
          {environment?.patch?.build && <code>SHA-256: {environment.patch.build.extensionSha256 || "未读取"}</code>}
        </div>
        <div className="button-row"><button className="primary" disabled={Boolean(busy)} onClick={onApply}><ShieldCheck />安装或更新补丁</button><button className="secondary" disabled={Boolean(busy)} onClick={onRestore}><RotateCcw />恢复补丁</button></div>
      </section>
      <section className="settings-band">
        <div className="section-heading">
          <div><h2>本机运行设置</h2><p>这些路径只影响本机环境，不属于上游连接配置。</p></div>
          <button className="primary" disabled={Boolean(busy)} onClick={onSave}><Save />保存运行设置</button>
        </div>
        <div className="form-grid">
          <Field label="本地端口">
            <div className="port-input">
              <span>127.0.0.1:</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={config.runtime.port}
                onChange={event => setConfig({ ...config, runtime: { ...config.runtime, port: Number(event.target.value) } })}
              />
            </div>
          </Field>
          <p className="field-help wide">
            如果端口被占用，改成 1024-65535 之间未被占用的端口。端口变更后需要保存、重新安装补丁，并重启代理和 Windsurf。
          </p>
          <Field label="关闭窗口时">
            <select
              value={config.runtime.closeBehavior || "ask"}
              onChange={event => setConfig({ ...config, runtime: { ...config.runtime, closeBehavior: event.target.value as CloseBehavior } })}
            >
              <option value="ask">每次询问</option>
              <option value="minimizeToTray">最小化到托盘</option>
              <option value="quitApp">退出应用</option>
            </select>
          </Field>
          <Field label="Node.js 路径" wide>
            <div className="input-action">
              <input
                value={config.runtime.nodePath}
                placeholder="留空时自动查找"
                onChange={event => setConfig({ ...config, runtime: { ...config.runtime, nodePath: event.target.value } })}
              />
              <button title="选择 Node.js" onClick={onBrowseNode}><FolderOpen /></button>
            </div>
          </Field>
          <Field label="Windsurf 路径" wide>
            <div className="input-action">
              <input
                value={config.runtime.windsurfPath}
                placeholder="留空时自动查找"
                onChange={event => setConfig({ ...config, runtime: { ...config.runtime, windsurfPath: event.target.value } })}
              />
              <button title="选择 Windsurf" onClick={onBrowseWindsurf}><FolderOpen /></button>
            </div>
          </Field>
        </div>
      </section>
      <div className="section-heading directory-heading">
        <div><h2>配置/运行目录</h2><p>复制路径用于手动排查；恢复默认布局不会清空连接、路由或密钥。</p></div>
        <button className="secondary" onClick={onResetLayout}><RotateCcw />恢复默认布局</button>
      </div>
      <div className="path-list">
        <button onClick={onOpenConfig}><FileText /><span><strong>配置文件</strong><small>{environment?.configPath}</small></span><Clipboard /></button>
        <button onClick={() => navigator.clipboard.writeText(environment?.dataDirectory || "")}><FolderOpen /><span><strong>运行目录</strong><small>{environment?.dataDirectory}</small></span><Clipboard /></button>
      </div>
    </section>
  );
}

function RouteDialog({ value, connections, modelChoices, connectionModelOptions, discoveredCount, onDiscover, onClose, onSave }: {
  value: ModelRoute;
  connections: ConnectionProfile[];
  modelChoices: string[];
  connectionModelOptions: Record<string, string[]>;
  discoveredCount: number;
  onDiscover: () => string[];
  onClose: () => void;
  onSave: (route: ModelRoute) => void;
}) {
  const [route, setRoute] = useState(value);
  const [lastDiscoverCount, setLastDiscoverCount] = useState<number | null>(null);
  const connection = connections.find(item => item.id === route.connectionId) || connections[0];
  const upstreamModels = connectionModelOptions[route.connectionId] || [];
  const set = (patch: Partial<ModelRoute>) => setRoute(current => ({ ...current, ...patch }));
  return (
    <Modal title="编辑模型路由" onClose={onClose} width="760px">
      <div className="form-grid route-dialog-grid">
        <div className="field wide">
          <span>Windsurf 模型 ID</span>
          <div className="route-id-picker">
            <ModelSelector
              value={route.windsurfModelId}
              options={modelChoices}
              placeholder="可以手动填写或选择 Windsurf 模型 ID"
              onChange={value => set({ windsurfModelId: value })}
            />
            <button
              type="button"
              className="secondary subtle"
              onClick={() => {
                const discovered = onDiscover();
                setLastDiscoverCount(discovered.length);
              }}
            >
              <Search />从日志发现{discoveredCount ? `（${discoveredCount}）` : ""}
            </button>
          </div>
          {lastDiscoverCount !== null && (
            <p className="field-help">
              {lastDiscoverCount ? `已发现 ${lastDiscoverCount} 个 Windsurf 模型 ID，已加入当前下拉候选。` : "当前日志中没有发现 Windsurf 模型 ID。"}
            </p>
          )}
        </div>
        <Field label="上游连接"><select value={route.connectionId} onChange={event => set({ connectionId: event.target.value })}>{connections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        <Field label="中转模型">
          <ModelSelector
            value={route.model}
            options={upstreamModels}
            placeholder={`留空使用 ${connection?.defaultModel || "连接默认模型"}`}
            onChange={value => set({ model: value })}
          />
        </Field>
        {connection?.wireApi === "anthropic" && (
          <Field label="思考模式">
            <select value={route.thinkingMode} onChange={event => set({ thinkingMode: event.target.value as ModelRoute["thinkingMode"] })}><option value="">继承连接</option><option value="default">默认（不指定）</option><option value="disabled">关闭</option><option value="adaptive">自适应</option><option value="enabled">手动开启</option></select>
          </Field>
        )}
        <Field label={connection?.wireApi === "anthropic" ? "思考强度" : "推理强度"}>
          <select value={route.thinkingEffort} onChange={event => set({ thinkingEffort: event.target.value as ModelRoute["thinkingEffort"] })}>
            <option value="">继承连接</option><option value="default">默认（不指定）</option><option value="none">无</option><option value="minimal">最小</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option>{connection?.wireApi === "anthropic" && <option value="max">最高</option>}
          </select>
        </Field>
        {connection?.wireApi === "anthropic" && route.thinkingMode === "enabled" && <Field label="思考预算"><input type="number" min={0} value={route.thinkingBudgetTokens ?? 0} onChange={event => set({ thinkingBudgetTokens: Number(event.target.value) })} /></Field>}
        <p className="field-help wide">留空表示继承上游连接的默认思考设置；填写后只覆盖当前 Windsurf 模型 ID。</p>
      </div>
      <div className="modal-actions"><button className="secondary" onClick={onClose}>取消</button><button className="primary" disabled={!route.windsurfModelId || !route.connectionId} onClick={() => onSave(route)}><Save />保存路由</button></div>
    </Modal>
  );
}

function MessageDialog({ value, onClose, onAction }: { value: Extract<DialogState, { kind: "message" }>; onClose: () => void; onAction: (action: MessageAction) => void }) {
  return (
    <Modal title={value.title} onClose={onClose} width="560px">
      <div className={`message-dialog ${value.tone || "info"}`}>
        <span>{value.tone === "error" ? <AlertCircle /> : value.tone === "success" ? <Check /> : <Info />}</span>
        <div><strong>{value.summary}</strong>{value.detail && <details><summary>查看原始信息</summary><pre>{value.detail}</pre><button className="secondary compact-button" onClick={() => navigator.clipboard.writeText(value.detail || "")}><Clipboard />复制</button></details>}</div>
      </div>
      <div className="modal-actions">
        {value.actions?.map(action => <button key={`${action.label}-${action.page || action.run}`} className="secondary" onClick={() => onAction(action)}>{action.label}</button>)}
        <button className="primary" onClick={onClose}>确定</button>
      </div>
    </Modal>
  );
}

function ExitDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (behavior: CloseBehavior, remember: boolean) => void | Promise<void> }) {
  const [remember, setRemember] = useState(false);
  return (
    <Modal title="退出应用" onClose={onClose} width="500px">
      <div className="message-dialog info">
        <span><Info /></span>
        <div>
          <strong>要如何处理 Windsurf Cascade 代理？</strong>
          <p>最小化到托盘会让代理继续运行。退出应用会停止由本程序启动的 Node.js 代理。</p>
        </div>
      </div>
      <label className="toggle-field remember-choice">
        <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
        <span>记住我的选择</span>
      </label>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onChoose("minimizeToTray", remember)}>最小化到托盘</button>
        <button className="danger" onClick={() => onChoose("quitApp", remember)}>退出应用</button>
      </div>
    </Modal>
  );
}

function Modal({ title, width, children, onClose }: { title: string; width: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" style={{ maxWidth: width }}><header><h2>{title}</h2><button className="icon-button" title="关闭" onClick={onClose}><X /></button></header><div className="modal-body">{children}</div></div></div>;
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>;
}

function ModelSelector({ value, options, placeholder, onChange }: { value: string; options: string[]; placeholder: string; onChange: (value: string) => void }) {
  const uniqueOptions = useMemo(() => [...new Set(options.filter(Boolean))], [options]);
  const [open, setOpen] = useState(false);
  const optionKey = uniqueOptions.join("\n");

  useEffect(() => {
    if (uniqueOptions.length === 0) setOpen(false);
  }, [optionKey, uniqueOptions.length]);

  const closeWhenFocusLeaves = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (!next || !event.currentTarget.contains(next as Node)) setOpen(false);
  };

  return (
    <div className="model-combobox" onBlur={closeWhenFocusLeaves}>
      <div className="model-combobox-shell">
        <input
          value={value}
          placeholder={placeholder}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === "ArrowDown" && uniqueOptions.length > 0) {
              event.preventDefault();
              setOpen(true);
            }
            if (event.key === "Escape") setOpen(false);
          }}
        />
        <button
          type="button"
          title={uniqueOptions.length ? "选择已拉取模型" : "还没有可选模型，请先拉取模型"}
          disabled={uniqueOptions.length === 0}
          onMouseDown={event => event.preventDefault()}
          onClick={() => setOpen(current => uniqueOptions.length > 0 ? !current : false)}
        >
          <ChevronDown />
        </button>
      </div>
      {open && uniqueOptions.length > 0 && (
        <div className="model-combobox-menu" role="listbox">
          {uniqueOptions.map(model => (
            <button
              key={model}
              type="button"
              className={model === value ? "selected" : ""}
              title={model}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                onChange(model);
                setOpen(false);
              }}
            >
              {model}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ icon, title, detail, action }: { icon: React.ReactNode; title: string; detail: string; action?: React.ReactNode }) {
  return <div className="empty-state">{icon}<strong>{title}</strong><p>{detail}</p>{action}</div>;
}

function blankRoute(connectionId: string): ModelRoute {
  return { id: crypto.randomUUID(), windsurfModelId: "", connectionId, model: "", thinkingMode: "", thinkingEffort: "", thinkingBudgetTokens: null };
}

function wireLabel(value?: WireApi) {
  if (value === "responses") return "OpenAI Responses";
  if (value === "anthropic") return "Anthropic Messages";
  return "OpenAI Chat";
}

function thinkingEffortLabel(value: ModelRoute["thinkingEffort"] | ThinkingEffort | "") {
  const labels: Record<string, string> = {
    default: "默认",
    none: "无",
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高"
  };
  return value ? labels[value] || value : "默认";
}

function formatTime(value: string) {
  try { return new Date(value).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return value; }
}

function configHash(value: AppConfig) {
  return JSON.stringify(value);
}

function stringifyDetail(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function logSearchText(entry: LogEntry) {
  return [
    entry.at,
    entry.level,
    entry.source,
    entry.operation,
    entry.requestId,
    entry.summary,
    entry.message,
    stringifyDetail(entry.detail),
    entry.rawRequest,
    entry.rawResponse
  ].filter(Boolean).join("\n");
}

function logRawText(entry: LogEntry) {
  const blocks = [
    `时间：${entry.at}`,
    `级别：${entry.level}`,
    `来源：${entry.source}`,
    entry.operation ? `操作：${entry.operation}` : "",
    entry.requestId ? `请求 ID：${entry.requestId}` : "",
    `摘要：${entry.summary || entry.message}`,
    entry.detail ? `\n结构化明细：\n${stringifyDetail(entry.detail)}` : "",
    entry.rawRequest ? `\n上游请求：\n${entry.rawRequest}` : "",
    entry.rawResponse ? `\n上游响应：\n${entry.rawResponse}` : ""
  ].filter(Boolean);
  if (!entry.detail && !entry.rawRequest && !entry.rawResponse) {
    blocks.push("\n这条日志没有更详细的原始信息。");
  }
  return blocks.join("\n");
}

function repairActionsFor(title: string, summary: string, detail = ""): MessageAction[] {
  const text = `${title}\n${summary}\n${detail}`;
  const actions: MessageAction[] = [];
  if (/密钥|API Key|接口地址|上游|模型|401|403|404|429|HTTP/i.test(text)) {
    actions.push({ label: "去连接管理", page: "connections" });
  }
  if (/端口|Node|Windsurf|环境|路径/i.test(text)) {
    actions.push({ label: "去环境诊断", page: "diagnostics" });
  }
  if (/补丁|patch/i.test(text)) {
    actions.push({ label: "安装补丁", run: "applyPatch" });
    if (!actions.some(action => action.page === "diagnostics")) {
      actions.push({ label: "去环境诊断", page: "diagnostics" });
    }
  }
  return actions.slice(0, 2);
}

function operationDialog(title: string, result: OperationResult): DialogState {
  const detail = JSON.stringify(result.detail, null, 2);
  return { kind: "message", title, summary: result.summary, detail, tone: result.ok ? "success" : "error", actions: result.ok ? [] : repairActionsFor(title, result.summary, detail) };
}

function testDialog(result: TestResult, title = "测试连接"): DialogState {
  const rawRequest = result.rawRequest ? `\n\n上游请求：\n${result.rawRequest}` : "";
  const rawResponse = result.rawResponse ? `\n\n上游响应：\n${result.rawResponse}` : result.raw ? `\n\n原始响应：\n${result.raw}` : "";
  const detail = [
    result.requestId ? `请求 ID：${result.requestId}` : "",
    `接口类型：${wireLabel(result.wireApi)}`,
    `请求模型：${result.requestModel}`,
    `返回模型：${result.returnedModel || "上游未返回 model 字段"}`,
    `耗时：${result.latencyMs} ms`,
    `实际思考强度：${result.thinkingEffort || "未返回"}`,
    `参数降级：${result.degraded ? "是" : "否"}`,
    rawRequest,
    rawResponse
  ].filter(Boolean).join("\n");
  return {
    kind: "message",
    title,
    tone: result.ok ? "success" : "error",
    summary: result.ok ? `连接成功，回复：${result.responseText || "（空）"}` : `上游返回 HTTP ${result.status}`,
    detail,
    actions: result.ok ? [] : repairActionsFor(title, `上游返回 HTTP ${result.status}`, detail)
  };
}

function discoverModelIds(logs: LogEntry[]) {
  const values = new Set<string>();
  const patterns = [
    /GetChatMessage\s+([A-Za-z0-9_.:-]+)\s+->/g,
    /"requestedModel"\s*:\s*"([^"]+)"/g,
    /"chat_model_uid"\s*:\s*"([^"]+)"/g
  ];
  for (const entry of logs) {
    const haystack = logSearchText(entry);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of haystack.matchAll(pattern)) {
        const value = match[1]?.trim();
        if (value && value !== "(none)") values.add(value);
      }
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

export default App;
