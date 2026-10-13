import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("release package, lock and Tauri versions are consistent", () => {
  const root = new URL("../../../", import.meta.url);
  const read = file => JSON.parse(fs.readFileSync(new URL(file, root), "utf8"));
  const version = read("package.json").version;
  assert.equal(version, "0.2.0");
  for (const file of ["apps/desktop/package.json", "packages/proxy-core/package.json", "apps/desktop/src-tauri/tauri.conf.json", "package-lock.json"]) {
    assert.equal(read(file).version, version, file);
  }
  const lock = read("package-lock.json");
  assert.equal(lock.packages[""].version, version);
  assert.equal(lock.packages["apps/desktop"].version, version);
  const cargo = fs.readFileSync(new URL("apps/desktop/src-tauri/Cargo.toml", root), "utf8");
  assert.ok(cargo.includes(`version = "${version}"`));
});
