param(
  [string]$OutputName = "WindsurfCascadeProxy.exe"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$Dist = Join-Path $Root "dist"
$Out = Join-Path $Dist $OutputName
$Source = Join-Path $Root "src\WindsurfCascadeProxy\Program.cs"
$Icon = Join-Path $Root "assets\cascade-proxy-icon.ico"

if (-not (Test-Path -LiteralPath $Csc)) {
  throw "csc.exe was not found: $Csc"
}
if (-not (Test-Path -LiteralPath $Source)) {
  throw "Source file was not found: $Source"
}
if (-not (Test-Path -LiteralPath $Icon)) {
  throw "Application icon was not found: $Icon"
}

New-Item -ItemType Directory -Path $Dist -Force | Out-Null

$resources = @(
  @((Join-Path $Root "windsurf-native-proxy.mjs"), "runtime.windsurf-native-proxy.mjs"),
  @((Join-Path $Root "windsurf-native-patch.mjs"), "runtime.windsurf-native-patch.mjs"),
  @((Join-Path $Root "windsurf-protocol-runtime\resources\proxy-scripts\src\proto.js"), "runtime.protocol.proto.js"),
  @((Join-Path $Root "windsurf-protocol-runtime\resources\proxy-scripts\src\connect.js"), "runtime.protocol.connect.js"),
  @((Join-Path $Root "windsurf-protocol-runtime\resources\proxy-scripts\src\handlers\parse-request.js"), "runtime.protocol.parse-request.js"),
  @((Join-Path $Root "windsurf-protocol-runtime\resources\proxy-scripts\src\handlers\build-response.js"), "runtime.protocol.build-response.js"),
  @((Join-Path $Root "windsurf-protocol-runtime\resources\proxy-scripts\src\handlers\tool-normalization.js"), "runtime.protocol.tool-normalization.js")
)

$args = @(
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/codepage:65001",
  "/out:$Out",
  "/win32icon:$Icon",
  "/reference:System.dll",
  "/reference:System.Core.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Web.Extensions.dll"
)

foreach ($resource in $resources) {
  $file = $resource[0]
  $name = $resource[1]
  if (-not (Test-Path -LiteralPath $file)) {
    throw "Resource file was not found: $file"
  }
  $args += "/resource:$file,$name"
}

$args += $Source

& $Csc @args
if ($LASTEXITCODE -ne 0) {
  throw "csc.exe failed with exit code $LASTEXITCODE"
}

Get-Item -LiteralPath $Out | Select-Object FullName, Length, LastWriteTime
