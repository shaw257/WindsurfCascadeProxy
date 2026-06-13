# 开发与构建

## 项目结构

```text
.
├─ src/WindsurfCascadeProxy/Program.cs
├─ windsurf-native-proxy.mjs
├─ windsurf-native-patch.mjs
├─ windsurf-protocol-runtime/
├─ assets/
├─ tools/build_icon.py
└─ build-polished-exe.ps1
```

说明：

- `Program.cs` 是 WinForms 图形界面。
- `windsurf-native-proxy.mjs` 是本机代理服务。
- `windsurf-native-patch.mjs` 负责安装和恢复 Windsurf 补丁。
- `windsurf-protocol-runtime` 中的文件会被嵌入 EXE，运行时释放到用户目录。
- `assets/cascade-proxy-icon.ico` 是 EXE 图标。

## 构建 EXE

在 Windows PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-polished-exe.ps1
```

生成：

```text
dist\WindsurfCascadeProxy.exe
```

## 检查代理脚本

```powershell
node --check .\windsurf-native-proxy.mjs
```

## 重新生成图标

如果安装了 Python 和 Pillow：

```powershell
python .\tools\build_icon.py
```

仓库已经包含生成好的 `.ico` 文件，普通构建不需要重新生成图标。


