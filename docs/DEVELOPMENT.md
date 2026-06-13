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

## 发布流程

1. 修改 `Program.cs` 里的 `AppVersion` 和文件顶部的 `AssemblyVersion` / `AssemblyFileVersion` / `AssemblyInformationalVersion`。
2. 运行 `node --check .\windsurf-native-proxy.mjs`。
3. 运行 `.\build-polished-exe.ps1 -OutputName WindsurfCascadeProxy-v0.1.0.exe`。
4. 手动启动 EXE，检查：
   - 程序能打开。
   - 图标显示正常。
   - 测试连接按钮可用。
   - 启动和停止代理无异常。
5. 检查 EXE 文件版本：

```powershell
(Get-Item .\dist\WindsurfCascadeProxy-v0.1.0.exe).VersionInfo | Select-Object FileVersion, ProductVersion, ProductName
```

6. 在 GitHub Release 中上传 `dist\WindsurfCascadeProxy-v0.1.0.exe`。


