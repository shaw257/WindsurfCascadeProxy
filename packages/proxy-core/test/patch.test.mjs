import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatch, getStatus, restorePatch } from "../patch.mjs";

const source = 'a.getApiServerUrlFromContext=b=>{let c=b.globalState.get("url");return c};class X{async restart(a){this.apiServerUrl=a,this.inputs.apiServerUrl=a,console.log(a)}}';

function fixture(t, content = source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const extension = path.join(dir, "extensions", "windsurf", "dist", "extension.js");
  const product = path.join(dir, "product.json");
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.writeFileSync(extension, content);
  const checksum = crypto.createHash("sha256").update(content);
  fs.writeFileSync(product, JSON.stringify({
    version: "fixture-1", commit: "fixture-commit",
    checksums: { "extensions/windsurf/dist/extension.js": checksum.digest("base64") }
  }));
  const builds = [{
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform,
    version: "fixture-1", commit: "fixture-commit",
    extensionSha256: crypto.createHash("sha256").update(content).digest("hex")
  }];
  return { extension, product, builds };
}

test("known build installs, changes port and fully restores both files", t => {
  const { extension, product, builds } = fixture(t);
  const originalProduct = fs.readFileSync(product, "utf8");
  assert.equal(applyPatch(extension, "http://localhost:3009", builds).success, true);
  assert.ok(getStatus(extension, "http://localhost:3009", builds).patches.every(p => p.status === "applied"));
  applyPatch(extension, "http://localhost:3010", builds);
  assert.ok(getStatus(extension, "http://localhost:3010", builds).patches.every(p => p.status === "applied"));
  assert.equal(restorePatch(extension, builds).success, true);
  assert.equal(fs.readFileSync(extension, "utf8"), source);
  assert.equal(fs.readFileSync(product, "utf8"), originalProduct);
  assert.equal(fs.existsSync(`${extension}.native-proxy-bak`), false);
});

test("same version and commit do not bypass hash check", t => {
  const { extension, builds } = fixture(t);
  fs.appendFileSync(extension, "/* unrecognized update */");
  assert.throws(() => applyPatch(extension, "http://localhost:3009", builds));
  assert.equal(fs.existsSync(`${extension}.native-proxy-bak`), false);
});

test("stale backups cannot overwrite an updated installation", t => {
  const { extension, product, builds } = fixture(t);
  applyPatch(extension, "http://localhost:3009", builds);
  fs.writeFileSync(extension, "updated extension");
  const updatedProduct = JSON.stringify({ version: "fixture-2", commit: "new-commit" });
  fs.writeFileSync(product, updatedProduct);
  assert.throws(() => applyPatch(extension, "http://localhost:3010", builds));
  assert.throws(() => restorePatch(extension, builds));
  assert.equal(fs.readFileSync(extension, "utf8"), "updated extension");
  assert.equal(fs.readFileSync(product, "utf8"), updatedProduct);
});

test("extra modifications to a patched extension are not silently replaced", t => {
  const { extension, builds } = fixture(t);
  applyPatch(extension, "http://localhost:3009", builds);
  fs.appendFileSync(extension, "/* external edit */");
  assert.throws(() => restorePatch(extension, builds));
  assert.throws(() => applyPatch(extension, "http://localhost:3010", builds));
  assert.equal(getStatus(extension, "http://localhost:3009", builds).build.known, false);
});

test("all rules must match before any files are changed", t => {
  const partial = source.split(";class")[0];
  const { extension, product, builds } = fixture(t, partial);
  const productBefore = fs.readFileSync(product, "utf8");
  assert.throws(() => applyPatch(extension, "http://localhost:3009", builds));
  assert.equal(fs.readFileSync(extension, "utf8"), partial);
  assert.equal(fs.readFileSync(product, "utf8"), productBefore);
  assert.equal(fs.existsSync(`${extension}.native-proxy-bak`), false);
});

test("non-loopback patch addresses and invalid ports are refused", t => {
  const { extension, builds } = fixture(t);
  for (const address of ["https://example.com", "http://localhost:0", "http://localhost:65536"]) {
    assert.throws(() => applyPatch(extension, address, builds));
  }
  assert.equal(fs.readFileSync(extension, "utf8"), source);
});
