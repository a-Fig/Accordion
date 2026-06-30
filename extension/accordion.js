// accordion.ts
import { WebSocketServer } from "ws";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Type } from "typebox";

// ../app/src/lib/engine/tokens.ts
var CHARS_PER_TOKEN = 4;
var BLOCK_OVERHEAD = 4;
function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

// ../app/src/lib/live/mapping.ts
function blockId(m, i, partIndex) {
  switch (m.role) {
    case "user":
      return m.timestamp != null ? `u:${m.timestamp}` : `m${i}:u`;
    case "assistant": {
      if (partIndex == null) return `m${i}:p?`;
      const anchor = m.responseId != null ? m.responseId : m.timestamp != null ? `t${m.timestamp}` : null;
      return anchor != null ? `a:${anchor}:p${partIndex}` : `m${i}:p${partIndex}`;
    }
    case "toolResult":
      return m.toolCallId != null ? `r:${m.toolCallId}` : `m${i}:r`;
    default:
      return m.timestamp != null ? `s:${m.timestamp}` : `m${i}:s`;
  }
}
function isDurableId(id) {
  return id.startsWith("u:") || id.startsWith("a:") || id.startsWith("r:") || id.startsWith("s:");
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((b) => !!b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  return "";
}
var tokensFor = (text) => estTokens(text) + BLOCK_OVERHEAD;
function linearize(messages) {
  const out = [];
  let order = 0;
  let turn = 0;
  const push = (id, kind, text, extra = {}) => {
    if (!text && kind !== "tool_result") return;
    out.push({ id, kind, turn, order: order++, text, tokens: tokensFor(text), ...extra });
  };
  messages.forEach((m, i) => {
    switch (m.role) {
      case "user": {
        turn += 1;
        push(blockId(m, i), "user", textOf(m.content));
        break;
      }
      case "assistant": {
        const parts = Array.isArray(m.content) ? m.content : [];
        parts.forEach((b, j) => {
          if (b?.type === "thinking") push(blockId(m, i, j), "thinking", b.thinking || "", { model: m.model });
          else if (b?.type === "text") push(blockId(m, i, j), "text", b.text || "", { model: m.model });
          else if (b?.type === "toolCall") {
            const c = b;
            push(blockId(m, i, j), "tool_call", `${c.name} ${JSON.stringify(c.arguments ?? {})}`, {
              toolName: c.name,
              callId: c.id,
              model: m.model
            });
          }
        });
        break;
      }
      case "toolResult": {
        push(blockId(m, i), "tool_result", textOf(m.content), {
          toolName: m.toolName || "tool",
          callId: m.toolCallId,
          isError: !!m.isError
        });
        break;
      }
      default: {
        if (typeof m.summary === "string" && m.summary) push(blockId(m, i), "text", m.summary);
      }
    }
  });
  return out;
}
function messageInfo(m, i) {
  const ids = [];
  const calls = [];
  const results = [];
  let hasNonDurable = false;
  const push = (id) => {
    ids.push(id);
    if (!isDurableId(id)) hasNonDurable = true;
  };
  switch (m.role) {
    case "user":
      push(blockId(m, i));
      break;
    case "assistant": {
      const parts = Array.isArray(m.content) ? m.content : [];
      parts.forEach((b, j) => {
        if (b?.type === "thinking") {
          if (b.thinking) push(blockId(m, i, j));
        } else if (b?.type === "text") {
          if (b.text) push(blockId(m, i, j));
        } else if (b?.type === "toolCall") {
          push(blockId(m, i, j));
          const id = b.id;
          if (id) calls.push(id);
        }
      });
      break;
    }
    case "toolResult":
      push(blockId(m, i));
      if (m.toolCallId) results.push(m.toolCallId);
      break;
    default:
      if (typeof m.summary === "string" && m.summary) push(blockId(m, i));
  }
  return { ids, calls, results, hasNonDurable };
}
function foldOne(m, i, byId, mark) {
  if (m.role === "assistant" && Array.isArray(m.content)) {
    let parts = null;
    m.content.forEach((b, j) => {
      const op = byId.get(blockId(m, i, j));
      if (!op || !op.digestText) return;
      if (b?.type === "text") {
        parts ??= m.content.slice();
        parts[j] = { ...b, text: op.digestText };
      } else if (b?.type === "thinking") {
        parts ??= m.content.slice();
        parts[j] = { ...b, thinking: op.digestText };
      }
    });
    if (parts) {
      mark();
      return { ...m, content: parts };
    }
    return m;
  }
  if (m.role === "toolResult") {
    const op = byId.get(blockId(m, i));
    if (op && op.digestText) {
      mark();
      return { ...m, content: [{ type: "text", text: op.digestText }] };
    }
    return m;
  }
  return m;
}
function applyPlan(messages, ops, groups = []) {
  const safeOps = (ops ?? []).filter((o) => o && typeof o.id === "string" && isDurableId(o.id) && typeof o.digestText === "string" && o.digestText);
  const safeGroups = (groups ?? []).filter(
    (g) => g && Array.isArray(g.memberIds) && g.memberIds.length && g.memberIds.every((m) => typeof m === "string") && (g.summaryText === null || typeof g.summaryText === "string" && g.summaryText.trim())
  );
  if (!safeOps.length && !safeGroups.length) return messages;
  const byId = new Map(safeOps.map((o) => [o.id, o]));
  const owner = new Array(messages.length).fill(null);
  if (safeGroups.length) {
    const memberToGroup = /* @__PURE__ */ new Map();
    for (const g of safeGroups) for (const id of g.memberIds) if (isDurableId(id)) memberToGroup.set(id, g);
    const infos = messages.map((m, i) => messageInfo(m, i));
    for (let i = 0; i < messages.length; i++) {
      const info = infos[i];
      if (!info.ids.length || info.hasNonDurable) continue;
      let g = null;
      let ok = true;
      for (const id of info.ids) {
        const gg = memberToGroup.get(id);
        if (!gg || g && gg !== g) {
          ok = false;
          break;
        }
        g = gg;
      }
      if (ok && g) owner[i] = g;
    }
    for (let changedSet = true; changedSet; ) {
      changedSet = false;
      const calls = /* @__PURE__ */ new Set();
      const results = /* @__PURE__ */ new Set();
      for (let i = 0; i < messages.length; i++) {
        if (!owner[i]) continue;
        for (const c of infos[i].calls) calls.add(c);
        for (const c of infos[i].results) results.add(c);
      }
      for (let i = 0; i < messages.length; i++) {
        if (!owner[i]) continue;
        const info = infos[i];
        if (info.calls.some((c) => !results.has(c)) || info.results.some((c) => !calls.has(c))) {
          owner[i] = null;
          changedSet = true;
        }
      }
    }
  }
  let changed = false;
  const mark = () => {
    changed = true;
  };
  const out = [];
  for (let i = 0; i < messages.length; ) {
    const g = owner[i];
    if (g) {
      let j = i + 1;
      while (j < messages.length && owner[j] === g) j++;
      if (g.summaryText === null) {
        changed = true;
      } else {
        const role = messages[i].role === "assistant" ? "assistant" : "user";
        out.push({ role, content: [{ type: "text", text: g.summaryText }] });
        changed = true;
      }
      i = j;
      continue;
    }
    out.push(foldOne(messages[i], i, byId, mark));
    i++;
  }
  return changed ? out : messages;
}

// ../app/src/lib/live/protocol.ts
var PROTOCOL_VERSION = 5;
var DEFAULT_PORT = 4317;

// ../app/src/lib/live/registry.ts
var REGISTRY_PROTOCOL = 1;
var REGISTRY_DIR = ".accordion";
var SESSIONS_SUBDIR = "sessions";
var FOCUS_FILE = "focus.json";
var HEARTBEAT_INTERVAL_MS = 5e3;

// accordion.ts
var REQUEST_TIMEOUT_MS = 250;
var UNFOLD_TIMEOUT_MS = 2e3;
var RECALL_TIMEOUT_MS = 2e3;
var HOME = process.env.ACCORDION_HOME || os.homedir();
var REGISTRY_ROOT = path.join(HOME, REGISTRY_DIR);
var SESSIONS_DIR = path.join(REGISTRY_ROOT, SESSIONS_SUBDIR);
var FOCUS_PATH = path.join(REGISTRY_ROOT, FOCUS_FILE);
var ACCORDION_APP_FLAG = "accordion-app";
var ACCORDION_APP_ENV = "ACCORDION_APP_PATH";
var ACCORDION_PORT_ENV = "ACCORDION_PORT";
function cleanExplicitPath(value) {
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}
function isLaunchableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function windowsInstallCandidates() {
  if (process.platform !== "win32") return [];
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Accordion"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Accordion"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Accordion"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Accordion")
  ].filter((s) => !!s);
  const names = ["Accordion.exe", "app.exe"];
  const out = [];
  for (const root of roots) for (const name of names) out.push(path.join(root, name));
  return out;
}
function repoAppCandidates() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repo = path.resolve(here, "..");
    const ext = process.platform === "win32" ? ".exe" : "";
    return [
      path.join(repo, "app", "src-tauri", "target", "release", `app${ext}`),
      path.join(repo, "app", "src-tauri", "target", "debug", `app${ext}`)
    ];
  } catch {
    return [];
  }
}
function resolveAccordionApp(pi) {
  const flagPath = cleanExplicitPath(pi.getFlag(ACCORDION_APP_FLAG));
  if (flagPath) {
    if (isLaunchableFile(flagPath)) return { ok: true, path: flagPath, source: "cli" };
    return { ok: false, reason: "explicit-invalid", path: flagPath, source: "cli" };
  }
  const envPath = cleanExplicitPath(process.env[ACCORDION_APP_ENV]);
  if (envPath) {
    if (isLaunchableFile(envPath)) return { ok: true, path: envPath, source: "env" };
    return { ok: false, reason: "explicit-invalid", path: envPath, source: "env" };
  }
  for (const candidate of [...windowsInstallCandidates(), ...repoAppCandidates()]) {
    if (isLaunchableFile(candidate)) return { ok: true, path: candidate, source: "default" };
  }
  return { ok: false, reason: "not-found" };
}
async function launchAccordionApp(pi) {
  const resolved = resolveAccordionApp(pi);
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
function launchResultLine(result) {
  if (!result) return { text: "Accordion focus requested for this session.", type: "info" };
  if (result.ok) return { text: "Launching/focusing Accordion for this session\u2026", type: "info" };
  if (result.reason === "explicit-invalid") {
    const source = result.source === "cli" ? `--${ACCORDION_APP_FLAG}` : ACCORDION_APP_ENV;
    return {
      text: `Accordion focus request written, but ${source} does not point to an executable: ${result.path}`,
      type: "warning"
    };
  }
  if (result.reason === "spawn-failed") {
    return {
      text: `Accordion focus request written, but launching failed for ${result.path}. Set ${ACCORDION_APP_ENV} or --${ACCORDION_APP_FLAG} to the Accordion executable.`,
      type: "warning"
    };
  }
  return {
    text: `Accordion focus request written, but I couldn't find the desktop app. Open Accordion manually, or set ${ACCORDION_APP_ENV} / --${ACCORDION_APP_FLAG}.`,
    type: "warning"
  };
}
function accordionLive(pi) {
  pi.registerFlag(ACCORDION_APP_FLAG, {
    description: "Path to the Accordion desktop app executable for /accordion launch/focus",
    type: "string"
  });
  let wss = null;
  let httpServer = null;
  let webToken = "";
  let client = null;
  let sessionId = "";
  let meta = { title: "pi session", cwd: "", model: "", contextWindow: null, format: "pi" };
  let sentCount = 0;
  let reqSeq = 0;
  let epoch = 0;
  const pending = /* @__PURE__ */ new Map();
  let unfoldSeq = 0;
  const pendingUnfold = /* @__PURE__ */ new Map();
  let recallSeq = 0;
  const pendingRecall = /* @__PURE__ */ new Map();
  let lastMessages = [];
  let pendingSince = [];
  let latestCtx = null;
  let latestModel = null;
  let port = 0;
  let startedAt = 0;
  let model = "";
  let tokens = null;
  let contextWindow = null;
  let heartbeat = null;
  const attached = () => !!client && client.readyState === 1;
  function flushPending() {
    for (const resolve2 of pending.values()) resolve2({ ops: [], groups: [] });
    pending.clear();
    for (const resolve2 of pendingUnfold.values()) resolve2(null);
    pendingUnfold.clear();
    for (const resolve2 of pendingRecall.values()) resolve2(null);
    pendingRecall.clear();
  }
  function send(ws, m) {
    try {
      ws.send(JSON.stringify(m));
    } catch {
    }
  }
  function sendStream(frame) {
    const ws = client;
    if (!ws || ws.readyState !== 1) return;
    send(ws, frame);
  }
  function buildEntry() {
    return {
      registryProtocol: REGISTRY_PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      port,
      pid: process.pid,
      cwd: meta.cwd,
      title: meta.title,
      model,
      tokens,
      contextWindow,
      startedAt,
      heartbeatAt: Date.now()
    };
  }
  function writeEntry() {
    if (!port || !sessionId) return;
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const target = path.join(SESSIONS_DIR, `${sessionId}.json`);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buildEntry()));
      fs.renameSync(tmp, target);
    } catch {
    }
  }
  function deleteEntry() {
    if (!sessionId) return;
    try {
      fs.unlinkSync(path.join(SESSIONS_DIR, `${sessionId}.json`));
    } catch {
    }
  }
  function writeFocusRequest() {
    if (!sessionId) return;
    try {
      fs.mkdirSync(REGISTRY_ROOT, { recursive: true });
      const req = { sessionId, ts: Date.now() };
      const tmp = `${FOCUS_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(req));
      fs.renameSync(tmp, FOCUS_PATH);
    } catch {
    }
  }
  function readSessionMessages(c) {
    if (!c) return [];
    let sm;
    try {
      sm = c.sessionManager;
    } catch {
      return [];
    }
    if (!sm) return [];
    try {
      const sc = sm.buildSessionContext?.();
      if (sc && Array.isArray(sc.messages)) return sc.messages;
    } catch {
    }
    try {
      const branch = sm.getBranch?.() ?? [];
      const msgs = branch.filter((e) => e.type === "message" && e.message).map((e) => e.message);
      msgs.reverse();
      return msgs;
    } catch {
      return [];
    }
  }
  function applyModel(m) {
    if (!m) return;
    latestModel = m;
    if (m.id) {
      model = m.id;
      meta.model = m.id;
    }
    if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
      contextWindow = m.contextWindow;
      meta.contextWindow = m.contextWindow;
    }
  }
  function refreshFromCtx(ctx) {
    try {
      applyModel(ctx.model);
      const u = ctx.getContextUsage?.();
      if (u) {
        tokens = u.tokens;
        if (typeof u.contextWindow === "number") {
          contextWindow = u.contextWindow;
          meta.contextWindow = u.contextWindow;
        }
      }
    } catch {
    }
  }
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain",
    ".map": "application/json"
  };
  function resolveClientRoot() {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const candidates = [path.join(here, "dist", "client"), path.resolve(here, "..", "app", "build")];
      for (const dir of candidates) {
        try {
          if (fs.statSync(dir).isDirectory()) return dir;
        } catch {
        }
      }
    } catch {
    }
    return null;
  }
  function isWebAuthed(req, u) {
    if (!webToken) return false;
    if (u.searchParams.get("token") === webToken) return true;
    const cookie = req.headers["cookie"];
    if (typeof cookie === "string" && cookie.split(";").some((c) => c.trim() === `accordion_token=${webToken}`)) return true;
    return false;
  }
  function handleHttp(req, res) {
    try {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (u.pathname === "/__accordion/meta") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ served: true, sessionId, protocolVersion: PROTOCOL_VERSION }));
        return;
      }
      if (!isWebAuthed(req, u)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden \u2014 open Accordion via the /accordion command's Browser link (it carries the session token).");
        return;
      }
      const headers = {};
      if (u.searchParams.get("token") === webToken) {
        headers["Set-Cookie"] = `accordion_token=${webToken}; HttpOnly; SameSite=Strict; Path=/`;
      }
      const root = resolveClientRoot();
      if (!root) {
        res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
        res.end("No browser build found. Run `npm run build` in app/, or `npm run build:client` in extension/.");
        return;
      }
      let rel = decodeURIComponent(u.pathname);
      if (rel === "/") rel = "/index.html";
      let filePath = path.join(root, rel);
      const rootResolved = path.resolve(root);
      if (path.resolve(filePath) !== rootResolved && !path.resolve(filePath).startsWith(rootResolved + path.sep)) {
        res.writeHead(403, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      let exists = false;
      try {
        exists = fs.statSync(filePath).isFile();
      } catch {
        exists = false;
      }
      if (!exists) {
        if (path.extname(rel) === "") {
          filePath = path.join(root, "index.html");
        } else {
          res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
      }
      let body;
      try {
        body = fs.readFileSync(filePath);
      } catch {
        res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const mime = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { ...headers, "Content-Type": mime });
      res.end(body);
    } catch {
      try {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal error");
      } catch {
      }
    }
  }
  function startServer() {
    if (wss || httpServer) return;
    webToken = crypto.randomBytes(16).toString("hex");
    try {
      httpServer = http.createServer(handleHttp);
      wss = new WebSocketServer({ server: httpServer });
      httpServer.on("error", () => {
        try {
          httpServer?.close();
        } catch {
        }
        httpServer = null;
        wss = null;
      });
      const bindPort = parseInt(process.env[ACCORDION_PORT_ENV], 10) || 0;
      httpServer.listen(bindPort, "0.0.0.0", () => {
        const addr = httpServer?.address();
        if (addr && typeof addr === "object") {
          port = addr.port;
          writeEntry();
          if (!heartbeat) {
            heartbeat = setInterval(writeEntry, HEARTBEAT_INTERVAL_MS);
            heartbeat.unref?.();
          }
        }
      });
    } catch {
      try {
        httpServer?.close();
      } catch {
      }
      httpServer = null;
      wss = null;
      return;
    }
    wss.on("connection", (ws) => {
      flushPending();
      client = ws;
      epoch++;
      sentCount = 0;
      reqSeq = 0;
      send(ws, { type: "hello", protocolVersion: PROTOCOL_VERSION, sessionId, meta });
      const live = readSessionMessages(latestCtx);
      if (live.length) lastMessages = live;
      const backlog = linearize(lastMessages);
      if (backlog.length) {
        send(ws, { type: "sync", reqId: ++reqSeq, full: true, blocks: backlog, contextWindow });
        sentCount = backlog.length;
      }
      ws.on("message", (data) => {
        if (ws !== client) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg?.type === "plan" && typeof msg.reqId === "number") {
          const resolve2 = pending.get(msg.reqId);
          if (resolve2) {
            pending.delete(msg.reqId);
            resolve2({ ops: Array.isArray(msg.ops) ? msg.ops : [], groups: Array.isArray(msg.groups) ? msg.groups : [] });
          }
        }
        if (msg?.type === "unfoldResult" && typeof msg.reqId === "number") {
          const resolve2 = pendingUnfold.get(msg.reqId);
          if (resolve2) {
            pendingUnfold.delete(msg.reqId);
            resolve2({
              restored: Array.isArray(msg.restored) ? msg.restored : [],
              missing: Array.isArray(msg.missing) ? msg.missing : []
            });
          }
        }
        if (msg?.type === "recallResult" && typeof msg.reqId === "number") {
          const resolve2 = pendingRecall.get(msg.reqId);
          if (resolve2) {
            pendingRecall.delete(msg.reqId);
            resolve2({
              restored: Array.isArray(msg.restored) ? msg.restored : [],
              missing: Array.isArray(msg.missing) ? msg.missing : []
            });
          }
        }
        if (msg?.type === "completeRequest" && typeof msg.reqId === "number") {
          const req = msg;
          const capturedWs = ws;
          void (async () => {
            const reply = (r) => {
              if (capturedWs === client && capturedWs.readyState === 1) send(capturedWs, r);
            };
            if (typeof req.prompt !== "string" || req.prompt.length === 0) {
              reply({ type: "completeResult", reqId: req.reqId, ok: false, error: "missing or empty prompt" });
              return;
            }
            try {
              const ctx = latestCtx;
              const m = latestModel ?? ctx?.model;
              if (!ctx || !m) {
                reply({ type: "completeResult", reqId: req.reqId, ok: false, error: "no model available" });
                return;
              }
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
              if (!auth.ok) {
                reply({ type: "completeResult", reqId: req.reqId, ok: false, error: `could not resolve API key: ${auth.error ?? "unknown"}` });
                return;
              }
              const { complete } = await import("@earendil-works/pi-ai");
              const context = {
                ...typeof req.system === "string" ? { systemPrompt: req.system } : {},
                messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }]
              };
              let maxTokens;
              if (typeof req.maxOutputTokens === "number" && req.maxOutputTokens > 0) {
                const modelCeiling = typeof m.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : void 0;
                maxTokens = modelCeiling !== void 0 ? Math.min(req.maxOutputTokens, modelCeiling) : req.maxOutputTokens;
              }
              const result = await complete(m, context, {
                apiKey: auth.apiKey,
                headers: auth.headers,
                ...maxTokens !== void 0 ? { maxTokens } : {}
              });
              let text = "";
              if (Array.isArray(result.content)) {
                text = result.content.filter((p) => p?.type === "text").map((p) => typeof p?.text === "string" ? p.text : "").join("");
              }
              reply({
                type: "completeResult",
                reqId: req.reqId,
                ok: true,
                text,
                model: result.model,
                inputTokens: typeof result.usage?.input === "number" ? result.usage.input : void 0,
                outputTokens: typeof result.usage?.output === "number" ? result.usage.output : void 0
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              reply({ type: "completeResult", reqId: req.reqId, ok: false, error: errMsg });
            }
          })();
        }
      });
      const drop = () => {
        if (client === ws) client = null;
      };
      ws.on("close", drop);
      ws.on("error", drop);
    });
    wss.on("error", () => {
      try {
        httpServer?.close();
      } catch {
      }
      httpServer = null;
      wss = null;
    });
  }
  function requestPlan(reqId, full, blocks) {
    return new Promise((resolve2) => {
      const ws = client;
      if (!ws || ws.readyState !== 1) return resolve2(null);
      const timer = setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          resolve2({ ops: [], groups: [] });
        }
      }, REQUEST_TIMEOUT_MS);
      pending.set(reqId, (plan) => {
        clearTimeout(timer);
        resolve2(plan);
      });
      send(ws, { type: "sync", reqId, full, blocks, contextWindow });
    });
  }
  function requestUnfold(codes) {
    return new Promise((resolve2) => {
      const ws = client;
      if (!ws || ws.readyState !== 1) return resolve2(null);
      const reqId = ++unfoldSeq;
      const timer = setTimeout(() => {
        if (pendingUnfold.has(reqId)) {
          pendingUnfold.delete(reqId);
          resolve2(null);
        }
      }, UNFOLD_TIMEOUT_MS);
      pendingUnfold.set(reqId, (res) => {
        clearTimeout(timer);
        resolve2(res);
      });
      send(ws, { type: "unfoldRequest", reqId, codes });
    });
  }
  function requestRecall(codes) {
    return new Promise((resolve2) => {
      const ws = client;
      if (!ws || ws.readyState !== 1) return resolve2(null);
      const reqId = ++recallSeq;
      const timer = setTimeout(() => {
        if (pendingRecall.has(reqId)) {
          pendingRecall.delete(reqId);
          resolve2(null);
        }
      }, RECALL_TIMEOUT_MS);
      pendingRecall.set(reqId, (res) => {
        clearTimeout(timer);
        resolve2(res);
      });
      send(ws, { type: "recallRequest", reqId, codes });
    });
  }
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    sessionId = `s-${process.pid}-${Date.now()}`;
    sentCount = 0;
    pendingSince = [];
    lastMessages = readSessionMessages(ctx);
    startedAt = Date.now();
    try {
      meta = { title: "pi session", cwd: process?.cwd?.() ?? "", model: "", contextWindow: null, format: "pi" };
    } catch {
    }
    refreshFromCtx(ctx);
    startServer();
    try {
      ctx.ui.setStatus("accordion", ctx.ui.theme.fg("accent", "\u{1FA97} accordion"));
    } catch {
    }
  });
  pi.on("message_update", (event) => {
    const ws = client;
    if (!ws || ws.readyState !== 1) return;
    const ev = event?.assistantMessageEvent;
    if (!ev || typeof ev.type !== "string") return;
    const t = ev.type;
    const ci = typeof ev.contentIndex === "number" ? ev.contentIndex : 0;
    if (t === "text_start") {
      sendStream({ type: "stream", phase: "start", kind: "text", contentIndex: ci });
    } else if (t === "thinking_start") {
      sendStream({ type: "stream", phase: "start", kind: "thinking", contentIndex: ci });
    } else if (t === "toolcall_start") {
      sendStream({ type: "stream", phase: "start", kind: "tool_call", contentIndex: ci });
    } else if (t === "text_end") {
      sendStream({ type: "stream", phase: "end", kind: "text", contentIndex: ci });
    } else if (t === "thinking_end") {
      sendStream({ type: "stream", phase: "end", kind: "thinking", contentIndex: ci });
    } else if (t === "toolcall_end") {
      sendStream({ type: "stream", phase: "end", kind: "tool_call", contentIndex: ci });
    } else if (t === "error" || t === "aborted") {
      sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
    }
  });
  pi.on("context", async (event, ctx) => {
    latestCtx = ctx;
    const myEpoch = epoch;
    refreshFromCtx(ctx);
    lastMessages = event.messages;
    pendingSince = [];
    const all = linearize(lastMessages);
    if (!attached()) return;
    const fresh = all.slice(sentCount);
    const reqId = ++reqSeq;
    const full = sentCount === 0;
    const plan = await requestPlan(reqId, full, fresh);
    if (plan === null) return;
    if (epoch !== myEpoch) return;
    sentCount = Math.max(sentCount, all.length);
    if (plan.ops.length === 0 && plan.groups.length === 0) return;
    return { messages: applyPlan(event.messages, plan.ops, plan.groups) };
  });
  pi.on("model_select", (event) => {
    applyModel(event?.model);
    const ws = client;
    if (ws && ws.readyState === 1) {
      send(ws, { type: "sync", reqId: ++reqSeq, full: false, blocks: [], contextWindow });
    }
  });
  pi.on("message_end", (event) => {
    const ws = client;
    if (!ws || ws.readyState !== 1) return;
    sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
    const msg = event.message;
    const msgIds = new Set(linearize([msg]).map((b) => b.id));
    const baseIds = new Set(linearize(lastMessages).map((b) => b.id));
    const pendIds = new Set(linearize(pendingSince).map((b) => b.id));
    const alreadySeen = [...msgIds].some((id) => baseIds.has(id) || pendIds.has(id));
    if (msgIds.size > 0 && !alreadySeen) pendingSince.push(msg);
    const all = linearize([...lastMessages, ...pendingSince]);
    if (all.length <= sentCount) return;
    const reqId = ++reqSeq;
    const full = sentCount === 0;
    send(ws, { type: "sync", reqId, full, blocks: all.slice(sentCount) });
    sentCount = all.length;
  });
  pi.on("agent_end", (event, ctx) => {
    latestCtx = ctx;
    lastMessages = event.messages;
    pendingSince = [];
    const ws = client;
    if (!ws || ws.readyState !== 1) return;
    sendStream({ type: "stream", phase: "abort", kind: "text", contentIndex: -1 });
    const all = linearize(lastMessages);
    if (all.length <= sentCount) return;
    const reqId = ++reqSeq;
    const full = sentCount === 0;
    send(ws, { type: "sync", reqId, full, blocks: all.slice(sentCount) });
    sentCount = all.length;
  });
  pi.on("session_before_compact", (_event, ctx) => {
    if (attached()) {
      try {
        ctx.ui.notify("Accordion attached \u2014 native compaction suppressed.", "info");
      } catch {
      }
      return { cancel: true };
    }
  });
  pi.on("session_shutdown", () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    deleteEntry();
    flushPending();
    try {
      client?.close();
    } catch {
    }
    try {
      wss?.close();
    } catch {
    }
    try {
      httpServer?.close();
    } catch {
    }
    httpServer = null;
    wss = null;
    client = null;
    latestCtx = null;
  });
  pi.registerCommand("accordion", {
    description: "Open/focus Accordion on this pi session",
    handler: async (_args, ctx) => {
      writeFocusRequest();
      const wasAttached = attached();
      const launch = wasAttached ? null : await launchAccordionApp(pi);
      const action = launchResultLine(launch);
      const lines = [
        action.text,
        `Live link: ${wasAttached ? "attached" : "detached"} \xB7 port ${port || "starting"} \xB7 streamed ${sentCount} blocks`
      ];
      if (port && webToken) lines.push(`Browser: http://127.0.0.1:${port}/?token=${webToken}`);
      else lines.push("Browser: starting\u2026");
      ctx.ui.notify(lines.join("\n"), action.type);
    }
  });
  pi.registerTool({
    name: "unfold",
    label: "Unfold Context",
    description: "Restore folded context. Accordion (the live context manager attached to this session) may replace older parts of YOUR OWN context with a short summary tagged like `{#3f9a2c FOLDED}`. The original content is preserved, not lost. Call this tool with the short code(s) from those tags to restore the full content. The restored content reappears in your context on your NEXT turn (your past context changes); this call confirms what was scheduled. Only unfold what you actually need \u2014 it costs tokens.",
    promptSnippet: "unfold(codes) \u2014 restore context folded by Accordion (blocks tagged {#<code> FOLDED}).",
    promptGuidelines: [
      "When you see a `{#<code> FOLDED}` marker in your context (e.g. `{#3f9a2c FOLDED}`), that block was compacted by Accordion to save tokens \u2014 the full content is preserved, not lost. If the summary is not enough for your current task, call `unfold` with the code(s) from the marker(s) to restore them; the content returns on your next turn."
    ],
    parameters: Type.Object({
      codes: Type.Array(Type.String({ description: 'A fold code copied verbatim from a {#<code> FOLDED} tag, e.g. "3f9a2c". Always a string (codes may have leading zeros).' }), {
        description: "One or more fold codes to restore to full content."
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const codes = Array.isArray(params.codes) ? params.codes.map((s) => String(s).trim()).filter((s) => s.length > 0) : [];
      if (!codes.length) {
        return { content: [{ type: "text", text: 'No fold codes given. Pass the code(s) from a {#<code> FOLDED} tag, e.g. unfold({codes:["3f9a2c"]}).' }] };
      }
      if (!attached()) {
        return { content: [{ type: "text", text: "Accordion isn't attached, so nothing in your context is folded right now \u2014 it is already full." }] };
      }
      const res = await requestUnfold(codes);
      if (res === null) {
        return { content: [{ type: "text", text: "Accordion did not respond. Folded content restores automatically if it detaches; otherwise try again." }], isError: true };
      }
      const lines = [];
      if (res.restored.length) {
        lines.push(`Unfolded ${res.restored.length} block(s); full content returns on your next turn:`);
        for (const r of res.restored) lines.push(`  \u2022 ${r?.label ?? "block"} (#${r?.code ?? "?"})`);
      }
      if (res.missing.length) {
        lines.push(`No folded block for: ${res.missing.map((c) => "#" + c).join(", ")} (already full, or not in this session's context).`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: res };
    }
  });
  pi.registerTool({
    name: "recall",
    label: "Recall Folded Content",
    description: "Read folded context WITHOUT changing what's standing in your context. Accordion (the live context manager attached to this session) may replace older parts of YOUR OWN context with a short summary tagged like `{#3f9a2c FOLDED}`. The original content is preserved, not lost. Call this tool with the short code(s) from those tags to get the FULL original content back AS THIS tool's result, immediately \u2014 like reading a file. Unlike `unfold`, recall does NOT force the block open: your standing context is unchanged (the block stays folded), so recall costs nothing beyond this one tool result. Use it when you need folded detail RIGHT NOW for the current step.",
    promptSnippet: "recall(codes) \u2014 read folded content right now (returned as the tool result; does not change your standing context).",
    promptGuidelines: [
      "When you see a `{#<code> FOLDED}` marker and need the full content for the current step, call `recall` with the code(s) \u2014 the full original content comes back as this tool's result immediately, and your standing context is left unchanged (the block stays folded). Prefer `recall` over `unfold` when you only need the detail once; use `unfold` when you want the block to stay open across future turns."
    ],
    parameters: Type.Object({
      codes: Type.Array(Type.String({ description: 'A fold code copied verbatim from a {#<code> FOLDED} tag, e.g. "3f9a2c". Always a string (codes may have leading zeros).' }), {
        description: "One or more fold codes whose full original content to read."
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const codes = Array.isArray(params.codes) ? params.codes.map((s) => String(s).trim()).filter((s) => s.length > 0) : [];
      if (!codes.length) {
        return { content: [{ type: "text", text: 'No fold codes given. Pass the code(s) from a {#<code> FOLDED} tag, e.g. recall({codes:["3f9a2c"]}).' }] };
      }
      if (!attached()) {
        return { content: [{ type: "text", text: "Accordion isn't attached, so nothing in your context is folded right now \u2014 it is already full." }] };
      }
      const res = await requestRecall(codes);
      if (res === null) {
        return { content: [{ type: "text", text: "Accordion did not respond. If it has detached, your context is already full; otherwise try again." }], isError: true };
      }
      const content = [];
      for (const r of res.restored) {
        content.push({ type: "text", text: `[recalled ${r?.label ?? "block"} (#${r?.code ?? "?"})]
${r?.text ?? ""}` });
      }
      if (res.missing.length) {
        content.push({ type: "text", text: `No folded block for: ${res.missing.map((c) => "#" + c).join(", ")} (already full, or not in this session's context).` });
      }
      if (!content.length) {
        content.push({ type: "text", text: "Nothing to recall." });
      }
      return { content, details: res };
    }
  });
  pi.on("resources_discover", () => {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const skillPaths = [];
      for (const name of ["accordion-context-folding", "accordion-context-recall"]) {
        const dir = path.join(here, "skills", name);
        if (fs.existsSync(dir)) skillPaths.push(dir);
      }
      if (skillPaths.length) return { skillPaths };
    } catch {
    }
    return {};
  });
}
var BROWSER_FALLBACK_PORT = DEFAULT_PORT;
export {
  BROWSER_FALLBACK_PORT,
  accordionLive as default
};
