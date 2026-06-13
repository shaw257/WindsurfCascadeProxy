# GitHub 上传步骤

如果你只想用 GitHub 网页上传，建议使用已经整理好的干净上传目录：

```text
github-ready\WindsurfCascadeProxy-v0.1.0-GitHub-upload
```

把这个目录里面的所有文件和文件夹拖到 GitHub 仓库页面即可。

Release 附件使用：

```text
github-ready\WindsurfCascadeProxy-v0.1.0-Release-upload\WindsurfCascadeProxy-v0.1.0.exe
```

开发和构建用的完整目录是：

```text
github-ready\WindsurfCascadeProxy-v0.1.0
```

## 1. 创建仓库

在 GitHub 新建仓库，例如：

```text
WindsurfCascadeProxy
```

建议设置：

- Public
- 不勾选自动创建 README
- 不勾选自动创建 `.gitignore`
- 不勾选自动创建 License

因为这些文件本目录已经准备好了。

## 2. 上传文件

如果你不会用命令行，可以直接用 GitHub 网页上传：

1. 打开新仓库页面。
2. 点击 `uploading an existing file`。
3. 把 `github-ready\WindsurfCascadeProxy-v0.1.0` 里面的所有文件和文件夹拖进去。
4. 提交信息填写：

```text
Initial public release v0.1.0
```

上传完成后，仓库根目录至少应该能看到这些文件夹和文件：

```text
.github
assets
docs
src
tools
windsurf-protocol-runtime
README.md
LICENSE
SECURITY.md
CONTRIBUTING.md
build-polished-exe.ps1
windsurf-native-patch.mjs
windsurf-native-proxy.mjs
```

如果页面里只看到 `README.md`、`LICENSE`、`.mjs` 这些文件，看不到 `docs`、`assets`、`src` 等文件夹，说明文件夹没有上传完整，需要重新上传这些文件夹。

README 首页会引用：

```text
assets/app-screenshot.png
```

如果首页截图显示不出来，优先检查 `assets` 文件夹是否上传完整。

## 3. 创建 Release

上传源码后，进入 GitHub 仓库的 `Releases` 页面。

创建一个新 Release：

```text
Tag: v0.1.0
Title: Windsurf Cascade Proxy v0.1.0
```

Release 描述可以写：

```text
Initial public release of Windsurf Cascade Proxy.

Highlights:
- GUI configuration for Windsurf Cascade proxying.
- OpenAI Chat, OpenAI Responses, and Anthropic Messages upstream support.
- Per-model routing for Windsurf internal model IDs.
- Test connection, fetch model list, patch install/restore, and runtime logs.

Requirements:
- Windows 10/11
- Windsurf
- Node.js 18+
```

然后上传构建好的发布附件：

```text
github-ready\WindsurfCascadeProxy-v0.1.0-release-artifacts\WindsurfCascadeProxy-v0.1.0.exe
```

## 4. 上传前检查

不要上传这些内容：

- 任何真实 API Key。
- `windsurf-proxy-config.json`。
- `*.log`。
- `node_modules`。
- `dist` 目录。
- `github-ready\WindsurfCascadeProxy-v0.1.0-release-artifacts` 目录本身。
- 本地工具链或历史分析目录。

本目录的 `.gitignore` 已经覆盖这些常见情况。

## 5. 为什么 EXE 打开后会显示我的配置

程序启动时会优先读取你本机的配置文件：

```text
%LOCALAPPDATA%\WindsurfCascadeProxy\Runtime\windsurf-proxy-config.json
```

所以你在自己电脑上打开发布用 EXE，仍然可能看到之前保存过的接口地址、模型路由和 Windsurf 路径。这不代表这些配置被写进 EXE。

别人下载单独的 `WindsurfCascadeProxy-v0.1.0.exe` 后，不会自动拥有你的本机配置。

但请注意：不要把 `windsurf-proxy-config.json` 和 EXE 放在一起上传或打包。程序也会尝试读取 EXE 同目录或上一级目录里的同名配置文件。
