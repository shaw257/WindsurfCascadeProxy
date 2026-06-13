#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "windsurf-proxy-config.json");
const CONFIG = loadConfig(CONFIG_PATH);

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

function updateChecksum(extensionPath) {
  const productPath = findProductJson(extensionPath);
  if (!productPath) return false;

  let raw = fs.readFileSync(productPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const product = JSON.parse(raw);
  if (!product.checksums) return false;

  const key = Object.keys(product.checksums).find(item => item.includes("extensions/windsurf/dist/extension.js") || item.includes("extension.js"));
  if (!key) return false;

  product.checksums[key] = crypto.createHash("sha256").update(fs.readFileSync(extensionPath)).digest("base64");
  fs.writeFileSync(productPath, JSON.stringify(product, null, "\t"), "utf8");
  return true;
}

function getStatus(extensionPath, apiUrl) {
  if (!extensionPath || !fs.existsSync(extensionPath)) {
    return {
      ok: false,
      path: extensionPath || null,
      patches: PATCHES.map(patch => ({ name: patch.name, status: "missing" })),
    };
  }

  const content = fs.readFileSync(extensionPath, "utf8");
  return {
    ok: true,
    path: extensionPath,
    backupPath: `${extensionPath}.native-proxy-bak`,
    patches: PATCHES.map(patch => ({
      name: patch.name,
      status: patch.patchedCheck(content, apiUrl) ? "applied" : patch.originalRegex.test(content) ? "available" : "missing",
    })),
  };
}

function applyPatch(extensionPath, apiUrl) {
  if (!extensionPath || !fs.existsSync(extensionPath)) throw new Error("extension.js not found");
  const backupPath = `${extensionPath}.native-proxy-bak`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(extensionPath, backupPath);

  let content = fs.readFileSync(backupPath, "utf8");
  const details = [];
  let applied = 0;
  let failed = 0;

  for (const patch of PATCHES) {
    if (patch.patchedCheck(content, apiUrl)) {
      details.push({ name: patch.name, result: "already-applied" });
      continue;
    }

    let next = patch.apply(content, apiUrl);
    if (next === content) next = patch.reapply(content, apiUrl);
    if (next === content) {
      failed += 1;
      details.push({ name: patch.name, result: "failed" });
    } else {
      content = next;
      applied += 1;
      details.push({ name: patch.name, result: "applied" });
    }
  }

  if (applied > 0) {
    fs.writeFileSync(extensionPath, content, "utf8");
    updateChecksum(extensionPath);
  }

  return { success: failed === 0, applied, failed, details, status: getStatus(extensionPath, apiUrl) };
}

function restorePatch(extensionPath) {
  if (!extensionPath || !fs.existsSync(extensionPath)) throw new Error("extension.js not found");
  const backupPath = `${extensionPath}.native-proxy-bak`;
  if (!fs.existsSync(backupPath)) return { success: false, restored: false, reason: "backup not found" };

  fs.copyFileSync(backupPath, extensionPath);
  fs.unlinkSync(backupPath);
  updateChecksum(extensionPath);
  return { success: true, restored: true, path: extensionPath };
}

const args = parseArgs(process.argv);
const apiUrl = args.apiUrl || `http://localhost:${CONFIG.port || 3009}`;
const extensionPath = args.extensionPath || findExtensionJs(args.windsurfPath);

try {
  let result;
  if (args.action === "apply") result = applyPatch(extensionPath, apiUrl);
  else if (args.action === "restore") result = restorePatch(extensionPath);
  else result = getStatus(extensionPath, apiUrl);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({ success: false, error: error.message, path: extensionPath || null }, null, 2));
  process.exit(1);
}
