# v0.2.0 本地代码审查

审查日期：2026-10-13。范围：Tauri 界面、Rust 原生后端、Node 代理与补丁、依赖锁定及 Windows 发布结构。旧 WinForms v0.1.0 未修改。

当前没有可供 Code Review 插件读取的 GitHub PR，本次是本地源代码审查、静态阅读、回归测试及构建检查，不是远程 PR 审查认证。

## 发布限制

- **macOS 实验分支存在未验收的恢复风险**：`apps/desktop/src-tauri/src/lib.rs` 的 `replace_macos_app` 原实现先删除目标应用再移动恢复副本，不具备可靠的失败回滚。完整应用备份、管理员授权、签名和恢复均未做实机验收。默认构建已禁用 macOS 补丁安装及恢复，实验实现只保留在需明确启用的 Cargo feature 后，不能宣传 macOS 已可用。
- **原生 Cascade 实机回归仍需执行**：当前自动化覆盖上游连接测试及代理控制接口，不等于已覆盖所有流式响应、工具调用和各厂商真实模型行为。发布前建议用目标 Windsurf 构建完成一次真实对话、工具调用、托盘和退出检查。

## 已修复的发现

1. **P1：旧补丁备份可能覆盖更新后的 Windsurf，部分规则失败仍写文件。** 原安装流程从备份重新生成扩展，仅凭版本/提交放行，未确认当前文件仍属于该备份。现在核对平台、版本、提交、原始哈希及可重复生成的补丁内容；未知或外部修改拒绝操作，两条规则及校验项全部通过后才写入，写入失败尝试回滚。恢复也核验同一基线。位置：`packages/proxy-core/patch.mjs`，`getOriginal`、`applyPatch`、`restorePatch`。

2. **P1：Windows 配置替换存在先删除原文件的空窗，损坏配置不会读取备份。** 原实现删文件再 rename，初始化失败又被加载屏幕遮住。现在使用 Windows 原子替换，写入前同步临时文件；保留上一份有效备份，恢复时不覆盖好备份，损坏原件另存副本，无可用备份则显示错误和重试入口。Node 热加载读到坏配置时保留当前运行设置，不再静默切换为空配置。位置：`apps/desktop/src-tauri/src/lib.rs`，`read_config_with_recovery`、`write_config_atomic_unlocked`、`replace_config_file`；`apps/desktop/src/App.tsx` 初始化错误界面；`packages/proxy-core/app-config.mjs` 的 `readConfig`。

3. **P1：结构化日志详情及诊断包对非 sk- 形式密钥保护不足。** 现在对完整日志条目，包括嵌套 `detail` 和原始信息，按已配置密钥统一脱敏；支持 JSON 转义的密钥，导出时再次按实际密钥过滤。位置：`apps/desktop/src-tauri/src/lib.rs`，`sanitize_log_entry`、`export_diagnostics`；`packages/proxy-core/server.mjs` 的 `emitLogEntry`。

   **补充的本地访问风险**：原 HTTP 服务没有 Host/Origin 检查，在浏览器能够访问回环服务或发生 DNS 重绑定的环境中，不可信网页可能命中代理。现在拒绝非回环 Host、外站和 opaque Origin，保留无 Origin 的原生请求、同端口本机页面及明确的编辑器协议 Origin。测试覆盖拒绝与同源放行；真实 Cascade 仍需验收。不将这些检查宣传为防御同用户恶意本机程序的鉴权机制。

4. **P2：耗时同步命令及托盘启停阻塞窗口线程。** 环境检测、预检、启动等待、补丁及导出移到后台执行；托盘启停使用后台任务；生命周期锁避免托盘和主窗口同时启动多个代理；控制操作读取成功响应后才确认热加载。托盘操作结果会触发状态刷新。位置：`apps/desktop/src-tauri/src/lib.rs`，`detect_environment`、`start_proxy`、`setup_tray`、`send_control`。

5. **P2：路由的空预算被解释为 0，降级后仍显示原思考强度。** 保持 `null` 表示继承、显式 `0` 表示覆盖；无思考参数重试成功后显示默认强度。位置：`packages/proxy-core/app-config.mjs` 的 `normalizeRoute`；`packages/proxy-core/upstream.mjs` 的 `testUpstream`。

6. **P2：侧栏运行摘要显示正在编辑的连接，而非默认连接。** 侧栏改为显示默认连接，切换编辑对象不再造成运行信息误读。前端监听器在异步注册期间卸载时也会解除，避免重复回调。位置：`apps/desktop/src/App.tsx` 的 `defaultConnection` 和初始化 effect。

7. **构建依赖安全公告。** npm 官方审计原报告 4 个 high、1 个 moderate，涉及 browserslist、nanoid、PostCSS、source-map-js、baseline-browser-mapping。仅更新兼容修复版本及必需的数据依赖，不做框架大版本升级；下载包按官方 SHA-512 核验并验证锁文件离线从零安装。更新后官方 npm 审计返回 0 条公告。该结果仅针对 npm 当前公告，不代表 Rust 或所有未知安全问题均已审计。

## 验证记录

- Node 回归测试：18 项通过。覆盖路由继承、配置损坏拒绝、密钥脱敏、补丁安装/端口变更/完整恢复/旧备份拒绝/未知哈希拒绝/部分规则失败拒绝、三种上游测试协议、模型列表、思考参数降级、Host/Origin 限制、控制鉴权、热加载、端口变更保留监听及版本一致性。
- Rust 单元测试：5 项通过。覆盖 Windows 配置原子替换、损坏及缺失配置的备份恢复、无备份错误保留原件、嵌套日志及转义密钥脱敏。
- TypeScript 类型检查及 Vite 生产构建通过。
- Windows EXE 产品版本为 `0.2.0`；实际 WebView 页面检查显示 `v0.2.0` 并完成初始化，随后通过自身退出命令关闭。只读检查没有执行配置保存、代理启动或补丁操作。不能用 `APPDATA` 环境变量覆盖 Windows Known Folder 来隔离数据，因此没有把此检查当作隔离的原生代理启停测试。
- 使用本地模拟上游；未调用真实付费 API，未安装或恢复本机 Windsurf 补丁。
- 常见密钥、访问令牌及私钥标识的源码扫描无命中；测试密钥仅为测试占位值。扫描不是对任何格式密钥的绝对保证。
- Rust Clippy 组件未安装，未声称通过 Clippy 或 RustSec 审计。

## 上传边界

源码不包含 `node_modules`、编译缓存、EXE、个人配置、日志、旧版项目、第三方程序和研究资料。公开 Release 提供 Windows NSIS 安装包及 SHA-256，不将依赖松散资源的开发 EXE 宣称为单文件便携版。未自动创建、提交或推送 GitHub 仓库。
