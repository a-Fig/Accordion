#!/usr/bin/env node

// mcp.ts
import { createInterface } from "node:readline";

// launcher.ts
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var ACCORDION_APP_ENV = "ACCORDION_APP_PATH";
function cleanExplicitPath(value) {
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}
function isLaunchableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
function installedCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Accordion.app/Contents/MacOS/Accordion",
      path.join(os.homedir(), "Applications", "Accordion.app", "Contents", "MacOS", "Accordion")
    ];
  }
  if (process.platform === "linux") return [path.join(os.homedir(), ".local", "share", "Accordion", "accordion")];
  if (process.platform !== "win32") return [];
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Accordion"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Accordion"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Accordion"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Accordion")
  ].filter((candidate) => !!candidate);
  return roots.flatMap((root) => [path.join(root, "Accordion.exe"), path.join(root, "app.exe")]);
}
function repoCandidates() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repo = path.resolve(here, "..");
  const ext = process.platform === "win32" ? ".exe" : "";
  return [
    path.join(repo, "app", "src-tauri", "target", "release", `app${ext}`),
    path.join(repo, "app", "src-tauri", "target", "debug", `app${ext}`)
  ];
}
function resolveAccordionApp(explicitPath) {
  const explicit = cleanExplicitPath(explicitPath);
  if (explicit) {
    if (isLaunchableFile(explicit)) return { ok: true, path: explicit, source: "explicit" };
    return { ok: false, reason: "explicit-invalid", path: explicit, source: "explicit" };
  }
  const envPath = cleanExplicitPath(process.env[ACCORDION_APP_ENV]);
  if (envPath) {
    if (isLaunchableFile(envPath)) return { ok: true, path: envPath, source: "env" };
    return { ok: false, reason: "explicit-invalid", path: envPath, source: "env" };
  }
  for (const candidate of [...installedCandidates(), ...repoCandidates()]) {
    if (isLaunchableFile(candidate)) return { ok: true, path: candidate, source: "default" };
  }
  return { ok: false, reason: "not-found" };
}
async function launchAccordionApp(explicitPath) {
  const resolved = resolveAccordionApp(explicitPath);
  if (!resolved.ok) return resolved;
  try {
    const child = spawn(resolved.path, [], { detached: true, stdio: "ignore", shell: false });
    return await new Promise((resolve2) => {
      let settled = false;
      const ok = { ok: true, path: resolved.path, source: resolved.source };
      const timer = setTimeout(() => finish(ok), 150);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("spawn", onSpawn);
        child.unref();
        resolve2(result);
      };
      const onSpawn = () => finish(ok);
      const onError = (error) => finish({ ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error });
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  } catch (error) {
    return { ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error };
  }
}

// package.json
var package_default = {
  name: "@a-fig/accordion",
  version: "0.1.2",
  type: "module",
  description: "Accordion live link \u2014 a pi extension that hosts the session's context Truth and serves a replica + remote-control protocol to the Accordion GUI.",
  keywords: ["pi-package"],
  scripts: {
    "build:app": "npm --prefix ../app run build",
    "build:extension": "node ./build-extension.mjs",
    "build:client": "node ./build-client.mjs",
    "build:remote-sdk": "node ./build-remote-sdk.mjs",
    "build:mcp": "node ./build-mcp.mjs",
    build: "npm run build:app && npm run build:client && npm run build:extension && npm run build:remote-sdk && npm run build:mcp",
    prepack: "npm run build && npm run smoke",
    smoke: "node smoke.mjs && node smoke-conductor.mjs && node smoke-mcp.mjs"
  },
  pi: {
    extensions: ["./accordion.js"]
  },
  bin: {
    "accordion-mcp": "./accordion-mcp.js"
  },
  files: [
    "accordion.js",
    "accordion-mcp.js",
    "dist",
    "skills",
    "README.md"
  ],
  dependencies: {
    ws: "^8.18.0"
  },
  peerDependencies: {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    typebox: "*"
  },
  devDependencies: {
    esbuild: "^0.25.0",
    jiti: "^2.7.0"
  }
};

// mcp.ts
var tools = [{
  name: "open_accordion",
  description: "Open or focus the native Accordion context-map GUI. Live context steering is currently available for pi sessions; Claude Code transcripts are browsable read-only.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false }
}];
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}
`);
}
async function openAccordion() {
  const result = await launchAccordionApp();
  if (result.ok) {
    return { content: [{ type: "text", text: `Accordion opened from ${result.path}. Live steering remains pi-only; use the Claude Code tab for read-only transcript browsing.` }] };
  }
  if (result.reason === "explicit-invalid") {
    return { isError: true, content: [{ type: "text", text: `${ACCORDION_APP_ENV} does not point to an executable: ${result.path}` }] };
  }
  if (result.reason === "spawn-failed") {
    return { isError: true, content: [{ type: "text", text: `Accordion was found at ${result.path}, but launching it failed.` }] };
  }
  return { isError: true, content: [{ type: "text", text: `Accordion was not found. Build or install the desktop app, or set ${ACCORDION_APP_ENV}.` }] };
}
for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    continue;
  }
  if (request.id === void 0) continue;
  if (request.method === "initialize") {
    write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "accordion", version: package_default.version } } });
  } else if (request.method === "ping") {
    write({ jsonrpc: "2.0", id: request.id, result: {} });
  } else if (request.method === "tools/list") {
    write({ jsonrpc: "2.0", id: request.id, result: { tools } });
  } else if (request.method === "tools/call" && request.params?.name === "open_accordion") {
    write({ jsonrpc: "2.0", id: request.id, result: await openAccordion() });
  } else {
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
}
