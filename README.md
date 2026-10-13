# Windsurf Cascade Proxy v0.2.0

通过本机代理，把 Windsurf 原生 Cascade 请求接入自己的上游 API。桌面界面使用 Tauri 2、React 和 TypeScript，原生后端使用 Rust，代理核心使用 Node.js。

这是旧 WinForms 公开版 v0.1.0 之后的新桌面主线；旧版代码和配置不包含在此项目内，也不自动导入旧版配置。此前 Tauri 开发版内部使用的 `0.5.0` 统一改为公开版本 `0.2.0`。

## 下载与运行

在 GitHub Releases 下载 `Windsurf.Cascade.Proxy_0.2.0_x64-setup.exe`，安装后从开始菜单打开。

- 当前发布 Windows x64 版，需要 Windows 10/11、Windsurf 和系统 Node.js 20+。
- 用户不需要安装 Rust，也不需要下载源码或手工准备代理脚本。
- 单独运行开发目录内的 EXE 时，需要把同目录的 `proxy-core/` 一起保留；安装包会自动安装这些资源。
- 当前安装包未做代码签名，系统可能显示未知发布者。下载后可与 Release 中的 SHA-256 校验值比对。
- macOS 后端代码仍是实验性实现，尚无实机验收和正式 DMG；默认构建禁用 macOS 补丁安装及恢复，当前版本不承诺可用。

## 主要功能

- 可复用的上游连接：接口地址、API 密钥、默认模型和思考设置。
- OpenAI Chat、OpenAI Responses、Anthropic Messages 兼容接口。
- Windsurf 模型 ID 路由，分别指定连接、模型和思考参数。
- 测试连接、从上游拉取并缓存模型、测试单条路由。
- 上游拒绝思考参数时移除参数并重试一次。
- 环境诊断、启动前检查、补丁安装和恢复。
- 摘要及原始运行日志、日志轮转、脱敏诊断包。
- 单实例、系统托盘，明确退出时停止本程序启动的代理。

## 首次设置

1. 在环境诊断中检查 Node.js 和 Windsurf 路径。
2. 在连接管理中填写接口地址、API 密钥和模型，先测试连接。拉取模型列表不需要先填写模型名。
3. 按需要添加模型路由。没有匹配路由时使用默认连接和默认模型。
4. 完全退出 Windsurf，再安装接管补丁，最后启动代理并打开 Windsurf。

本地端口默认是 `3009`，只监听 `127.0.0.1`。端口被占用时可在环境诊断中修改，不会自动结束其他程序。改端口后需要重新安装补丁并重启代理和 Windsurf。

补丁只允许 `packages/proxy-core/known-windsurf-builds.json` 中明确核验的版本、提交和扩展文件 SHA-256。当前规则记录了 Windsurf `1.110.1` 的一个 Windows 构建，并不意味着所有同名版本都兼容。更新后如哈希不同，程序会拒绝修改，不会用旧备份覆盖新版本。卸载本程序前建议先恢复补丁。

## 配置与日志

Windows 用户数据目录为 `%APPDATA%\cn.windsurf-cascade.proxy\`，具体路径以环境诊断页为准。

API 密钥按产品约定明文保存。配置原子替换，保留上一份有效的 `config.json.bak`；当前配置损坏且备份有效时会自动恢复，并保留损坏副本。无法恢复时显示错误，不会静默清空配置。

测试连接日志保留脱敏后的请求和响应。真实 Cascade 默认记录请求摘要，不保存完整对话上下文。诊断包仍可能包含接口地址、模型名和本机路径，分享前请检查。详见 [安全说明](SECURITY.md)。

## 开发与构建

构建环境使用 Node.js 24、Rust stable。Windows 还需要 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”组件和 WebView2。

```powershell
npm ci
npm test
npm run build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib
npm run tauri -- build --bundles nsis
```

完整桌面开发运行 `npm run tauri -- dev`。仅预览前端运行 `npm run dev`，浏览器访问 `http://127.0.0.1:1420`；浏览器模式使用模拟数据，不会执行补丁或启动真实代理。

NSIS 构建输出位于 `apps/desktop/src-tauri/target/release/bundle/nsis/`。显式指定 Rust target 时，位于对应的 `target/<target>/release/bundle/nsis/`。

## 项目目录

```text
apps/desktop/src/             React 界面
apps/desktop/src-tauri/       Rust 后端、Tauri 配置和图标
packages/proxy-core/         Node 代理、上游测试、补丁规则
packages/proxy-core/test/    本地模拟接口和补丁样本测试
docs/                       上传说明和本轮审查记录
release/                    本地发布文件，不加入源码仓库
```

查看 [更新记录](CHANGELOG.md)、[GitHub 上传说明](docs/GITHUB_UPLOAD.md) 和 [代码审查记录](docs/REVIEW-v0.2.0.md)。

本项目与 Windsurf、OpenAI、Anthropic 等厂商无隶属关系；不包含 Windsurf 原厂程序、其他软件的 EXE 或逆向研究资料。
