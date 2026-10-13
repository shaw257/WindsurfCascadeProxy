use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
#[cfg(all(target_os = "macos", feature = "experimental-macos-patching"))]
use sysinfo::Disks;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WindowEvent,
};
use uuid::Uuid;
#[cfg(all(target_os = "macos", feature = "experimental-macos-patching"))]
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, ZipWriter};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
static CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
const LOG_LIMIT: usize = 2_000;
const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;
const LOG_KEEP_FILES: usize = 4;

#[derive(Default)]
struct AppState {
    proxy: Mutex<Option<ManagedProxy>>,
    logs: Mutex<VecDeque<LogEntry>>,
    quitting: Mutex<bool>,
    lifecycle: Mutex<()>,
}

struct ManagedProxy {
    child: Arc<Mutex<Child>>,
    pid: u32,
    instance_id: String,
    control_token: String,
    port: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThinkingSettings {
    thinking_mode: String,
    thinking_effort: String,
    thinking_budget_tokens: i64,
}

impl Default for ThinkingSettings {
    fn default() -> Self {
        Self {
            thinking_mode: "default".into(),
            thinking_effort: "default".into(),
            thinking_budget_tokens: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionProfile {
    id: String,
    name: String,
    provider_template: String,
    base_url: String,
    api_key: String,
    wire_api: String,
    default_model: String,
    #[serde(default)]
    fetched_models: Vec<String>,
    models_fetched_at: Option<String>,
    #[serde(flatten)]
    thinking: ThinkingSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelRoute {
    id: String,
    windsurf_model_id: String,
    connection_id: String,
    model: String,
    thinking_mode: String,
    thinking_effort: String,
    thinking_budget_tokens: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettings {
    default_connection_id: String,
    node_path: String,
    windsurf_path: String,
    port: u16,
    launch_windsurf_on_start: bool,
    #[serde(default)]
    close_behavior: String,
    #[serde(default)]
    log_full_upstream_traffic: bool,
    #[serde(default)]
    minimize_to_tray_on_close: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    schema_version: u32,
    onboarding_completed: bool,
    connections: Vec<ConnectionProfile>,
    routes: Vec<ModelRoute>,
    runtime: RuntimeSettings,
}

impl Default for AppConfig {
    fn default() -> Self {
        let id = Uuid::new_v4().to_string();
        Self {
            schema_version: 1,
            onboarding_completed: false,
            connections: vec![ConnectionProfile {
                id: id.clone(),
                name: "自定义连接".into(),
                provider_template: "custom".into(),
                base_url: String::new(),
                api_key: String::new(),
                wire_api: "chat".into(),
                default_model: String::new(),
                fetched_models: Vec::new(),
                models_fetched_at: None,
                thinking: ThinkingSettings::default(),
            }],
            routes: Vec::new(),
            runtime: RuntimeSettings {
                default_connection_id: id,
                node_path: String::new(),
                windsurf_path: String::new(),
                port: 3009,
                launch_windsurf_on_start: true,
                close_behavior: "ask".into(),
                log_full_upstream_traffic: false,
                minimize_to_tray_on_close: true,
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    at: String,
    level: String,
    source: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_response: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeInfo {
    found: bool,
    path: String,
    version: String,
    supported: bool,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentReport {
    app_version: String,
    platform: String,
    architecture: String,
    node: NodeInfo,
    windsurf_found: bool,
    windsurf_path: String,
    port_available: bool,
    port_owner: Option<Value>,
    proxy_running: bool,
    proxy_pid: Option<u32>,
    config_path: String,
    data_directory: String,
    patch: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult {
    ok: bool,
    summary: String,
    detail: Value,
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    read_or_default_config(&app)
}

#[tauri::command(async)]
fn save_config(
    app: AppHandle,
    state: State<AppState>,
    mut config: AppConfig,
) -> Result<OperationResult, String> {
    normalize_app_config(&mut config);
    validate_config(&config)?;
    let path = config_path(&app)?;
    let old_port = read_config_if_valid(&path).map(|item| item.runtime.port);
    write_config_atomic(&path, &config)?;
    append_log(&app, &state, "info", "app", "配置已保存。");

    let mut detail = json!({ "configPath": path, "hotReloaded": false, "portChanged": old_port.is_some_and(|port| port != config.runtime.port) });
    if old_port == Some(config.runtime.port) {
        if let Some(proxy) = state.proxy.lock().map_err(lock_error)?.as_ref() {
            if send_control(proxy.port, &proxy.control_token, "/control/reload").is_ok() {
                detail["hotReloaded"] = json!(true);
            }
        }
    }
    Ok(OperationResult {
        ok: true,
        summary: "配置已保存".into(),
        detail,
    })
}

#[tauri::command(async)]
fn detect_environment(app: AppHandle, state: State<AppState>) -> Result<EnvironmentReport, String> {
    let config = read_or_default_config(&app)?;
    let node = detect_node(&config.runtime.node_path);
    let windsurf = detect_windsurf(&config.runtime.windsurf_path);
    let proxy = proxy_snapshot(&state)?;
    let patch = if node.found && windsurf.is_some() {
        run_patch_command(
            &app,
            &node.path,
            windsurf.as_deref().unwrap_or(""),
            config.runtime.port,
            "check",
        )
        .unwrap_or_else(|error| json!({ "ok": false, "error": error }))
    } else {
        json!({ "ok": false, "error": "缺少 Node.js 或 Windsurf 路径" })
    };
    let port_available = proxy
        .as_ref()
        .is_some_and(|item| item.1 == config.runtime.port)
        || TcpListener::bind(("127.0.0.1", config.runtime.port)).is_ok();
    let port_owner = if port_available {
        None
    } else {
        find_port_owner(config.runtime.port)
    };
    Ok(EnvironmentReport {
        app_version: APP_VERSION.into(),
        platform: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        node,
        windsurf_found: windsurf.is_some(),
        windsurf_path: windsurf.unwrap_or_default(),
        port_available,
        port_owner,
        proxy_running: proxy.is_some(),
        proxy_pid: proxy.map(|item| item.0),
        config_path: config_path(&app)?.display().to_string(),
        data_directory: app_data_dir(&app)?.display().to_string(),
        patch,
    })
}

#[tauri::command(async)]
fn preflight(app: AppHandle, state: State<AppState>) -> Result<OperationResult, String> {
    let config = read_or_default_config(&app)?;
    validate_config(&config)?;
    validate_launch_config(&config)?;
    let node = detect_node(&config.runtime.node_path);
    if !node.supported {
        return Ok(failed("Node.js 不可用", json!({ "node": node })));
    }
    let windsurf = detect_windsurf(&config.runtime.windsurf_path);
    if windsurf.is_none() {
        return Ok(failed(
            "没有找到 Windsurf",
            json!({ "action": "select-windsurf" }),
        ));
    }
    let proxy = proxy_snapshot(&state)?;
    if proxy.is_none() && TcpListener::bind(("127.0.0.1", config.runtime.port)).is_err() {
        return Ok(failed(
            "本地端口已被其他程序占用",
            json!({ "port": config.runtime.port, "owner": find_port_owner(config.runtime.port) }),
        ));
    }
    let patch = run_patch_command(
        &app,
        &node.path,
        windsurf.as_deref().unwrap_or(""),
        config.runtime.port,
        "check",
    )?;
    let ready = patch
        .get("patches")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items
                .iter()
                .all(|item| item.get("status") == Some(&json!("applied")))
        });
    Ok(OperationResult {
        ok: ready,
        summary: if ready {
            "启动条件已满足"
        } else {
            "需要安装或更新补丁"
        }
        .into(),
        detail: json!({ "node": node, "windsurfPath": windsurf, "patch": patch, "requiresPatchConfirmation": !ready }),
    })
}

#[tauri::command(async)]
fn start_proxy(app: AppHandle, state: State<AppState>) -> Result<OperationResult, String> {
    let _lifecycle = state.lifecycle.lock().map_err(lock_error)?;
    if *state.quitting.lock().map_err(lock_error)? {
        return Err("应用正在退出，不能启动代理。".into());
    }
    let config = read_or_default_config(&app)?;
    validate_config(&config)?;
    validate_launch_config(&config)?;
    {
        let mut guard = state.proxy.lock().map_err(lock_error)?;
        if let Some(managed) = guard.as_mut() {
            if managed
                .child
                .lock()
                .map_err(lock_error)?
                .try_wait()
                .map_err(display_error)?
                .is_none()
            {
                return Ok(OperationResult {
                    ok: true,
                    summary: "代理已经在运行".into(),
                    detail: json!({ "pid": managed.pid, "port": managed.port }),
                });
            }
            *guard = None;
        }
    }
    if TcpListener::bind(("127.0.0.1", config.runtime.port)).is_err() {
        return Ok(failed(
            "端口已被其他程序占用",
            json!({ "port": config.runtime.port, "owner": find_port_owner(config.runtime.port) }),
        ));
    }

    let node = detect_node(&config.runtime.node_path);
    if !node.supported {
        return Ok(failed("Node.js 20+ 不可用", json!({ "node": node })));
    }
    let config_path = config_path(&app)?;
    let proxy_core = proxy_core_dir(&app)?;
    let cli = proxy_core.join("cli.mjs");
    ensure_script_file(&cli)?;
    let instance_id = Uuid::new_v4().to_string();
    let control_token = Uuid::new_v4().simple().to_string();
    let mut command = Command::new(&node.path);
    command
        .current_dir(&proxy_core)
        .arg("cli.mjs")
        .args(["serve", "--config"])
        .arg(&config_path)
        .args(["--instance", &instance_id, "--token", &control_token])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 Node 代理失败：{error}"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    *state.proxy.lock().map_err(lock_error)? = Some(ManagedProxy {
        child: child.clone(),
        pid,
        instance_id: instance_id.clone(),
        control_token,
        port: config.runtime.port,
    });
    if let Some(stdout) = stdout {
        stream_child_output(app.clone(), "proxy", stdout, false);
    }
    if let Some(stderr) = stderr {
        stream_child_output(app.clone(), "proxy", stderr, true);
    }
    if let Err(error) = wait_for_proxy_health(
        config.runtime.port,
        &instance_id,
        &child,
        Duration::from_secs(8),
    ) {
        let _ = stop_managed_proxy(&app, &state);
        append_log(&app, &state, "error", "app", &error);
        return Ok(failed(
            "代理启动失败",
            json!({ "pid": pid, "port": config.runtime.port, "error": error }),
        ));
    }
    append_log(
        &app,
        &state,
        "info",
        "app",
        &format!("代理已启动，PID {pid}，端口 {}。", config.runtime.port),
    );
    Ok(OperationResult {
        ok: true,
        summary: "代理已启动".into(),
        detail: json!({ "pid": pid, "port": config.runtime.port, "instanceId": instance_id }),
    })
}

#[tauri::command(async)]
fn stop_proxy(app: AppHandle, state: State<AppState>) -> Result<OperationResult, String> {
    let _lifecycle = state.lifecycle.lock().map_err(lock_error)?;
    stop_managed_proxy(&app, &state)?;
    Ok(OperationResult {
        ok: true,
        summary: "代理已停止".into(),
        detail: json!({}),
    })
}

#[tauri::command]
async fn test_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: Option<String>,
    windsurf_model_id: Option<String>,
) -> Result<Value, String> {
    match run_node_json_command(app.clone(), "test", connection_id, windsurf_model_id).await {
        Ok(value) => {
            append_structured_log(
                &app,
                &state,
                structured_log_from_value("info", "test", "test_connection", &value),
            );
            Ok(value)
        }
        Err(error) => {
            append_structured_log(
                &app,
                &state,
                LogEntry {
                    at: Local::now().to_rfc3339(),
                    level: "error".into(),
                    source: "test".into(),
                    message: format!("测试连接失败：{error}"),
                    operation: Some("test_connection".into()),
                    request_id: None,
                    summary: Some(format!("测试连接失败：{error}")),
                    detail: Some(json!({ "error": error })),
                    raw_request: None,
                    raw_response: None,
                },
            );
            Err(error)
        }
    }
}

#[tauri::command]
async fn fetch_models(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Value, String> {
    match run_node_json_command(app.clone(), "models", Some(connection_id), None).await {
        Ok(value) => {
            append_structured_log(
                &app,
                &state,
                structured_log_from_value("info", "models", "fetch_models", &value),
            );
            Ok(value)
        }
        Err(error) => {
            append_structured_log(
                &app,
                &state,
                LogEntry {
                    at: Local::now().to_rfc3339(),
                    level: "error".into(),
                    source: "models".into(),
                    message: format!("拉取模型列表失败：{error}"),
                    operation: Some("fetch_models".into()),
                    request_id: None,
                    summary: Some(format!("拉取模型列表失败：{error}")),
                    detail: Some(json!({ "error": error })),
                    raw_request: None,
                    raw_response: None,
                },
            );
            Err(error)
        }
    }
}

#[tauri::command(async)]
fn check_patch(app: AppHandle) -> Result<Value, String> {
    patch_action(&app, "check")
}

#[tauri::command(async)]
fn apply_patch(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
    let result = patch_action_with_platform_safety(&app, "apply")?;
    append_log(&app, &state, "info", "patch", "Windsurf 补丁已安装。");
    Ok(result)
}

#[tauri::command(async)]
fn restore_patch(app: AppHandle, state: State<AppState>) -> Result<Value, String> {
    let result = patch_action_with_platform_safety(&app, "restore")?;
    append_log(&app, &state, "info", "patch", "Windsurf 补丁已恢复。");
    Ok(result)
}

#[tauri::command]
fn open_windsurf(app: AppHandle) -> Result<(), String> {
    let config = read_or_default_config(&app)?;
    let path = detect_windsurf(&config.runtime.windsurf_path).ok_or("没有找到 Windsurf。")?;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-a").arg(path);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new(path);
    command.spawn().map_err(display_error)?;
    Ok(())
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(display_error)?;
    }
    Ok(())
}

#[tauri::command]
fn get_logs(state: State<AppState>) -> Result<Vec<LogEntry>, String> {
    Ok(state
        .logs
        .lock()
        .map_err(lock_error)?
        .iter()
        .cloned()
        .collect())
}

#[tauri::command]
fn clear_logs(app: AppHandle, state: State<AppState>, delete_files: bool) -> Result<(), String> {
    state.logs.lock().map_err(lock_error)?.clear();
    if delete_files {
        let dir = app_data_dir(&app)?.join("logs");
        if dir.exists() {
            for entry in fs::read_dir(dir).map_err(display_error)? {
                let path = entry.map_err(display_error)?.path();
                if path.is_file() {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
    app.emit("logs-cleared", ()).map_err(display_error)
}

#[tauri::command(async)]
fn export_diagnostics(app: AppHandle, destination: String) -> Result<String, String> {
    let output = PathBuf::from(destination);
    let config = read_or_default_config(&app)?;
    let secrets: Vec<String> = config
        .connections
        .iter()
        .map(|item| item.api_key.clone())
        .collect();
    let sanitized = sanitize_config(config);
    let file = File::create(&output).map_err(display_error)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("config.sanitized.json", options)
        .map_err(display_error)?;
    zip.write_all(
        redact_text(
            &serde_json::to_string_pretty(&sanitized).map_err(display_error)?,
            &secrets,
        )
        .as_bytes(),
    )
    .map_err(display_error)?;
    let log_dir = app_data_dir(&app)?.join("logs");
    if log_dir.exists() {
        for entry in fs::read_dir(log_dir).map_err(display_error)? {
            let path = entry.map_err(display_error)?.path();
            if !path.is_file() {
                continue;
            }
            let name = format!(
                "logs/{}",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            zip.start_file(name, options).map_err(display_error)?;
            let text = fs::read_to_string(path).unwrap_or_default();
            zip.write_all(redact_text(&text, &secrets).as_bytes())
                .map_err(display_error)?;
        }
    }
    zip.finish().map_err(display_error)?;
    Ok(output.display().to_string())
}

#[tauri::command(async)]
fn app_quit(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().map_err(lock_error)?;
    *state.quitting.lock().map_err(lock_error)? = true;
    stop_managed_proxy(&app, &state)?;
    app.exit(0);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .manage(AppState::default())
        .setup(|app| {
            fs::create_dir_all(app_data_dir(app.handle())?)?;
            setup_tray(app)?;
            let handle = app.handle().clone();
            app.get_webview_window("main")
                .expect("main window")
                .on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = handle.state::<AppState>();
                        if !*state.quitting.lock().unwrap_or_else(|e| e.into_inner()) {
                            api.prevent_close();
                            let close_behavior = read_or_default_config(&handle)
                                .map(|config| config.runtime.close_behavior)
                                .unwrap_or_else(|_| "ask".into());
                            match close_behavior.as_str() {
                                "minimizeToTray" => {
                                    if let Some(window) = handle.get_webview_window("main") {
                                        let _ = window.hide();
                                    }
                                }
                                "quitApp" => {
                                    let app = handle.clone();
                                    tauri::async_runtime::spawn_blocking(move || {
                                        let state = app.state::<AppState>();
                                        let _ = app_quit(app.clone(), state);
                                    });
                                }
                                _ => {
                                    let _ = handle.emit("request-exit-confirmation", ());
                                }
                            }
                        }
                    }
                });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            detect_environment,
            preflight,
            start_proxy,
            stop_proxy,
            test_connection,
            fetch_models,
            check_patch,
            apply_patch,
            restore_patch,
            open_windsurf,
            hide_main_window,
            get_logs,
            clear_logs,
            export_diagnostics,
            app_quit
        ])
        .run(tauri::generate_context!())
        .expect("error while running Windsurf Cascade Proxy");
}

fn validate_config(config: &AppConfig) -> Result<(), String> {
    if config.schema_version != 1 {
        return Err("不支持的配置版本。".into());
    }
    if config.connections.is_empty() {
        return Err("至少需要一个上游连接。".into());
    }
    if !(1024..=65535).contains(&config.runtime.port) {
        return Err("本地端口必须在 1024 到 65535 之间。".into());
    }
    if !config
        .connections
        .iter()
        .any(|item| item.id == config.runtime.default_connection_id)
    {
        return Err("默认连接不存在。".into());
    }
    for connection in &config.connections {
        if connection.name.trim().is_empty() {
            return Err("连接名称不能为空。".into());
        }
        if !["chat", "responses", "anthropic"].contains(&connection.wire_api.as_str()) {
            return Err(format!("连接“{}”的接口类型无效。", connection.name));
        }
    }
    Ok(())
}

fn validate_launch_config(config: &AppConfig) -> Result<(), String> {
    let default_connection = config
        .connections
        .iter()
        .find(|item| item.id == config.runtime.default_connection_id)
        .or_else(|| config.connections.first());
    if let Some(connection) = default_connection {
        if connection.base_url.trim().is_empty() {
            return Err(format!("连接“{}”缺少接口地址。", connection.name));
        }
        if connection.api_key.trim().is_empty() {
            return Err(format!("连接“{}”缺少 API 密钥。", connection.name));
        }
        if connection.default_model.trim().is_empty() {
            return Err(format!("连接“{}”缺少默认模型。", connection.name));
        }
    }
    for route in &config.routes {
        let connection = config
            .connections
            .iter()
            .find(|item| item.id == route.connection_id);
        if let Some(connection) = connection {
            if connection.base_url.trim().is_empty() {
                return Err(format!(
                    "模型路由“{}”的连接缺少接口地址。",
                    route.windsurf_model_id
                ));
            }
            if connection.api_key.trim().is_empty() {
                return Err(format!(
                    "模型路由“{}”的连接缺少 API 密钥。",
                    route.windsurf_model_id
                ));
            }
        }
        let has_effective_model = !route.model.trim().is_empty()
            || connection.is_some_and(|item| !item.default_model.trim().is_empty());
        if !has_effective_model {
            return Err(format!(
                "模型路由“{}”缺少中转模型。",
                route.windsurf_model_id
            ));
        }
    }
    Ok(())
}

fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(display_error)
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("config.json"))
}

fn proxy_core_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(display_error)?
        .join("proxy-core");
    if bundled.join("cli.mjs").exists() {
        return Ok(bundled);
    }
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/proxy-core");
    Ok(development.canonicalize().unwrap_or(development))
}

fn read_or_default_config<R: Runtime>(app: &AppHandle<R>) -> Result<AppConfig, String> {
    let path = config_path(app)?;
    read_config_with_recovery(&path)
}

fn read_config_with_recovery(path: &Path) -> Result<AppConfig, String> {
    let _guard = CONFIG_FILE_LOCK.lock().map_err(lock_error)?;
    if let Some(config) = read_config_if_valid(path) {
        return Ok(config);
    }
    if let Some(config) = read_config_if_valid(&path.with_extension("json.bak")) {
        if path.exists() {
            fs::copy(
                path,
                path.with_extension(format!("json.corrupt-{}", Uuid::new_v4())),
            )
            .map_err(display_error)?;
        }
        write_config_atomic_unlocked(path, &config)?;
        return Ok(config);
    }
    if path.exists() {
        return Err(format!(
            "配置文件损坏，且没有可用备份。原文件已保留，请检查：{}",
            path.display()
        ));
    }
    let config = AppConfig::default();
    write_config_atomic_unlocked(path, &config)?;
    Ok(config)
}

fn read_config_if_valid(path: &Path) -> Option<AppConfig> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .and_then(|mut config| {
            normalize_app_config(&mut config);
            validate_config(&config).ok().map(|_| config)
        })
}

fn normalize_app_config(config: &mut AppConfig) {
    let close_behavior = config.runtime.close_behavior.as_str();
    if !matches!(close_behavior, "ask" | "minimizeToTray" | "quitApp") {
        config.runtime.close_behavior = if config.runtime.minimize_to_tray_on_close {
            "minimizeToTray".into()
        } else {
            "ask".into()
        };
    }
    config.runtime.minimize_to_tray_on_close = config.runtime.close_behavior == "minimizeToTray";
}

fn write_config_atomic(path: &Path, config: &AppConfig) -> Result<(), String> {
    let _guard = CONFIG_FILE_LOCK.lock().map_err(lock_error)?;
    write_config_atomic_unlocked(path, config)
}

fn write_config_atomic_unlocked(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(display_error)?;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let backup = path.with_extension("json.bak");
    let content = serde_json::to_vec_pretty(config).map_err(display_error)?;
    {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(display_error)?;
        file.write_all(&content).map_err(display_error)?;
        file.sync_all().map_err(display_error)?;
    }
    if read_config_if_valid(path).is_some() {
        fs::copy(path, &backup).map_err(display_error)?;
    }
    replace_config_file(&temporary, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(display_error)?;
    }
    Ok(())
}

#[cfg(windows)]
fn replace_config_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_config_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(display_error)
}

fn detect_node(preferred: &str) -> NodeInfo {
    let mut candidates = Vec::new();
    if !preferred.trim().is_empty() {
        candidates.push(PathBuf::from(preferred.trim()));
    }
    if let Some(found) = command_path("node") {
        candidates.push(found);
    }
    #[cfg(windows)]
    {
        candidates.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs/nodejs/node.exe"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ]);
        let mut command = Command::new("/bin/zsh");
        command.args(["-lic", "command -v node"]);
        hide_console(&mut command);
        if let Ok(output) = command.output() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                candidates.push(PathBuf::from(value));
            }
        }
    }
    candidates.sort();
    candidates.dedup();
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let mut command = Command::new(&candidate);
        command.arg("--version");
        hide_console(&mut command);
        if let Ok(output) = command.output() {
            let version = String::from_utf8_lossy(&output.stdout)
                .trim()
                .trim_start_matches('v')
                .to_string();
            let major = version
                .split('.')
                .next()
                .and_then(|item| item.parse::<u32>().ok())
                .unwrap_or(0);
            return NodeInfo {
                found: true,
                path: candidate.display().to_string(),
                version,
                supported: major >= 20,
                detail: if major >= 20 {
                    "Node.js 版本符合要求".into()
                } else {
                    "需要 Node.js 20 或更高版本".into()
                },
            };
        }
    }
    NodeInfo {
        found: false,
        path: String::new(),
        version: String::new(),
        supported: false,
        detail: "没有找到 Node.js".into(),
    }
}

fn command_path(command: &str) -> Option<PathBuf> {
    let locator = if cfg!(windows) { "where" } else { "which" };
    let mut lookup = Command::new(locator);
    lookup.arg(command);
    hide_console(&mut lookup);
    lookup.output().ok().and_then(|output| {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .map(|line| PathBuf::from(line.trim()))
    })
}

fn detect_windsurf(preferred: &str) -> Option<String> {
    let mut candidates = Vec::new();
    if !preferred.trim().is_empty() {
        candidates.push(PathBuf::from(preferred.trim()));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs/Windsurf/Windsurf.exe"));
        }
        candidates.push(PathBuf::from(r"C:\Program Files\Windsurf\Windsurf.exe"));
        for drive in ["C", "D", "E", "F"] {
            candidates.push(PathBuf::from(format!(
                r"{drive}:\Software\Windsurf\Windsurf.exe"
            )));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/Windsurf.app"));
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications/Windsurf.app"));
        }
    }
    candidates
        .into_iter()
        .find(|item| item.exists())
        .map(|item| item.display().to_string())
}

fn run_patch_command<R: Runtime>(
    app: &AppHandle<R>,
    node: &str,
    windsurf: &str,
    port: u16,
    action: &str,
) -> Result<Value, String> {
    let proxy_core = proxy_core_dir(app)?;
    let script = proxy_core.join("patch.mjs");
    ensure_script_file(&script)?;
    let mut command = Command::new(node);
    command
        .current_dir(&proxy_core)
        .arg("patch.mjs")
        .arg(action)
        .args([
            "--windsurfPath",
            windsurf,
            "--apiUrl",
            &format!("http://localhost:{port}"),
        ]);
    hide_console(&mut command);
    let output = command.output().map_err(display_error)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(redact_text(
            if stderr.trim().is_empty() {
                &stdout
            } else {
                &stderr
            },
            &[],
        ));
    }
    serde_json::from_str(stdout.trim())
        .map_err(|error| format!("补丁工具返回无效数据：{error}\n{stdout}"))
}

fn patch_action<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<Value, String> {
    let config = read_or_default_config(app)?;
    let node = detect_node(&config.runtime.node_path);
    if !node.supported {
        return Err(node.detail);
    }
    let windsurf = detect_windsurf(&config.runtime.windsurf_path).ok_or("没有找到 Windsurf。")?;
    run_patch_command(app, &node.path, &windsurf, config.runtime.port, action)
}

#[cfg(not(target_os = "macos"))]
fn patch_action_with_platform_safety<R: Runtime>(
    app: &AppHandle<R>,
    action: &str,
) -> Result<Value, String> {
    patch_action(app, action)
}

#[cfg(all(target_os = "macos", not(feature = "experimental-macos-patching")))]
fn patch_action_with_platform_safety<R: Runtime>(
    _app: &AppHandle<R>,
    _action: &str,
) -> Result<Value, String> {
    Err("macOS 补丁安装和恢复尚未完成实机验收，当前默认构建已禁用这些操作。".into())
}

#[cfg(all(target_os = "macos", feature = "experimental-macos-patching"))]
fn patch_action_with_platform_safety<R: Runtime>(
    app: &AppHandle<R>,
    action: &str,
) -> Result<Value, String> {
    let config = read_or_default_config(app)?;
    let node = detect_node(&config.runtime.node_path);
    if !node.supported {
        return Err(node.detail);
    }
    let windsurf =
        PathBuf::from(detect_windsurf(&config.runtime.windsurf_path).ok_or("没有找到 Windsurf。")?);
    if Command::new("pgrep")
        .args(["-x", "Windsurf"])
        .status()
        .map(|item| item.success())
        .unwrap_or(false)
    {
        return Err("请先完全退出 Windsurf，再执行补丁操作。".into());
    }
    let backup = app_data_dir(app)?.join("backups/Windsurf.app");
    if action == "apply" && !backup.exists() {
        ensure_macos_backup_space(&windsurf, &app_data_dir(app)?)?;
        fs::create_dir_all(backup.parent().unwrap()).map_err(display_error)?;
        let status = Command::new("ditto")
            .arg(&windsurf)
            .arg(&backup)
            .status()
            .map_err(display_error)?;
        if !status.success() {
            return Err("完整备份 Windsurf.app 失败。".into());
        }
        let verify = Command::new("codesign")
            .args([
                "--verify",
                "--deep",
                "--strict",
                backup.to_string_lossy().as_ref(),
            ])
            .status()
            .map_err(display_error)?;
        if !verify.success() {
            return Err("Windsurf.app 备份完成，但签名校验失败；未继续安装补丁。".into());
        }
    }
    if action == "restore" {
        if !backup.exists() {
            return Err("没有找到完整的 Windsurf.app 备份。".into());
        }
        let temporary = windsurf.with_extension("app.restore");
        let _ = fs::remove_dir_all(&temporary);
        let status = Command::new("ditto")
            .arg(&backup)
            .arg(&temporary)
            .status()
            .map_err(display_error)?;
        if !status.success() {
            return Err("准备恢复副本失败。".into());
        }
        replace_macos_app(&temporary, &windsurf)?;
        return Ok(json!({ "success": true, "restored": true, "path": windsurf }));
    }
    let result = run_patch_command(
        app,
        &node.path,
        &windsurf.display().to_string(),
        config.runtime.port,
        action,
    )?;
    let status = Command::new("codesign")
        .args([
            "--force",
            "--deep",
            "--sign",
            "-",
            "--preserve-metadata=entitlements,requirements,flags,runtime",
            windsurf.to_string_lossy().as_ref(),
        ])
        .status()
        .map_err(display_error)?;
    if !status.success() {
        return Err("补丁已写入，但本机临时签名失败；请立即恢复补丁。".into());
    }
    let verify = Command::new("codesign")
        .args([
            "--verify",
            "--deep",
            "--strict",
            windsurf.to_string_lossy().as_ref(),
        ])
        .status()
        .map_err(display_error)?;
    if !verify.success() {
        return Err("Windsurf.app 签名验证失败；请恢复补丁。".into());
    }
    Ok(result)
}

#[cfg(all(target_os = "macos", feature = "experimental-macos-patching"))]
fn ensure_macos_backup_space(source: &Path, target_dir: &Path) -> Result<(), String> {
    let source_bytes = WalkDir::new(source)
        .into_iter()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .filter(|metadata| metadata.is_file())
        .fold(0_u64, |total, metadata| {
            total.saturating_add(metadata.len())
        });
    let reserve = source_bytes
        .saturating_add(source_bytes / 5)
        .saturating_add(512 * 1024 * 1024);
    let target = target_dir
        .canonicalize()
        .unwrap_or_else(|_| target_dir.to_path_buf());
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .ok_or("无法读取备份目标磁盘的剩余空间。")?;
    if disk.available_space() < reserve {
        return Err(format!(
            "磁盘空间不足：完整备份至少需要约 {:.1} GB 可用空间。",
            reserve as f64 / 1024_f64.powi(3)
        ));
    }
    Ok(())
}

#[cfg(all(target_os = "macos", feature = "experimental-macos-patching"))]
fn replace_macos_app(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("Windsurf.app 路径无效。")?;
    let script = format!(
        "rm -rf {dst} && mv {src} {dst}",
        src = shell_quote(source),
        dst = shell_quote(destination)
    );
    if fs::metadata(parent)
        .map(|item| !item.permissions().readonly())
        .unwrap_or(false)
    {
        return Command::new("/bin/sh")
            .args(["-c", &script])
            .status()
            .map_err(display_error)
            .and_then(|status| {
                if status.success() {
                    Ok(())
                } else {
                    Err("恢复 Windsurf.app 失败。".into())
                }
            });
    }
    let escaped = script.replace('\\', "\\\\").replace('"', "\\\"");
    let status = Command::new("osascript")
        .args([
            "-e",
            &format!("do shell script \"{escaped}\" with administrator privileges"),
        ])
        .status()
        .map_err(display_error)?;
    if status.success() {
        Ok(())
    } else {
        Err("管理员授权失败，未能恢复 Windsurf.app。".into())
    }
}

#[cfg(all(target_os = "macos", feature = "experimental-macos-patching"))]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

async fn run_node_json_command<R: Runtime>(
    app: AppHandle<R>,
    command_name: &'static str,
    connection_id: Option<String>,
    route_id: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = read_or_default_config(&app)?;
        let node = detect_node(&config.runtime.node_path);
        if !node.supported {
            return Err(node.detail);
        }
        let proxy_core = proxy_core_dir(&app)?;
        let cli = proxy_core.join("cli.mjs");
        ensure_script_file(&cli)?;
        let mut command = Command::new(&node.path);
        command
            .current_dir(&proxy_core)
            .arg("cli.mjs")
            .arg(command_name)
            .args(["--config", config_path(&app)?.to_string_lossy().as_ref()]);
        if let Some(id) = connection_id {
            command.args(["--connection", &id]);
        }
        if let Some(id) = route_id {
            command.args(["--route", &id]);
        }
        hide_console(&mut command);
        let output = command.output().map_err(display_error)?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let line = stdout
            .lines()
            .rev()
            .find(|line| line.trim_start().starts_with('{'))
            .ok_or_else(|| format!("Node 工具没有返回结果。\n{}", redact_text(&stderr, &[])))?;
        let value: Value = serde_json::from_str(line).map_err(display_error)?;
        if !output.status.success() || value.get("event") == Some(&json!("error")) {
            return Err(value
                .pointer("/data/message")
                .and_then(Value::as_str)
                .unwrap_or("上游操作失败")
                .to_string());
        }
        Ok(value.get("data").cloned().unwrap_or(value))
    })
    .await
    .map_err(display_error)?
}

fn ensure_script_file(path: &Path) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("找不到 Node 运行脚本：{}", path.display()))
    }
}

fn structured_log_from_value(
    level: &str,
    source: &str,
    operation: &str,
    value: &Value,
) -> LogEntry {
    let request_id = value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let raw_request = value
        .get("rawRequest")
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .map(|item| redact_text(item, &[]));
    let raw_response = value
        .get("rawResponse")
        .or_else(|| value.get("raw"))
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .map(|item| redact_text(item, &[]));
    let summary = match operation {
        "test_connection" => {
            let ok = value.get("ok").and_then(Value::as_bool).unwrap_or(false);
            let model = value
                .get("requestModel")
                .and_then(Value::as_str)
                .unwrap_or("");
            let status = value.get("status").and_then(Value::as_i64).unwrap_or(0);
            let latency = value.get("latencyMs").and_then(Value::as_i64).unwrap_or(0);
            if ok {
                format!("测试连接成功：{model}，{latency} ms")
            } else {
                format!("测试连接失败：HTTP {status}，{latency} ms")
            }
        }
        "fetch_models" => {
            let count = value
                .get("models")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            let latency = value.get("latencyMs").and_then(Value::as_i64).unwrap_or(0);
            format!("从上游拉取模型完成：{count} 个，{latency} ms")
        }
        _ => value
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("操作完成")
            .to_string(),
    };
    LogEntry {
        at: Local::now().to_rfc3339(),
        level: level.into(),
        source: source.into(),
        message: summary.clone(),
        operation: Some(operation.into()),
        request_id,
        summary: Some(summary),
        detail: Some(value.clone()),
        raw_request,
        raw_response,
    }
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.is_empty())
        .map(|item| redact_text(item, &[]))
}

fn stream_child_output<R: Runtime, T: Read + Send + 'static>(
    app: AppHandle<R>,
    source: &'static str,
    stream: T,
    error_stream: bool,
) {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            let mut level = if error_stream {
                "error".to_string()
            } else {
                "info".to_string()
            };
            let mut message = line.clone();
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("event") == Some(&json!("log_entry")) {
                    let data = value.get("data").unwrap_or(&Value::Null);
                    let entry = LogEntry {
                        at: value
                            .get("at")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| Local::now().to_rfc3339()),
                        level: data
                            .get("level")
                            .and_then(Value::as_str)
                            .unwrap_or("info")
                            .to_string(),
                        source: data
                            .get("source")
                            .and_then(Value::as_str)
                            .unwrap_or(source)
                            .to_string(),
                        message: redact_text(
                            data.get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string()
                                .as_str(),
                            &[],
                        ),
                        operation: optional_string(data, "operation"),
                        request_id: optional_string(data, "requestId"),
                        summary: optional_string(data, "summary"),
                        detail: data.get("detail").cloned().filter(|item| !item.is_null()),
                        raw_request: optional_string(data, "rawRequest"),
                        raw_response: optional_string(data, "rawResponse"),
                    };
                    push_log_entry(&app, entry);
                    continue;
                } else if value.get("event") == Some(&json!("log")) {
                    level = value
                        .pointer("/data/level")
                        .and_then(Value::as_str)
                        .unwrap_or("info")
                        .to_string();
                    message = value
                        .pointer("/data/message")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                } else {
                    message = format!(
                        "[{}] {}",
                        value
                            .get("event")
                            .and_then(Value::as_str)
                            .unwrap_or("event"),
                        value.get("data").unwrap_or(&Value::Null)
                    );
                }
            }
            let entry = LogEntry {
                at: Local::now().to_rfc3339(),
                level,
                source: source.into(),
                message: redact_text(&message, &[]),
                operation: None,
                request_id: None,
                summary: None,
                detail: None,
                raw_request: None,
                raw_response: None,
            };
            push_log_entry(&app, entry);
        }
    });
}

fn append_log<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<AppState>,
    level: &str,
    source: &str,
    message: &str,
) {
    let entry = LogEntry {
        at: Local::now().to_rfc3339(),
        level: level.into(),
        source: source.into(),
        message: redact_text(message, &[]),
        operation: None,
        request_id: None,
        summary: None,
        detail: None,
        raw_request: None,
        raw_response: None,
    };
    append_structured_log(app, state, entry);
}

fn append_structured_log<R: Runtime>(app: &AppHandle<R>, state: &State<AppState>, entry: LogEntry) {
    let entry = sanitize_log_entry(app, entry);
    if let Ok(mut logs) = state.logs.lock() {
        logs.push_back(entry.clone());
        while logs.len() > LOG_LIMIT {
            logs.pop_front();
        }
    }
    let _ = write_log_entry(app, &entry);
    let _ = app.emit("log-line", entry);
}

fn push_log_entry<R: Runtime>(app: &AppHandle<R>, entry: LogEntry) {
    let entry = sanitize_log_entry(app, entry);
    let state = app.state::<AppState>();
    if let Ok(mut logs) = state.logs.lock() {
        logs.push_back(entry.clone());
        while logs.len() > LOG_LIMIT {
            logs.pop_front();
        }
    }
    let _ = write_log_entry(app, &entry);
    let _ = app.emit("log-line", entry);
}

fn write_log_entry<R: Runtime>(app: &AppHandle<R>, entry: &LogEntry) -> Result<(), String> {
    let dir = app_data_dir(app)?.join("logs");
    fs::create_dir_all(&dir).map_err(display_error)?;
    let path = dir.join("application.log");
    rotate_logs(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(display_error)?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(entry).map_err(display_error)?
    )
    .map_err(display_error)
}

fn rotate_logs(path: &Path) -> Result<(), String> {
    if path.metadata().map(|item| item.len()).unwrap_or(0) < LOG_ROTATE_BYTES {
        return Ok(());
    }
    for index in (1..LOG_KEEP_FILES).rev() {
        let from = path.with_extension(format!("log.{index}"));
        let to = path.with_extension(format!("log.{}", index + 1));
        if from.exists() {
            let _ = fs::rename(from, to);
        }
    }
    fs::rename(path, path.with_extension("log.1")).map_err(display_error)
}

fn stop_managed_proxy<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<AppState>,
) -> Result<(), String> {
    let managed = state.proxy.lock().map_err(lock_error)?.take();
    if let Some(proxy) = managed {
        let _ = send_control(proxy.port, &proxy.control_token, "/control/shutdown");
        thread::sleep(Duration::from_millis(250));
        let mut child = proxy.child.lock().map_err(lock_error)?;
        if child.try_wait().map_err(display_error)?.is_none() {
            child.kill().map_err(display_error)?;
        }
        let _ = child.wait();
        append_log(
            app,
            state,
            "info",
            "app",
            &format!(
                "代理进程 {}（实例 {}）已停止。",
                proxy.pid, proxy.instance_id
            ),
        );
    }
    Ok(())
}

fn send_control(port: u16, token: &str, endpoint: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().map_err(display_error)?,
        Duration::from_millis(500),
    )
    .map_err(display_error)?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(display_error)?;
    let request = format!(
        "POST {endpoint} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-control-token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(display_error)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1000)))
        .map_err(display_error)?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(display_error)?;
    if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err("代理未确认控制操作成功。".into())
    }
}

fn wait_for_proxy_health(
    port: u16,
    instance_id: &str,
    child: &Arc<Mutex<Child>>,
    timeout: Duration,
) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .lock()
            .map_err(lock_error)?
            .try_wait()
            .map_err(display_error)?
        {
            return Err(format!("代理进程提前退出：{status}"));
        }
        let last_error = match read_proxy_health(port) {
            Ok(health) => {
                let healthy = health.get("ok").and_then(Value::as_bool) == Some(true);
                let actual_instance = health
                    .get("instance_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if healthy && actual_instance == instance_id {
                    return Ok(health);
                }
                if actual_instance.is_empty() {
                    "健康检查未返回实例标识".into()
                } else {
                    format!("端口由其他代理实例占用：{actual_instance}")
                }
            }
            Err(error) => error,
        };
        if Instant::now() >= deadline {
            return Err(format!("等待代理就绪超时：{last_error}"));
        }
        thread::sleep(Duration::from_millis(120));
    }
}

fn read_proxy_health(port: u16) -> Result<Value, String> {
    let address = format!("127.0.0.1:{port}").parse().map_err(display_error)?;
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_millis(350)).map_err(display_error)?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(display_error)?;
    stream
        .set_write_timeout(Some(Duration::from_millis(350)))
        .map_err(display_error)?;
    let request =
        format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(display_error)?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(display_error)?;
    if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
        return Err(response
            .lines()
            .next()
            .unwrap_or("健康检查返回异常状态")
            .to_string());
    }
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .ok_or("健康检查响应格式无效")?;
    serde_json::from_str(body).map_err(display_error)
}

fn proxy_snapshot(state: &State<AppState>) -> Result<Option<(u32, u16)>, String> {
    let mut guard = state.proxy.lock().map_err(lock_error)?;
    if let Some(proxy) = guard.as_mut() {
        if proxy
            .child
            .lock()
            .map_err(lock_error)?
            .try_wait()
            .map_err(display_error)?
            .is_none()
        {
            return Ok(Some((proxy.pid, proxy.port)));
        }
        *guard = None;
    }
    Ok(None)
}

#[cfg(windows)]
fn find_port_owner(port: u16) -> Option<Value> {
    let mut netstat = Command::new("netstat");
    netstat.args(["-ano", "-p", "tcp"]);
    hide_console(&mut netstat);
    let output = netstat.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{port}");
    let pid = text.lines().find_map(|line| {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 {
            return None;
        }
        let local = columns.get(1)?;
        let state = columns.get(3).copied().unwrap_or("");
        if local.ends_with(&suffix) && state.eq_ignore_ascii_case("LISTENING") {
            columns.last()?.parse::<u32>().ok()
        } else {
            None
        }
    })?;
    let process_name = process_name_for_pid(pid).unwrap_or_default();
    Some(json!({ "pid": pid, "processName": process_name }))
}

#[cfg(not(windows))]
fn find_port_owner(_port: u16) -> Option<Value> {
    None
}

#[cfg(windows)]
fn process_name_for_pid(pid: u32) -> Option<String> {
    let mut tasklist = Command::new("tasklist");
    tasklist.args(["/fi", &format!("PID eq {pid}"), "/fo", "csv", "/nh"]);
    hide_console(&mut tasklist);
    let output = tasklist.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next()?.trim();
    if first.is_empty()
        || first
            .eq_ignore_ascii_case("INFO: No tasks are running which match the specified criteria.")
    {
        return None;
    }
    first
        .trim_matches('"')
        .split("\",\"")
        .next()
        .map(str::to_string)
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start-proxy", "启动代理", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop-proxy", "停止代理", true, None::<&str>)?;
    let open_windsurf_item =
        MenuItem::with_id(app, "open-windsurf", "打开 Windsurf", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &open_windsurf_item, &quit])?;
    let app_handle = app.handle().clone();
    TrayIconBuilder::with_id("main-tray")
        .icon(
            app.default_window_icon()
                .cloned()
                .expect("application icon"),
        )
        .tooltip("Windsurf Cascade 代理")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "start-proxy" | "stop-proxy" | "open-windsurf" | "quit" => {
                let action = event.id.as_ref().to_string();
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app.state::<AppState>();
                    let result = match action.as_str() {
                        "start-proxy" => start_proxy(app.clone(), state).and_then(|result| {
                            if result.ok {
                                Ok(())
                            } else {
                                Err(result.summary)
                            }
                        }),
                        "stop-proxy" => stop_proxy(app.clone(), state).map(|_| ()),
                        "open-windsurf" => open_windsurf(app.clone()),
                        _ => app_quit(app.clone(), state),
                    };
                    if let Err(error) = result {
                        let state = app.state::<AppState>();
                        append_log(
                            &app,
                            &state,
                            "error",
                            "app",
                            &format!("托盘操作失败：{error}"),
                        );
                        let _ = app.emit("tray-operation-error", error);
                    }
                    let _ = app.emit("proxy-state-changed", ());
                });
            }
            _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(&app_handle);
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn sanitize_config(mut config: AppConfig) -> AppConfig {
    for connection in &mut config.connections {
        connection.api_key = "[REDACTED]".into();
    }
    config
}

fn sanitize_log_entry<R: Runtime>(app: &AppHandle<R>, entry: LogEntry) -> LogEntry {
    let secrets = config_path(app)
        .ok()
        .and_then(|path| read_config_if_valid(&path))
        .map(|config| {
            config
                .connections
                .into_iter()
                .map(|item| item.api_key)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::to_string(&entry)
        .ok()
        .and_then(|raw| serde_json::from_str(&redact_text(&raw, &secrets)).ok())
        .unwrap_or(entry)
}

fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut output = text.to_string();
    for secret in secrets.iter().filter(|item| !item.is_empty()) {
        output = output.replace(secret, "[REDACTED]");
        if let Ok(encoded) = serde_json::to_string(secret) {
            let escaped = &encoded[1..encoded.len() - 1];
            output = output.replace(escaped, "[REDACTED]");
        }
    }
    static PATTERNS: OnceLock<Vec<regex::Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r#"(?i)(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+"#,
            r#"(?i)(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+"#,
            r"\bsk-[A-Za-z0-9_-]{12,}\b",
        ]
        .iter()
        .filter_map(|pattern| regex::Regex::new(pattern).ok())
        .collect()
    });
    for pattern in patterns {
        output = pattern.replace_all(&output, "$1[REDACTED]").to_string();
    }
    output
}

fn failed(summary: &str, detail: Value) -> OperationResult {
    OperationResult {
        ok: false,
        summary: summary.into(),
        detail,
    }
}

fn display_error<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}
fn lock_error<E: std::fmt::Display>(error: E) -> String {
    format!("内部状态锁定失败：{error}")
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("cascade-config-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn config(&self) -> PathBuf {
            self.0.join("config.json")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn corrupt_config_recovers_from_valid_backup_without_destroying_it() {
        let dir = TestDirectory::new();
        let path = dir.config();
        let mut config = AppConfig::default();
        config.connections[0].default_model = "backup-model".into();
        write_config_atomic(&path, &config).unwrap();
        config.connections[0].default_model = "new-model".into();
        write_config_atomic(&path, &config).unwrap();
        let backup = fs::read(path.with_extension("json.bak")).unwrap();
        fs::write(&path, "{").unwrap();
        assert_eq!(
            read_config_with_recovery(&path).unwrap().connections[0].default_model,
            "backup-model"
        );
        assert_eq!(fs::read(path.with_extension("json.bak")).unwrap(), backup);
        assert!(fs::read_dir(&dir.0).unwrap().any(|item| item
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("corrupt-")));
    }

    #[test]
    fn missing_config_recovers_existing_backup() {
        let dir = TestDirectory::new();
        let path = dir.config();
        let config = AppConfig::default();
        fs::write(
            path.with_extension("json.bak"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_config_with_recovery(&path)
                .unwrap()
                .runtime
                .default_connection_id,
            config.runtime.default_connection_id
        );
        assert!(path.exists());
    }

    #[test]
    fn corrupt_config_without_backup_is_preserved_and_reports_an_error() {
        let dir = TestDirectory::new();
        let path = dir.config();
        fs::write(&path, "not valid JSON").unwrap();
        assert!(read_config_with_recovery(&path).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "not valid JSON");
    }

    #[test]
    fn atomic_replacement_preserves_previous_configuration() {
        let dir = TestDirectory::new();
        let path = dir.config();
        let mut config = AppConfig::default();
        write_config_atomic(&path, &config).unwrap();
        config.runtime.port = 3010;
        write_config_atomic(&path, &config).unwrap();
        assert_eq!(read_config_if_valid(&path).unwrap().runtime.port, 3010);
        assert_eq!(
            read_config_if_valid(&path.with_extension("json.bak"))
                .unwrap()
                .runtime
                .port,
            3009
        );
        assert!(!fs::read_dir(&dir.0).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "tmp")));
    }

    #[test]
    fn log_redaction_covers_nested_details_and_json_escaped_keys() {
        let secret = "custom-key\\with\"quotes".to_string();
        let raw = serde_json::to_string(
            &json!({ "detail": { "echoed": secret }, "authorization": "Bearer another-key" }),
        )
        .unwrap();
        let redacted = redact_text(&raw, &[secret]);
        let parsed: Value = serde_json::from_str(&redacted).unwrap();
        assert_eq!(parsed["detail"]["echoed"], "[REDACTED]");
        assert!(!redacted.contains("another-key"));
    }
}
