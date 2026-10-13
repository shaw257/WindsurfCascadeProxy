#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "windsurf-proxy-config.json");
const CONFIG = loadConfig(CONFIG_PATH);
const KNOWN_BUILDS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "known-windsurf-builds.json");
const KNOWN_BUILDS = loadConfig(KNOWN_BUILDS_PATH).builds || [];

const PATCHES = [
  {
    name: "api server context url",
    originalRegex: /([A-Za-z_$][\w$]*)\.getApiServerUrlFromContext=([A-Za-z_$][\w$]*)=>\{[\s\S]*?globalState\.get\([\s\S]*?return[\s\S]*?\}/,
    patchedCheck: (content, apiUrl) =>
      new RegExp(`\\.getApiServerUrlFromContext=[A-Za-z_$][\\w$]*=>\\{return"${escapeRegex(apiUrl)}"\\}`).test(content),
    apply: (content, apiUrl) =>
      content.replace(
        /([A-Za-z_$][\w$]*)\.getApiServerUrlFromContext=([A-Za-z_$][\w$]*)=>\{[\s\S]*?globalState\.get\([\s\S]*?return[\s\S]*?\}/,
        `$1.getApiServerUrlFromContext=$2=>{return"${apiUrl}"}`,
      ),
    reapply: (content, apiUrl) =>
      content.replace(
        /([A-Za-z_$][\w$]*)\.getApiServerUrlFromContext=([A-Za-z_$][\w$]*)=>\{return"https?:\/\/localhost:\d+"\}/,
        `$1.getApiServerUrlFromContext=$2=>{return"${apiUrl}"}`,
      ),
  },
  {
    name: "restart url",
    originalRegex: /async restart\(([A-Za-z_$][\w$]*)\)\{this\.apiServerUrl=\1,this\.inputs\.apiServerUrl=\1,/,
    patchedCheck: (content, apiUrl) =>
      new RegExp(`async restart\\([A-Za-z_$][\\w$]*\\)\\{[A-Za-z_$][\\w$]*="${escapeRegex(apiUrl)}",this\\.apiServerUrl=`).test(content),
    apply: (content, apiUrl) =>
      content.replace(
        /async restart\(([A-Za-z_$][\w$]*)\)\{this\.apiServerUrl=\1,this\.inputs\.apiServerUrl=\1,/,
        `async restart($1){$1="${apiUrl}",this.apiServerUrl=$1,this.inputs.apiServerUrl=$1,`,
      ),
    reapply: (content, apiUrl) =>
      content.replace(
        /async restart\(([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)="https?:\/\/localhost:\d+",this\.apiServerUrl=\2,this\.inputs\.apiServerUrl=\2,/,
        `async restart($1){$2="${apiUrl}",this.apiServerUrl=$2,this.inputs.apiServerUrl=$2,`,
      ),
  },
];

function loadConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const args = { action: argv[2] || "check" };
  for (let index = 3; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--windsurfPath") args.windsurfPath = argv[++index];
    else if (arg === "--apiUrl") args.apiUrl = argv[++index];
    else if (arg === "--extensionPath") args.extensionPath = argv[++index];
  }
  return args;
}

function findExtensionJs(windsurfPath) {
  const candidates = [];
  const addExe = exe => {
    if (!exe) return;
    candidates.push(path.join(path.dirname(exe), "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
  };

  addExe(windsurfPath);
  if (windsurfPath?.endsWith(".app")) {
    candidates.push(path.join(windsurfPath, "Contents", "Resources", "app", "extensions", "windsurf", "dist", "extension.js"));
  }
  addExe(CONFIG.windsurfPath);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    if (localAppData) {
      candidates.push(path.join(localAppData, "Programs", "Windsurf", "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
      candidates.push(path.join(localAppData, "Programs", "windsurf", "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
    }
    candidates.push(path.join(programFiles, "Windsurf", "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
    for (const drive of ["C", "D", "E", "F"]) {
      candidates.push(path.join(`${drive}:\\`, "Software", "Windsurf", "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
      candidates.push(path.join(`${drive}:\\`, "Windsurf", "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
      candidates.push(path.join(`${drive}:\\`, "windsurf", "resources", "app", "extensions", "windsurf", "dist", "extension.js"));
    }
  } else if (process.platform === "darwin") {
    const home = process.env.HOME || "";
    const appCandidates = [
      "/Applications/Windsurf.app",
      home ? path.join(home, "Applications", "Windsurf.app") : ""
    ].filter(Boolean);
    for (const appPath of appCandidates) {
      candidates.push(path.join(appPath, "Contents", "Resources", "app", "extensions", "windsurf", "dist", "extension.js"));
    }
  }

  return [...new Set(candidates)].find(candidate => fs.existsSync(candidate)) || null;
}

function findProductJson(extensionPath) {
  let dir = path.dirname(extensionPath);
  for (let index = 0; index < 10; index++) {
    const candidate = path.join(dir, "product.json");
    if (fs.existsSync(candidate)) return candidate;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

function productWithChecksum(raw, content) {
  const product = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const key = Object.keys(product.checksums || {}).find(item => item.includes("extensions/windsurf/dist/extension.js"));
  if (!key) throw new Error("product.json 中缺少 Windsurf 扩展校验项；未修改文件。");
  product.checksums[key] = crypto.createHash("sha256").update(content).digest("base64");
  return JSON.stringify(product, null, "\t");
}

function getBuildInfo(extensionPath, knownBuilds = KNOWN_BUILDS) {
  const productPath = findProductJson(extensionPath);
  let product = {};
  if (productPath) {
    try {
      product = JSON.parse(fs.readFileSync(productPath, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      product = {};
    }
  }
  const extensionSha256 = fs.existsSync(extensionPath)
    ? crypto.createHash("sha256").update(fs.readFileSync(extensionPath)).digest("hex")
    : "";
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
  const matched = knownBuilds.find(item =>
    item.extensionSha256 === extensionSha256
    && item.version === product.version
    && item.commit === product.commit
    && item.platform === platform
  );
  return {
    version: product.version || "",
    commit: product.commit || "",
    extensionSha256,
    known: Boolean(matched),
    platform: process.platform
  };
}

export function getStatus(extensionPath, apiUrl, knownBuilds = KNOWN_BUILDS) {
  if (!extensionPath || !fs.existsSync(extensionPath)) {
    return {
      ok: false,
      path: extensionPath || null,
      patches: PATCHES.map(patch => ({ name: patch.name, status: "missing" })),
    };
  }

  const content = fs.readFileSync(extensionPath, "utf8");
  const build = getBuildInfo(extensionPath, knownBuilds);
  let reason = "";
  try {
    const original = getOriginal(extensionPath, knownBuilds);
    build.known = true;
    build.originalSha256 = getBuildInfo(original.backupExists ? `${extensionPath}.native-proxy-bak` : extensionPath, knownBuilds).extensionSha256;
  } catch (error) {
    build.known = false;
    reason = error.message;
  }
  return {
    ok: true,
    path: extensionPath,
    backupPath: `${extensionPath}.native-proxy-bak`,
    build,
    reason,
    patches: PATCHES.map(patch => ({
      name: patch.name,
      status: !build.known ? "missing" : patch.patchedCheck(content, apiUrl) ? "applied" : patch.originalRegex.test(content) ? "available" : "missing",
    })),
  };
}

function patchContent(original, apiUrl) {
  let content = original;
  const details = [];
  let applied = 0;

  for (const patch of PATCHES) {
    if (patch.patchedCheck(content, apiUrl)) {
      details.push({ name: patch.name, result: "already-applied" });
      continue;
    }

    let next = patch.apply(content, apiUrl);
    if (next === content) next = patch.reapply(content, apiUrl);
    if (next === content) {
      throw new Error(`补丁规则不匹配：${patch.name}；未修改文件。`);
    } else {
      content = next;
      applied += 1;
      details.push({ name: patch.name, result: "applied" });
    }
  }

  return { content, applied, details };
}

function getOriginal(extensionPath, knownBuilds) {
  if (!extensionPath || !fs.existsSync(extensionPath)) throw new Error("未找到 extension.js。");
  const productPath = findProductJson(extensionPath);
  if (!productPath) throw new Error("未找到 product.json；未修改文件。");
  const current = fs.readFileSync(extensionPath, "utf8");
  const productCurrent = fs.readFileSync(productPath, "utf8");
  const backupPath = `${extensionPath}.native-proxy-bak`;
  const productBackupPath = `${productPath}.native-proxy-bak`;
  const backupExists = fs.existsSync(backupPath);
  const content = backupExists ? fs.readFileSync(backupPath, "utf8") : current;
  const productOriginal = fs.existsSync(productBackupPath) ? fs.readFileSync(productBackupPath, "utf8") : productCurrent;
  const baseline = getBuildInfo(backupExists ? backupPath : extensionPath, knownBuilds);
  if (!baseline.known) {
    throw new Error(`未知或已更新的 Windsurf 文件：version=${baseline.version || "unknown"} sha256=${baseline.extensionSha256}；禁止使用旧备份覆盖。`);
  }
  const product = JSON.parse(productCurrent.replace(/^\uFEFF/, ""));
  const originalProduct = JSON.parse(productOriginal.replace(/^\uFEFF/, ""));
  if (product.version !== originalProduct.version || product.commit !== originalProduct.commit) {
    throw new Error("Windsurf 已更新，补丁备份不属于当前版本；未修改文件。");
  }
  if (current !== content) {
    const existingUrl = current.match(/\.getApiServerUrlFromContext=[A-Za-z_$][\w$]*=>\{return"(http:\/\/localhost:\d+)"\}/)?.[1];
    if (!backupExists || !fs.existsSync(productBackupPath) || !existingUrl || patchContent(content, existingUrl).content !== current) {
      throw new Error("当前扩展已更新或被其他程序修改，不能使用旧备份安装或恢复补丁。");
    }
    if (JSON.stringify(product) !== JSON.stringify(JSON.parse(productWithChecksum(productOriginal, current)))) {
      throw new Error("product.json 已更新或被其他程序修改；未修改文件。");
    }
  } else if (productCurrent !== productOriginal) {
    throw new Error("补丁备份与当前 product.json 不一致；未修改文件。");
  }
  return { content, productOriginal, productPath, backupPath, productBackupPath, backupExists };
}

function atomicWrite(file, content) {
  const temporary = `${file}.native-proxy-tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writePair(extensionPath, content, productPath, productContent) {
  const before = fs.readFileSync(extensionPath, "utf8");
  const productBefore = fs.readFileSync(productPath, "utf8");
  try {
    atomicWrite(extensionPath, content);
    atomicWrite(productPath, productContent);
  } catch (error) {
    try {
      atomicWrite(extensionPath, before);
      atomicWrite(productPath, productBefore);
    } catch {
      throw new Error(`补丁写入和回滚失败，请保留 .native-proxy-bak 文件并重新安装 Windsurf：${error.message}`);
    }
    throw error;
  }
}

export function applyPatch(extensionPath, apiUrl, knownBuilds = KNOWN_BUILDS) {
  const port = Number(apiUrl?.match(/^http:\/\/localhost:(\d+)$/)?.[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("补丁地址必须是本机 localhost 的有效端口。");
  const original = getOriginal(extensionPath, knownBuilds);
  // Validate both patch rules and checksums before creating backups or changing files.
  const patched = patchContent(original.content, apiUrl);
  const productContent = productWithChecksum(original.productOriginal, patched.content);
  if (!original.backupExists) fs.copyFileSync(extensionPath, original.backupPath);
  if (!fs.existsSync(original.productBackupPath)) fs.copyFileSync(original.productPath, original.productBackupPath);
  writePair(extensionPath, patched.content, original.productPath, productContent);
  return { success: true, applied: patched.applied, failed: 0, details: patched.details, status: getStatus(extensionPath, apiUrl, knownBuilds) };
}

export function restorePatch(extensionPath, knownBuilds = KNOWN_BUILDS) {
  const original = getOriginal(extensionPath, knownBuilds);
  if (!original.backupExists) throw new Error("未找到当前版本的补丁备份。");
  writePair(extensionPath, original.content, original.productPath, original.productOriginal);
  fs.unlinkSync(original.backupPath);
  if (fs.existsSync(original.productBackupPath)) fs.unlinkSync(original.productBackupPath);
  return { success: true, restored: true, path: extensionPath };
}

const args = parseArgs(process.argv);
const apiUrl = args.apiUrl || `http://localhost:${CONFIG.port || 3009}`;
const extensionPath = args.extensionPath || findExtensionJs(args.windsurfPath);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  let result;
  if (args.action === "apply") result = applyPatch(extensionPath, apiUrl);
  else if (args.action === "restore") result = restorePatch(extensionPath);
  else result = getStatus(extensionPath, apiUrl);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message, path: extensionPath || null }, null, 2));
  process.exit(1);
}
