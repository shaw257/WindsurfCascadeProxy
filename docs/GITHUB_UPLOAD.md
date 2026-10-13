# GitHub 上传说明

## 源码仓库

只上传本 Tauri 项目，不上传工作区根目录，也不把旧 WinForms、其他软件或研究资料混进来。

已整理 `WindsurfCascadeProxy-v0.2.0-GitHub-upload/` 作为干净源码目录，可直接选取其中全部内容上传；另一个 `WindsurfCascadeProxy-v0.2.0-Release-upload/` 只用于 Release 附件。不要把两个文件夹一起作为源码上传。

如果通过 Git 提交，`.gitignore` 会排除 `node_modules/`、编译目录、`release/`、EXE、日志和个人配置。若通过 GitHub 网页拖拽上传，忽略规则不会替你筛选，需只选择以下内容：

- `apps/desktop/src/`、`apps/desktop/index.html`、前端 package/TypeScript/Vite 配置。
- `apps/desktop/src-tauri/src/`、`icons/`、`capabilities/`、`build.rs`、Cargo.toml、Cargo.lock、tauri.conf.json。
- `packages/proxy-core/`，包含测试，不包含个人配置、日志或补丁备份。
- 根目录 package.json、package-lock.json、.gitignore、README.md、CHANGELOG.md、LICENSE、SECURITY.md、CONTRIBUTING.md、`docs/` 和 `.github/`。

不要上传 `apps/desktop/dist/`、`apps/desktop/src-tauri/target/`、`apps/desktop/src-tauri/gen/`、任何用户配置、`.env`、密钥或损坏配置副本。

## Release

创建 GitHub Release，标签填写 `v0.2.0`，标题建议 `Windsurf Cascade Proxy v0.2.0`。

上传本地 `release/` 内的安装包 `Windsurf Cascade Proxy_0.2.0_x64-setup.exe` 和 `SHA256SUMS.txt`，把 `RELEASE_NOTES-v0.2.0.md` 的正文放入 Release 描述。不生成 ZIP。

面向普通用户只提供安装包即可。不要把开发用的单独 EXE 作为“独立单文件版”发布，它依赖同目录的 `proxy-core/` 资源。

当前使用仓库 `shaw257/WindsurfCascadeProxy`。保留 `v0.1.0` 标签和旧版 Release，新的 `v0.2.0` 指向 Tauri 源码。

沿用旧仓库时，请在保留旧版标签后，用新源码结构替换主分支的旧版内容，不要叠加两套根目录构建文件。原 WinForms 构建流水线也需要移除或改成 Tauri 构建，不能原样沿用。

## 上传前最后检查

1. 用新安装包实际安装并打开，确认界面版本 `0.2.0`。
2. 使用自己的连接测试一次，检查模型列表、路由及原生 Cascade。
3. 测试最小化至托盘、停止代理和退出，无本程序启动的 Node 进程残留。
4. 确认 Release 中只承诺 Windows x64；macOS 仍待实机验收。
5. 检查上传清单，无密钥、日志、用户配置或原厂 Windsurf 文件。
