#!/usr/bin/env node

import { fetchModels, testUpstream } from "./upstream.mjs";

const [, , command = "help", ...args] = process.argv;
const options = parseArgs(args);

try {
  if (command === "serve") {
    if (!options.config) throw new Error("serve 需要 --config。");
    process.env.WINDSURF_PROXY_CONFIG = options.config;
    process.env.WINDSURF_PROXY_INSTANCE_ID = options.instance || "";
    process.env.WINDSURF_PROXY_CONTROL_TOKEN = options.token || "";
    await import("./server.mjs");
  } else if (command === "test") {
    if (!options.config) throw new Error("test 需要 --config。");
    emit("result", await testUpstream(options.config, {
      connectionId: options.connection,
      windsurfModelId: options.route
    }));
  } else if (command === "models") {
    if (!options.config) throw new Error("models 需要 --config。");
    emit("result", await fetchModels(options.config, options.connection));
  } else {
    emit("help", {
      commands: [
        "serve --config <path> --instance <id> --token <token>",
        "test --config <path> [--connection <id>] [--route <Windsurf model ID>]",
        "models --config <path> [--connection <id>]"
      ]
    });
  }
} catch (error) {
  emit("error", { message: error?.message || String(error), stack: error?.stack || "" });
  process.exitCode = 1;
}

function parseArgs(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) continue;
    output[key.slice(2)] = values[index + 1] && !values[index + 1].startsWith("--")
      ? values[++index]
      : "true";
  }
  return output;
}

function emit(event, data) {
  process.stdout.write(`${JSON.stringify({
    event,
    at: new Date().toISOString(),
    data
  })}\n`);
}
