// triptych-sdk.mjs — GENERATED ARTIFACT, DO NOT EDIT BY HAND.
// Bundled from core/conductor/remote.ts + conductors/ws/triptych/triptych.ts (and their core/ +
// conductors/in-process graph) by extension/build-remote-sdk.mjs. Regenerate with:
//     node extension/build-remote-sdk.mjs      (or: npm --prefix extension run build:remote-sdk)
// Flat ESM, runnable under plain `node`. The tree-sitter engine is NOT in here — runner.mjs
// imports ./skeleton.mjs (this directory's node_modules) and injects it into the conductor.
// Exports: runRemoteConductor, TriptychConductor.

// core/locks.ts
function hasLock(locks, name) {
  return !!locks && locks.includes(name);
}

// core/tokens.ts
var CHARS_PER_TOKEN = 4;
var BLOCK_OVERHEAD = 4;
function estTokens(s) {
  if (!s) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}
function clip(s, n) {
  const m = Math.max(1, n);
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= m ? t : t.slice(0, m - 1).trimEnd() + "\u2026";
}
function firstLine(s, n = 100) {
  const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
  return clip(line, n);
}

// core/digest.ts
var FOLDABLE_KINDS = /* @__PURE__ */ new Set(["text", "thinking", "tool_result"]);
function wireFoldable(b) {
  return FOLDABLE_KINDS.has(b.kind);
}
function foldCode(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}
function foldTag(id) {
  return `{#${foldCode(id)} FOLDED}`;
}
var digestCache = /* @__PURE__ */ new WeakMap();
var digestTokenCache = /* @__PURE__ */ new WeakMap();
function digest(b) {
  const cached = digestCache.get(b);
  if (cached !== void 0) return cached;
  const body = digestBody(b);
  const out = FOLDABLE_KINDS.has(b.kind) ? `${foldTag(b.id)} ${body}` : body;
  digestCache.set(b, out);
  return out;
}
function digestBody(b) {
  switch (b.kind) {
    case "user":
      return "\u201C" + clip(b.text, 100) + "\u201D";
    case "text":
      return clip(b.text, 120);
    case "thinking": {
      const tok = estTokens(b.text);
      const gist = firstLine(b.text, 80);
      return `thought \xB7 ~${tok} tok${gist ? " \xB7 " + gist : ""}`;
    }
    case "tool_call":
      return `${b.toolName ?? "tool"}(${clip(b.text.replace(/^\S+\s*/, ""), 70)})`;
    case "tool_result": {
      const name = b.toolName ?? "result";
      if (!b.text.trim()) return `${name} \u2192 ${b.isError ? "error" : "empty"}`;
      const lines = b.text.split("\n").filter((l) => l.trim()).length;
      const tag = b.isError ? "error" : `${lines} line${lines === 1 ? "" : "s"}`;
      const peek = firstLine(b.text, 60);
      return `${name} \u2192 ${tag}, ~${b.tokens} tok${peek ? " \xB7 " + peek : ""}`;
    }
    default:
      return clip(b.text, 80);
  }
}
function digestTokens(b) {
  const cached = digestTokenCache.get(b);
  if (cached !== void 0) return cached;
  const out = estTokens(digest(b)) + BLOCK_OVERHEAD;
  digestTokenCache.set(b, out);
  return out;
}
function substTokens(content) {
  return estTokens(content) + BLOCK_OVERHEAD;
}
var GROUP_KIND_NOUN = {
  user: ["ask", "asks"],
  text: ["reply", "replies"],
  thinking: ["thought", "thoughts"],
  tool_call: ["call", "calls"],
  tool_result: ["result", "results"]
};
var GROUP_KIND_ORDER = ["tool_result", "thinking", "text", "tool_call", "user"];
function turnSpan(members) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of members) {
    if (b.turn < lo) lo = b.turn;
    if (b.turn > hi) hi = b.turn;
  }
  if (!isFinite(lo)) return "";
  const name = (t) => t > 0 ? `turn ${t}` : "preamble";
  if (lo === hi) return name(lo);
  return lo > 0 ? `turns ${lo}\u2013${hi}` : `preamble\u2013turn ${hi}`;
}
function groupDigest(group, members) {
  const tag = foldTag(group.id);
  if (!members.length) return `${tag} group \xB7 empty`;
  const counts = /* @__PURE__ */ new Map();
  let tokens = 0;
  let ask = "";
  for (const b of members) {
    counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
    tokens += b.tokens;
    if (b.kind === "user" && !ask) ask = firstLine(b.text, 70);
  }
  const breakdown = GROUP_KIND_ORDER.filter((k) => counts.get(k)).map((k) => {
    const n = counts.get(k);
    const [one, many] = GROUP_KIND_NOUN[k];
    return `${n} ${n === 1 ? one : many}`;
  }).join(", ");
  const span = turnSpan(members);
  const head = `${tag} group \xB7 ${members.length} block${members.length === 1 ? "" : "s"}${span ? " \xB7 " + span : ""} \xB7 ~${tokens} tok`;
  const body = breakdown ? ` \xB7 ${breakdown}` : "";
  const quote = ask ? ` \xB7 \u201C${ask}\u201D` : "";
  return head + body + quote;
}
function groupDigestTokens(group, members) {
  return estTokens(groupDigest(group, members)) + BLOCK_OVERHEAD;
}

// core/wire.ts
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
function wireToBlock(w) {
  return {
    id: w.id,
    kind: w.kind,
    turn: w.turn,
    order: w.order,
    text: w.text,
    tokens: w.tokens,
    toolName: w.toolName,
    callId: w.callId,
    model: w.model,
    isError: w.isError,
    override: null,
    autoFolded: false,
    by: null
  };
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
function computeDegradedDropRuns(msgs, groups) {
  const owner = new Array(msgs.length).fill(null);
  const degradeStart = /* @__PURE__ */ new Set();
  if (!groups.length) return { owner, degradeStart };
  const memberToGroup = /* @__PURE__ */ new Map();
  for (const g of groups) for (const id of g.memberIds) if (isDurableId(id)) memberToGroup.set(id, g);
  for (let i = 0; i < msgs.length; i++) {
    const info = msgs[i];
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
    for (let i = 0; i < msgs.length; i++) {
      if (!owner[i]) continue;
      for (const c of msgs[i].calls) calls.add(c);
      for (const c of msgs[i].results) results.add(c);
    }
    for (let i = 0; i < msgs.length; i++) {
      if (!owner[i]) continue;
      const info = msgs[i];
      if (info.calls.some((c) => !results.has(c)) || info.results.some((c) => !calls.has(c))) {
        owner[i] = null;
        changedSet = true;
      }
    }
  }
  for (let stable = false; !stable; ) {
    stable = true;
    let prevRole;
    let i = 0;
    while (i < msgs.length) {
      const g = owner[i];
      if (!g) {
        prevRole = msgs[i].role;
        i++;
        continue;
      }
      let j = i + 1;
      while (j < msgs.length && owner[j] === g) j++;
      const pureDrop = g.summaryText === null && !degradeStart.has(i);
      if (!pureDrop) {
        prevRole = msgs[i].role === "assistant" ? "assistant" : "user";
        i = j;
        continue;
      }
      let k = j;
      let nextRole;
      while (k < msgs.length) {
        const g2 = owner[k];
        if (!g2) {
          nextRole = msgs[k].role;
          break;
        }
        let kj = k + 1;
        while (kj < msgs.length && owner[kj] === g2) kj++;
        if (g2.summaryText === null && !degradeStart.has(k)) {
          k = kj;
          continue;
        }
        nextRole = msgs[k].role === "assistant" ? "assistant" : "user";
        break;
      }
      const leadingProblem = prevRole === void 0 && nextRole !== void 0 && nextRole !== "user";
      const adjacencyProblem = prevRole !== void 0 && prevRole === nextRole;
      if (leadingProblem || adjacencyProblem) {
        degradeStart.add(i);
        stable = false;
        prevRole = msgs[i].role === "assistant" ? "assistant" : "user";
      }
      i = j;
    }
  }
  return { owner, degradeStart };
}
function foldOne(m, i, byId, mark) {
  if (m.role === "assistant" && Array.isArray(m.content)) {
    let parts = null;
    m.content.forEach((b, j) => {
      const id = blockId(m, i, j);
      const op = byId.get(id);
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
    const id = blockId(m, i);
    const op = byId.get(id);
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
  const { owner, degradeStart } = safeGroups.length ? computeDegradedDropRuns(
    messages.map((m, i) => ({ ...messageInfo(m, i), role: m.role })),
    safeGroups
  ) : { owner: new Array(messages.length).fill(null), degradeStart: /* @__PURE__ */ new Set() };
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
      if (g.summaryText === null && !degradeStart.has(i)) {
        changed = true;
      } else {
        const role = messages[i].role === "assistant" ? "assistant" : "user";
        const text = g.summaryText !== null ? g.summaryText : roleFloorRecap(g.id, j - i);
        out.push({ role, content: [{ type: "text", text }] });
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
function roleFloorRecap(groupId, runLength) {
  return `${foldTag(groupId)} group \xB7 ${runLength} message${runLength === 1 ? "" : "s"} dropped (kept live as a stub for wire validity)`;
}

// core/groupShape.ts
function messageKey(id) {
  const live = id.match(/^(.*):p(?:\d+|\?)$/);
  if (live) return live[1];
  const parsed = id.match(/^(.+):\d+$/);
  if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
  return id;
}
function collapsibleMessageKeys(members, requireDurable) {
  const byMsg = /* @__PURE__ */ new Map();
  for (const b of members) {
    const k = messageKey(b.id);
    const arr = byMsg.get(k);
    if (arr) arr.push(b);
    else byMsg.set(k, [b]);
  }
  const msgOrder = [...byMsg.keys()];
  const msgCalls = /* @__PURE__ */ new Map();
  const msgResults = /* @__PURE__ */ new Map();
  for (const k of msgOrder) {
    const calls = [];
    const results = [];
    for (const b of byMsg.get(k)) {
      if (!b.callId) continue;
      if (b.kind === "tool_call") calls.push(b.callId);
      else if (b.kind === "tool_result") results.push(b.callId);
    }
    msgCalls.set(k, calls);
    msgResults.set(k, results);
  }
  const removable = /* @__PURE__ */ new Set();
  for (const k of msgOrder) {
    if (requireDurable && byMsg.get(k).some((b) => !isDurableId(b.id))) continue;
    removable.add(k);
  }
  for (let changed = true; changed; ) {
    changed = false;
    const calls = /* @__PURE__ */ new Set();
    const results = /* @__PURE__ */ new Set();
    for (const k of msgOrder) {
      if (!removable.has(k)) continue;
      for (const c of msgCalls.get(k)) calls.add(c);
      for (const c of msgResults.get(k)) results.add(c);
    }
    for (const k of msgOrder) {
      if (!removable.has(k)) continue;
      if (msgCalls.get(k).some((c) => !results.has(c)) || msgResults.get(k).some((c) => !calls.has(c))) {
        removable.delete(k);
        changed = true;
      }
    }
  }
  return removable;
}

// core/truth.ts
var PROTECT_OVERFLOW_CAP = 1.25;
var LEADING_FOLD_TAG = /^\s*\{#[0-9a-z]{6} FOLDED\}\s*/;
function wireRoleOfId(id) {
  if (id.startsWith("u:") || /^m\d+:u$/.test(id)) return "user";
  if (id.startsWith("a:") || /^m\d+:p/.test(id)) return "assistant";
  if (id.startsWith("r:") || /^m\d+:r$/.test(id)) return "toolResult";
  return "other";
}
function messageCountOfRun(run) {
  let n = 0;
  let prevKey = null;
  for (const b of run) {
    const k = messageKey(b.id);
    if (k !== prevKey) {
      n++;
      prevKey = k;
    }
  }
  return n;
}
var Truth = class _Truth {
  meta;
  // ── state ───────────────────────────────────────────────────────────────
  blockLog = [];
  groupList = [];
  budgetTok = 7e4;
  contextWindowTok = null;
  protectTokensTarget = 2e4;
  /**
   * The current effective system prompt (issue #93), captured by the HOST ONLY from
   * `ExtensionContext.getSystemPrompt()` on every `context` hook firing (never at `session_start`,
   * which can race pi's own `resources_discover`-driven rebuild — see `extension/accordion.ts`'s
   * `refreshFromCtx`). `null` until the first capture — cold start, and every read-only/demo/CC/file
   * session forever (no live host ever calls the setter). Deliberately NOT a `Block`: it has no
   * index, so `canFold`/`isProtected`/grouping/pin never see it — structurally, not just policy,
   * exempt from folding. See `systemPrompt` getter and `setSystemPrompt`.
   */
  systemPromptText = null;
  systemPromptTokensVal = 0;
  /**
   * Provider-anchored calibration multiplier (issue #11, ADR 0025): `k = realTokens /
   * estimatedTokens` for the same request, snapped by the HOST ONLY (`setCalibration`, called from
   * the extension after pairing an assistant reply's real usage against the wire estimate that
   * produced it). Default 1 — a session that never observes a real pairing (cold start; read-only /
   * demo / CC / file sessions, which have no live host to ever call the setter) stays at 1 forever.
   * Stage 1 (display) shipped this dial as read-only plumbing; stage 2 (this) additionally feeds it
   * into the DECISION surface: `protectedFromIndex()` sizes the protected tail against a calibrated
   * threshold (see that method's doc), and `stats()` reports calibrated `liveTokens`/`fullTokens`
   * so a conductor's own budget-trigger math runs on real numbers. `canFold` itself still carries no
   * token threshold at all (verified — it only ever calls `isProtected`, never compares a token
   * count), so nothing there needed to change directly; it inherits the calibrated boundary
   * transitively through `isProtected`/`protectedFromIndex`. See `calTokens`.
   */
  calibrationMul = 1;
  activeLocks = [];
  activeTailTok = 0;
  holderLabel = null;
  wireAttachedFlag = false;
  /**
   * True iff a live pi WIRE is attached. Only in a live session does `classifyGroup` enforce
   * durability-aware accounting (issue #13). Demo / loaded sessions leave this false. The setter
   * bumps `rev` on an ACTUAL change (no-op on a same-value set) so the rev-keyed group-accounting
   * cache (`groupWireCache`) recomputes on a connect/disconnect transition — same "bump rev, no
   * event" shape as `setGroups` (the caller already knows the value it just set).
   */
  get wireAttached() {
    return this.wireAttachedFlag;
  }
  set wireAttached(v) {
    if (this.wireAttachedFlag === v) return;
    this.wireAttachedFlag = v;
    this.revCounter++;
  }
  /** The highest block `order` that has actually reached the model in an applied plan. */
  sentThroughOrderValue = -1;
  /**
   * Ids of blocks a strategy folded via the birth-fold exemption (folded while protected AND
   * not-yet-sent). `healProtected` skips these: the model never saw them whole, so the tail
   * growing over them yanks nothing. A strategy fold of a non-birth (sent / never-protected)
   * block is NOT here, so it heals when the tail grows over it, exactly as a human fold does.
   */
  birthFolded = /* @__PURE__ */ new Set();
  /**
   * Ids of surviving blocks that were ALREADY sent whole but a divergence rebuild pushed ABOVE the
   * scalar `sentThroughOrder` frontier — a fresh block inserted BEFORE them drags the frontier back
   * (the frontier is a prefix by `order`, so ONE early unsent block reclassifies every later block
   * never-sent). Without this set a rebuild makes blocks the model already saw whole look fresh
   * again: birth-fold-eligible, re-listed in `freshIds`. The effective "is this block sent?"
   * predicate (`sent`) is therefore the UNION `(order <= sentThroughOrder) OR (id in carriedSent)`.
   * Populated only by `rebuildFrom`; rides the snapshot so replicas agree (v15).
   */
  carriedSent = /* @__PURE__ */ new Set();
  /** Monotonic; bumps on every state change. Every event carries the post-change value. */
  revCounter = 0;
  /** Per block/group id → the rev at which it last changed (for `baseRev` stale detection). */
  lastChangedRev = /* @__PURE__ */ new Map();
  index = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  // ── rev-keyed read caches (recomputed lazily when rev changes) ───────────
  pfiCache = { rev: -1, value: 0 };
  groupWireCache = { rev: -1, map: /* @__PURE__ */ new Map() };
  /** `degradedRunKeys()`'s memo — see that method's doc comment. */
  degradeCache = { rev: -1, keys: /* @__PURE__ */ new Set() };
  constructor(parsed) {
    this.meta = parsed.meta;
    this.blockLog = parsed.blocks.slice();
    this.reindex();
    this.sentThroughOrderValue = this.blockLog.length ? this.blockLog[this.blockLog.length - 1].order : -1;
  }
  reindex() {
    this.index.clear();
    for (let i = 0; i < this.blockLog.length; i++) this.index.set(this.blockLog[i].id, i);
  }
  /**
   * Phase B replica hydration. Overwrite this Truth's ENTIRE state from a serialized host
   * snapshot and PIN `rev` to the host's, emitting NOTHING (the caller re-seeds its mirror).
   * The GUI builds a replica Truth this way so replayed events stay rev-aligned with the
   * authoritative extension-side Truth: after adopting, `rev === snapshot.rev`, and each
   * subsequent replayed input bumps rev in lockstep — a mismatch after replay ⇒ resnapshot.
   * `blocks` arrive with overlay already applied; groups/locks/config/sent/`birthFolded`/
   * `carriedSent` are set verbatim — `birthFolded` MUST round-trip (v12) or `healProtected`
   * diverges from the host: a replica that lost the set heals a block on its next housekeep that
   * the host still keeps folded, and both sides bump `rev` by exactly one, so the mismatch is
   * otherwise invisible. `carriedSent` MUST round-trip (v15) for the same silent-divergence reason:
   * a replica that lost it reclassifies a block the host recorded as already-sent back to fresh
   * (birth-fold-eligible / re-listed in `freshIds`), again with both revs still advancing in step.
   * `calibration` (v18) now FEEDS DECISION MATH (stage 2, see the field's own doc comment) — a
   * replica that lost it falls back to the safe default (1), which is a decision-affecting
   * divergence in principle (a different `protectedFromIndex()`/`stats()` reading than the host's);
   * in practice this can only happen via a stale/test literal omitting the field, never a real
   * replica (the host serializer always emits it, and a replica that ever legitimately lost track
   * would already have mismatched `rev` on the very next event and resnapshotted before the
   * divergence could matter).
   */
  adoptSnapshot(s) {
    this.blockLog = s.blocks.slice();
    this.reindex();
    this.groupList = s.groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() }));
    this.budgetTok = s.budget;
    this.contextWindowTok = s.contextWindow;
    this.protectTokensTarget = s.protectTokens;
    this.activeLocks = s.locks.slice();
    this.holderLabel = s.lockHolder;
    this.activeTailTok = s.tailTokens;
    this.wireAttachedFlag = s.wireAttached;
    this.sentThroughOrderValue = s.sentThroughOrder;
    this.birthFolded = new Set(s.birthFolded);
    this.carriedSent = new Set(s.carriedSent);
    this.calibrationMul = Number.isFinite(s.calibration) && s.calibration > 0 ? s.calibration : 1;
    const sp = s.systemPrompt;
    this.systemPromptText = sp && typeof sp.text === "string" && Number.isFinite(sp.tokens) && sp.tokens >= 0 ? sp.text : null;
    this.systemPromptTokensVal = this.systemPromptText === null ? 0 : Math.round(sp.tokens);
    this.lastChangedRev.clear();
    this.revCounter = s.rev;
    this.pfiCache = { rev: -1, value: 0 };
    this.groupWireCache = { rev: -1, map: /* @__PURE__ */ new Map() };
    this.degradeCache = { rev: -1, keys: /* @__PURE__ */ new Set() };
  }
  /**
   * Structural-DIVERGENCE rebuild (tree-nav / compaction / another extension rewriting
   * `event.messages`): build a fresh Truth from `parsed`'s blocks, then carry over `prev`'s
   * per-block overlay, `birthFolded` membership, scalar dials, and any group whose members ALL
   * survive. An id absent from the fresh block log has nothing to carry — it no longer exists.
   * `prev === null` (the very first build of a session) skips carryover entirely: there is
   * nothing yet to preserve, and a brand-new session must never inherit a PRIOR session's state.
   *
   * This is the fix for the review finding that a divergence rebuild used to construct a bare
   * `new Truth(...)` and silently drop every human/host fold, pin, group, and dial — including
   * for block ids that survived the rebuild untouched. `contextWindow` is deliberately NOT
   * carried: it is a live fact re-derived from the current model, not a preserved dial (the
   * extension re-applies it right after calling this, same as any other build).
   *
   * Housekeeping runs once at the end so the freshly-carried overlay/groups can't leave the
   * result in a state that violates the protected-tail invariant (the new block log's tail
   * boundary may differ from `prev`'s).
   */
  static rebuildFrom(prev, parsed) {
    const next = new _Truth(parsed);
    if (!prev) return next;
    next.budgetTok = prev.budgetTok;
    next.protectTokensTarget = prev.protectTokensTarget;
    next.activeLocks = prev.activeLocks.slice();
    next.holderLabel = prev.holderLabel;
    next.activeTailTok = prev.activeTailTok;
    next.calibrationMul = prev.calibrationMul;
    next.systemPromptText = prev.systemPromptText;
    next.systemPromptTokensVal = prev.systemPromptTokensVal;
    for (const b of next.blockLog) {
      const old = prev.get(b.id);
      if (!old) continue;
      b.override = old.override;
      b.autoFolded = old.autoFolded;
      b.by = old.by;
      b.subst = b.text === old.text ? old.subst : void 0;
      if (prev.birthFolded.has(b.id)) next.birthFolded.add(b.id);
    }
    let frontier = next.blockLog.length ? next.blockLog[next.blockLog.length - 1].order : -1;
    for (const b of next.blockLog) {
      const old = prev.get(b.id);
      const wasSent = old ? prev.sent(old) : false;
      if (!wasSent) frontier = Math.min(frontier, b.order - 1);
    }
    next.sentThroughOrderValue = frontier;
    for (const b of next.blockLog) {
      if (b.order <= frontier) continue;
      const old = prev.get(b.id);
      if (old && prev.sent(old)) next.carriedSent.add(b.id);
    }
    const survivors = next.index;
    next.groupList = prev.groupList.filter((g) => {
      if (!g.memberIds.every((id) => survivors.has(id))) return false;
      const idxs = g.memberIds.map((id) => survivors.get(id)).sort((a, b) => a - b);
      return idxs.every((v, k) => k === 0 || v === idxs[k - 1] + 1);
    }).map((g) => ({ ...g, memberIds: g.memberIds.slice().sort((a, b) => survivors.get(a) - survivors.get(b)) }));
    next.housekeep(/* @__PURE__ */ new Set());
    return next;
  }
  // ── events ────────────────────────────────────────────────────────────────
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(e) {
    for (const fn of this.listeners) fn(e);
  }
  get rev() {
    return this.revCounter;
  }
  // ── reads ───────────────────────────────────────────────────────────────
  get blocks() {
    return this.blockLog;
  }
  get groups() {
    return this.groupList;
  }
  get(id) {
    const i = this.index.get(id);
    return i === void 0 ? void 0 : this.blockLog[i];
  }
  get protectTokens() {
    return this.protectTokensTarget;
  }
  get budget() {
    return this.budgetTok;
  }
  get contextWindow() {
    return this.contextWindowTok;
  }
  /** The current effective system prompt, or `null` if none has been captured yet. See the private field's doc. */
  get systemPrompt() {
    return this.systemPromptText === null ? null : { text: this.systemPromptText, tokens: this.systemPromptTokensVal };
  }
  /** The current provider-anchored calibration multiplier (default 1). See `calibrationMul`'s doc. */
  get calibration() {
    return this.calibrationMul;
  }
  /**
   * Calibrated value of a raw token estimate — `Math.round(n * calibration)`. A pure helper a
   * caller routes a number it ALREADY computed (`liveTokens()`, `effTokens(b)`, a per-kind sum, …)
   * through to opt into calibration. Stage 1 (issue #11, ADR 0025) used this for DISPLAY only;
   * stage 2 additionally routes it through `stats()` (so `TruthStats.liveTokens`/`fullTokens` are
   * calibrated) and through the conductor-facing `ViewBlock.tokens`/`foldedTokens`
   * (`core/conductor/hostAdapter.ts`'s `viewBlockOf`) and `ConductorHost.countTokens` — see the
   * "convention" note on `TruthStats` for why calibrating every conductor read surface (rather than
   * leaving per-block reads raw) is the coherent choice. `protectedFromIndex()` does NOT call this
   * helper — it converts the TARGET into raw-estimate space with one division instead (see that
   * method's doc for why). One multiplier necessarily SMEARS the fixed tool-schema overhead (which
   * belongs to no block) proportionally across every block rather than carrying it as its own line
   * item — `real = base + k·est` would be the honest affine model; this ships the pure multiplier
   * knowingly (ADR 0025's Deferred section). As of issue #93, the system prompt is no longer part of
   * that smear: `liveTokens()`/`fullTokens()` include it directly, so only tool-call-schema overhead
   * remains folded into `k` (see `liveTokens()`'s doc and ADR 0025's addendum).
   */
  calTokens(n) {
    return Math.round(n * this.calibrationMul);
  }
  get locks() {
    return this.activeLocks;
  }
  get lockHolder() {
    return this.activeLocks.length ? this.holderLabel : null;
  }
  /** Ids currently birth-folded (see `birthFolded` above). A snapshot must carry this verbatim. */
  get birthFoldedIds() {
    return [...this.birthFolded];
  }
  /** Ids in the carried-sent set (see `carriedSent`). A snapshot must carry this verbatim (v15). */
  get carriedSentIds() {
    return [...this.carriedSent];
  }
  /** The tail target the holder enforces while holding `tail-size` (0 when not held). */
  get activeTailTokens() {
    return this.isLocked("tail-size") ? this.activeTailTok : 0;
  }
  isLocked(name) {
    return hasLock(this.activeLocks, name);
  }
  /** The highest block `order` whose content has reached the model (serialized wire). The scalar
   *  frontier ONLY — `carriedSent` (a rebuild's per-id preserved sent-ness) is separate; use
   *  `sent(b)`/`isSent(id)` for the effective predicate. */
  get sentThroughOrder() {
    return this.sentThroughOrderValue;
  }
  /**
   * Has this block's content reached the model in an applied plan? The UNION of the scalar
   * `order`-prefix frontier and the per-id `carriedSent` set a divergence rebuild preserves (see
   * `carriedSent`) — so a block the model saw whole stays "sent" even after a fresh earlier block
   * drags the frontier back below it. Every consumer of sent-ness (birth-fold eligibility,
   * `canFold`'s wire guard, the host adapter's `freshIds`) reads this predicate, so they all agree.
   */
  sent(b) {
    return b.order <= this.sentThroughOrderValue || this.carriedSent.has(b.id);
  }
  /** Id form of `sent` — for a caller holding an id but not the `Block` (the extension ingress
   *  will switch to this). Unknown id ⇒ false (a block we don't hold was never sent from here). */
  isSent(id) {
    const b = this.get(id);
    return b ? this.sent(b) : false;
  }
  /** A human override owns this block (pin / manual fold / manual unfold). */
  held(b) {
    return b.override !== null;
  }
  isFolded(b) {
    const w = this.groupWire().get(b.id);
    if (w) return w.collapsed;
    if (b.override === "folded") return true;
    if (b.override === "pinned" || b.override === "unfolded") return false;
    return b.autoFolded;
  }
  /** Tokens this block currently costs the live context. */
  effTokens(b) {
    const w = this.groupWire().get(b.id);
    if (w) return w.tokens;
    if (!this.isFolded(b)) return b.tokens;
    return b.subst !== void 0 ? substTokens(b.subst) : digestTokens(b);
  }
  /** What a folded block renders / the agent receives: the strategy's subst if any, else the
   *  engine's per-kind digest (which carries the `{#code FOLDED}` recovery tag). */
  digestOf(b) {
    return b.subst ?? digest(b);
  }
  /** The folded-token cost of a block (its digest/subst size). */
  foldedTokensOf(b) {
    return b.subst !== void 0 ? substTokens(b.subst) : digestTokens(b);
  }
  /**
   * Issue #93: includes the system prompt's raw token estimate (0 when uncaptured — every CC/demo/
   * file session, and a live session before its first `context` hook). This un-smears the system
   * prompt out of `extension/accordion.ts`'s calibration pairing (`pendingWireEst`), which reads this
   * method directly — ADR 0025's documented "smearing caveat" previously absorbed the system prompt's
   * real cost into `k` because `est` excluded it while `real` (provider usage) never did. Tool-schema
   * overhead (also belonging to no block) remains smeared; only the system prompt's contribution is
   * now a real, separately-estimated term. See the ADR's issue-#93 addendum.
   */
  liveTokens() {
    let n = this.systemPromptTokensVal;
    for (const b of this.blockLog) n += this.effTokens(b);
    return n;
  }
  fullTokens() {
    let n = this.systemPromptTokensVal;
    for (const b of this.blockLog) n += b.tokens;
    return n;
  }
  foldedCount() {
    let n = 0;
    for (const b of this.blockLog) if (this.isFolded(b)) n++;
    return n;
  }
  stats() {
    return {
      rev: this.revCounter,
      liveTokens: this.calTokens(this.liveTokens()),
      fullTokens: this.calTokens(this.fullTokens()),
      budget: this.budgetTok,
      contextWindow: this.contextWindowTok,
      protectTokens: this.protectTokensTarget,
      protectedFromIndex: this.protectedFromIndex(),
      blockCount: this.blockLog.length
    };
  }
  /**
   * Can `by` fold this block right now? The shared predicate. A human never folds a protected
   * block; a strategy (`by:"auto"`) MAY fold a protected block via the BIRTH-FOLD exemption iff
   * the block has not yet been sent (never crossed the wire live, so there is nothing to yank).
   */
  canFold(b, by = "you") {
    if (!wireFoldable(b)) return false;
    if (this.inFoldedGroup(b.id)) return false;
    if (this.wireAttached && !isDurableId(b.id)) return false;
    if (by === "you") {
      if (b.override === "pinned") return false;
      return !this.isProtected(b);
    }
    if (b.override !== null) return false;
    if (this.isProtected(b)) return !this.sent(b);
    return true;
  }
  // ── protected working tail ──────────────────────────────────────────────
  /**
   * The first block index inside the protected working tail. Issue #11 stage 2 (ADR 0025):
   * `protectTokens` (and a `tail-size` holder's enforced `activeTailTokens`) is the USER-MEANINGFUL
   * dial — sized in REAL tokens — so the walk below must size the tail against a CALIBRATED
   * reading of the block log, not the raw chars/4 sum it used to compare against directly.
   *
   * See `computeProtectedFromIndex` for the exact mechanism (one division of the target, not a
   * `calTokens` multiplication per block) and why that choice is the deterministic one across a
   * host/replica pair.
   */
  protectedFromIndex() {
    if (this.pfiCache.rev === this.revCounter) return this.pfiCache.value;
    const value = this.computeProtectedFromIndex();
    this.pfiCache = { rev: this.revCounter, value };
    return value;
  }
  computeProtectedFromIndex() {
    const blocks = this.blockLog;
    if (!blocks.length) return 0;
    const targetReal = this.isLocked("tail-size") ? this.activeTailTok : this.protectTokensTarget;
    if (targetReal === 0) return blocks.length;
    const target = targetReal / this.calibrationMul;
    const cap = target * PROTECT_OVERFLOW_CAP;
    let sum = blocks[blocks.length - 1].tokens;
    if (sum >= target) return blocks.length - 1;
    for (let i = blocks.length - 2; i >= 0; i--) {
      const next = sum + blocks[i].tokens;
      if (next > cap) return i + 1;
      sum = next;
      if (sum >= target) return i;
    }
    return 0;
  }
  isProtected(b) {
    return (this.index.get(b.id) ?? -1) >= this.protectedFromIndex();
  }
  protectedTokens() {
    let n = 0;
    const pf = this.protectedFromIndex();
    for (let i = pf; i < this.blockLog.length; i++) n += this.blockLog[i].tokens;
    return n;
  }
  // ── groups ──────────────────────────────────────────────────────────────
  groupOf(b) {
    for (const g of this.groupList) if (g.memberIds.includes(b.id)) return g;
    return void 0;
  }
  groupById(id) {
    return this.groupList.find((g) => g.id === id);
  }
  groupMembers(g) {
    const out = [];
    for (const id of g.memberIds) {
      const b = this.get(id);
      if (b) out.push(b);
    }
    return out;
  }
  inFoldedGroup(id) {
    for (const g of this.groupList) if (g.folded && g.memberIds.includes(id)) return true;
    return false;
  }
  isDropGroup(g) {
    return g.digest === null || g.digest === "";
  }
  groupSummary(g) {
    if (this.isDropGroup(g)) return "";
    if (typeof g.digest === "string" && g.digest) return g.digest;
    const c = this.classifyGroup(g);
    return groupDigest(g, c.collapsedMembers.length ? c.collapsedMembers : c.members);
  }
  groupFullTokens(g) {
    let n = 0;
    for (const b of this.groupMembers(g)) n += b.tokens;
    return n;
  }
  groupLiveTokens(g) {
    if (!g.folded) {
      let n2 = 0;
      for (const b of this.groupMembers(g)) n2 += this.effTokens(b);
      return n2;
    }
    const c = this.classifyGroup(g);
    let n = 0;
    for (const run of c.collapsedRuns) n += this.runWireTok(g, c, run);
    for (const id of c.stragglers) n += this.get(id)?.tokens ?? 0;
    return n;
  }
  groupSavedTokens(g) {
    return this.groupFullTokens(g) - this.groupLiveTokens(g);
  }
  groupStragglerCount(g) {
    return g.folded ? this.classifyGroup(g).stragglers.size : 0;
  }
  groupWire() {
    if (this.groupWireCache.rev === this.revCounter) return this.groupWireCache.map;
    const m = /* @__PURE__ */ new Map();
    for (const g of this.groupList) {
      if (!g.folded) continue;
      const c = this.classifyGroup(g);
      const runTok = /* @__PURE__ */ new Map();
      for (const run of c.collapsedRuns) runTok.set(run[0].id, this.runWireTok(g, c, run));
      for (const b of c.members) {
        if (c.collapsed.has(b.id)) m.set(b.id, { tokens: runTok.get(b.id) ?? 0, collapsed: true });
        else m.set(b.id, { tokens: b.tokens, collapsed: false });
      }
    }
    this.groupWireCache = { rev: this.revCounter, map: m };
    return m;
  }
  /**
   * The wire cost of ONE collapsed run within a folded group. A REPLACE group (`g.digest` a
   * string, or `undefined` → auto-recap) inserts the SAME summary text for every run of that
   * group (`applyPlan`'s Phase B reuses `g.summaryText`/the auto-digest verbatim per run — see
   * the "INTERIOR straggler (TWO runs)" cross-validation test), so charging every run the same
   * scalar is correct and unchanged from before.
   *
   * A DROP group (`isDropGroup`) is NOT uniform across runs: `applyPlan`'s role-validity floor
   * (ADR 0006's open watch item, closed by `computeDegradedDropRuns`) can independently degrade
   * ONE run of a drop group to a one-message recap while its siblings still vanish for free — a
   * single "0 for every run" shortcut would under-count a degraded run's real cost and make the
   * GUI's savings readout LIE about what the model actually receives (the one thing this repo
   * promises never happens). `degradedRunKeys()` re-derives the EXACT same verdict `applyPlan`
   * would reach for this run — via the SAME exported `computeDegradedDropRuns` function, not a
   * parallel re-implementation of the role-adjacency check — so this can never silently drift
   * from the wire. A degraded run's cost is the recap's OWN token estimate, built from the exact
   * SAME text `applyPlan` synthesizes (`roleFloorRecap`, exported from `wire.ts` for this reason)
   * so the number matches token-for-token, not just in shape.
   */
  runWireTok(g, c, run) {
    if (!c.carrier) return 0;
    if (this.isDropGroup(g)) {
      if (!this.degradedRunKeys().has(messageKey(run[0].id))) return 0;
      return estTokens(roleFloorRecap(g.id, messageCountOfRun(run))) + BLOCK_OVERHEAD;
    }
    if (typeof g.digest === "string" && g.digest) return estTokens(g.digest) + BLOCK_OVERHEAD;
    return groupDigestTokens(g, c.collapsedMembers);
  }
  /**
   * Which collapsed runs (identified by their carrier block's `messageKey`) `applyPlan`'s
   * role-validity floor would degrade to a recap RIGHT NOW, across every folded group at once —
   * memoized per `rev` (like `groupWire`/`protectedFromIndex`) since every group's accounting
   * reads it.
   *
   * WHY this must call the wire's OWN function and never a re-derived approximation: the floor's
   * verdict for one run depends on global context — which OTHER runs (this group's or another
   * group's) survive, degrade, or vanish right next to it — exactly the cross-run cascade
   * `computeDegradedDropRuns` already implements for `applyPlan`. Re-deriving an "equivalent"
   * check here would inevitably diverge on some edge case (a second folded group nearby, a
   * cascaded chain of drops), and drift between the wire and the accounting is precisely the bug
   * this method exists to close — the UI's claimed savings would once again lie about what the
   * model actually received. Calling the SAME function makes drift structurally impossible: same
   * inputs in, same verdict out, whether that function runs inside `applyPlan` (host, real
   * `PiMessage[]`) or here (host OR replica, reconstructed from `Block`s).
   *
   * `Truth` never holds pi's real messages (only the extension does, and only transiently, as
   * `serializeWire`'s parameter) — but a live `Block`'s own id already encodes which wire-role
   * class produced it (`wireRoleOfId`, the inverse of `blockId`'s prefix scheme), so the needed
   * `WireMsgShape[]` is reconstructed from `blockLog` alone (`buildWireShapes`), same for the
   * host and a replica that only ever adopted a snapshot.
   *
   * PERFORMANCE: one O(blockCount) pass to reconstruct `WireMsgShape[]` plus `computeGroupOps()`
   * (O(foldedGroups), already paid by `serializeWire` on the host) — no worse an order than the
   * O(blockCount) `liveTokens()`/`fullTokens()` passes this same rev change already triggers, and
   * skipped entirely (no reconstruction at all) when no group is folded.
   */
  degradedRunKeys() {
    if (this.degradeCache.rev === this.revCounter) return this.degradeCache.keys;
    const groups = this.computeGroupOps();
    const keys = /* @__PURE__ */ new Set();
    if (groups.length) {
      const { shapes, keys: msgKeys } = this.buildWireShapes();
      const { degradeStart } = computeDegradedDropRuns(shapes, groups);
      for (const idx of degradeStart) keys.add(msgKeys[idx]);
    }
    this.degradeCache = { rev: this.revCounter, keys };
    return keys;
  }
  /** Reconstruct one `WireMsgShape` per logical message in `blockLog`, grouped by `messageKey`
   *  (blocks sharing a key are always contiguous — see `messageCountOfRun`) — the `Block`-only
   *  equivalent of `messages.map((m,i) => ({...messageInfo(m,i), role: m.role}))`, which is all
   *  `applyPlan` itself builds from real `PiMessage[]` before calling `computeDegradedDropRuns`. */
  buildWireShapes() {
    const shapes = [];
    const keys = [];
    let curKey = null;
    let ids = [];
    let calls = [];
    let results = [];
    let hasNonDurable = false;
    const flush = () => {
      if (curKey === null) return;
      shapes.push({ role: wireRoleOfId(ids[0]), ids, calls, results, hasNonDurable });
      keys.push(curKey);
    };
    for (const b of this.blockLog) {
      const k = messageKey(b.id);
      if (k !== curKey) {
        flush();
        curKey = k;
        ids = [];
        calls = [];
        results = [];
        hasNonDurable = false;
      }
      ids.push(b.id);
      if (!isDurableId(b.id)) hasNonDurable = true;
      if (b.callId) {
        if (b.kind === "tool_call") calls.push(b.callId);
        else if (b.kind === "tool_result") results.push(b.callId);
      }
    }
    flush();
    return { shapes, keys };
  }
  /**
   * Classify a group's members for accounting + the wire. The durability/tool-pair fixpoint that
   * decides which MESSAGES actually collapse is `collapsibleMessageKeys` (core/groupShape.ts) —
   * exported and pure so a conductor can ask the SAME question before proposing a group, rather
   * than re-deriving a second copy of the rule that could drift from the one enforced here (the
   * same reason `computeDegradedDropRuns` lives in `core/wire.ts`).
   */
  classifyGroup(g) {
    const members = [];
    for (const id of g.memberIds) {
      const b = this.get(id);
      if (b) members.push(b);
    }
    const removable = collapsibleMessageKeys(members, this.wireAttached);
    const collapsed = /* @__PURE__ */ new Set();
    const stragglers = /* @__PURE__ */ new Set();
    const collapsedMembers = [];
    const collapsedRuns = [];
    let run = null;
    for (const b of members) {
      if (removable.has(messageKey(b.id))) {
        collapsed.add(b.id);
        collapsedMembers.push(b);
        if (run) run.push(b);
        else collapsedRuns.push(run = [b]);
      } else {
        stragglers.add(b.id);
        run = null;
      }
    }
    return { members, collapsedMembers, collapsed, stragglers, carrier: collapsedMembers[0]?.id ?? null, collapsedRuns };
  }
  /**
   * Raw replace of the group overlay — a test / wire-apply seam that BYPASSES group-op validation
   * (durability, protected-tail, overlap). Used by the store's `groups` setter to inject groups
   * the way a wire plan would. Bumps the rev so the rev-keyed accounting caches recompute; emits
   * no event (the caller projects the mirror itself).
   */
  setGroups(groups) {
    this.groupList = groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() }));
    this.revCounter++;
  }
  snappedRange(startId, endId) {
    const i0 = this.index.get(startId);
    const i1 = this.index.get(endId);
    if (i0 === void 0 || i1 === void 0) return null;
    let lo = Math.min(i0, i1);
    let hi = Math.max(i0, i1);
    const keyLo = messageKey(this.blockLog[lo].id);
    while (lo > 0 && messageKey(this.blockLog[lo - 1].id) === keyLo) lo--;
    const keyHi = messageKey(this.blockLog[hi].id);
    while (hi < this.blockLog.length - 1 && messageKey(this.blockLog[hi + 1].id) === keyHi) hi++;
    const ids = [];
    for (let i = lo; i <= hi; i++) ids.push(this.blockLog[i].id);
    return ids;
  }
  // ── append ────────────────────────────────────────────────────────────────
  /** Ingest blocks (idempotent by id). A repeated id is dropped — its fold state is preserved. */
  append(blocks) {
    if (!blocks.length) return [];
    const fresh = [];
    for (const b of blocks) {
      if (this.index.has(b.id)) continue;
      this.index.set(b.id, this.blockLog.length + fresh.length);
      fresh.push(b);
    }
    if (!fresh.length) return [];
    this.blockLog.push(...fresh);
    const touched = /* @__PURE__ */ new Set();
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const b of fresh) this.lastChangedRev.set(b.id, rev);
    for (const id of touched) this.lastChangedRev.set(id, rev);
    const ev = { type: "appended", blocks: fresh, rev };
    this.emit(ev);
    return [ev];
  }
  // ── config dials ────────────────────────────────────────────────────────
  setBudget(n) {
    if (!Number.isFinite(n)) return;
    this.budgetTok = Math.max(1e3, Math.round(n));
    const touched = /* @__PURE__ */ new Set();
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const id of touched) this.lastChangedRev.set(id, rev);
    this.emit({ type: "config", budget: this.budgetTok, rev });
  }
  setContextWindow(n) {
    if (!Number.isFinite(n)) return;
    this.contextWindowTok = n;
    const rev = ++this.revCounter;
    this.emit({ type: "config", contextWindow: this.contextWindowTok, rev });
  }
  /**
   * HOST-ONLY (issue #93): set the current effective system prompt. Called from
   * `extension/accordion.ts`'s `refreshFromCtx` on every `context` hook firing, only when the value
   * actually changed (the caller diffs against `this.systemPrompt` first) — so in the common case
   * this fires once near session start and never again. No `housekeep()` call: unlike `budget`/
   * `protectTokens`/`calibration`, the system prompt occupies no block index and can never move
   * `protectedFromIndex()`, so there is nothing to heal.
   */
  setSystemPrompt(text, tokens) {
    if (typeof text !== "string" || !Number.isFinite(tokens) || tokens < 0) return;
    this.systemPromptText = text;
    this.systemPromptTokensVal = Math.round(tokens);
    const rev = ++this.revCounter;
    this.emit({ type: "config", systemPrompt: { text: this.systemPromptText, tokens: this.systemPromptTokensVal }, rev });
  }
  setProtect(n) {
    if (this.isLocked("tail-size")) return;
    if (!Number.isFinite(n)) return;
    this.protectTokensTarget = Math.max(0, Math.round(n));
    const touched = /* @__PURE__ */ new Set();
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const id of touched) this.lastChangedRev.set(id, rev);
    this.emit({ type: "config", protectTokens: this.protectTokensTarget, rev });
  }
  /**
   * HOST-ONLY calibration snap (issue #11 stage 1, ADR 0025): `k = realTokens / estWireTokens` for
   * the request that just completed. Raw snap, no clamp, no smoothing/EMA — owner-approved v1
   * policy: the dial always reflects the MOST RECENT observation, not a running average. There is
   * no `WireCommand` kind for this — a client can never call it; only the extension's own host code
   * does, after pairing an assistant message's real usage against the estimate of the wire that
   * produced it (see `extension/accordion.ts`'s `maybeObserveCalibration`). A non-finite or
   * non-positive `k` is refused (poisons the dial / forks replicas via JSON `null`), the same guard
   * shape as `setBudget`/`setProtect`.
   *
   * HOUSEKEEP (issue #11 stage 2 F2, ADR 0025): `protectedFromIndex()` sizes the protected tail
   * against a calibration-converted threshold (`targetReal / calibration` — see
   * `computeProtectedFromIndex`'s doc), so `calibration` is a THIRD boundary-moving dial alongside
   * `budget`/`protectTokens` — a `k` decrease grows the raw-estimate threshold and can leave folds/
   * groups standing inside the now-larger protected tail. Run `housekeep()` + stamp
   * `lastChangedRev` exactly like `setBudget`/`setProtect` do, so a k-decrease heals any fold/group
   * the tail just grew over in the SAME rev it moved, instead of leaving it stale until the next
   * unrelated mutation happens to call `housekeep()`.
   */
  setCalibration(k) {
    if (!Number.isFinite(k) || k <= 0) return;
    this.calibrationMul = k;
    const touched = /* @__PURE__ */ new Set();
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const id of touched) this.lastChangedRev.set(id, rev);
    this.emit({ type: "config", calibration: this.calibrationMul, rev });
  }
  markSent(order) {
    if (order <= this.sentThroughOrderValue) return;
    this.sentThroughOrderValue = order;
    const rev = ++this.revCounter;
    this.emit({ type: "sent", throughOrder: this.sentThroughOrderValue, rev });
  }
  // ── locks (ADR 0011) ──────────────────────────────────────────────────────
  setLocks(locks, holder, tailTokens = 0) {
    this.activeLocks = locks.slice();
    this.holderLabel = holder;
    this.activeTailTok = Number.isFinite(tailTokens) ? Math.max(0, Math.round(tailTokens)) : 0;
    const touched = /* @__PURE__ */ new Set();
    this.releaseLockedDomains(this.activeLocks, touched);
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const id of touched) this.lastChangedRev.set(id, rev);
    this.emit({ type: "locks", locks: this.activeLocks, holder: this.holderLabel, tailTokens: this.activeTailTok, rev });
  }
  /**
   * Release the involvement locks. `inheritTail` (the conductor-detach path) closes the
   * freeze-safety hole: a `tail-size` conductor enforces a small (often zero) tail while it holds
   * the session; on plain detach `protectTokens` snaps BACK to the human's larger dial, and the
   * very next housekeep then prunes the (freeze-converted, human-owned) whole-session group and
   * heals the frozen folds — destroying exactly the work `freeze` promised to preserve. With
   * `inheritTail:true`, the enforced tail is adopted as `protectTokens` BEFORE the lock releases,
   * so the protected boundary does NOT snap back; the human regains the dial and re-expanding it
   * later is their own conscious act (normal healing then applies, and F3 makes that heal
   * complete). Plain `clearLocks()` keeps the legacy snap-back behavior.
   *
   * No protocol change: `protectTokens` already rides `config` events, so the inherited value is
   * emitted as one — a replica that later resnapshots (the config lands while its own `tail-size`
   * lock is momentarily still set) recovers the inherited value from the fresh snapshot. The
   * config event fires FIRST so any divergence surfaces as a rev mismatch (⇒ resnapshot), never a
   * silent state fork. Wave 2 wires `LiveConductorHost.detachActive` to pass `{inheritTail:true}`.
   */
  clearLocks(opts) {
    const inheritedTail = opts?.inheritTail && this.isLocked("tail-size") ? this.activeTailTok : null;
    this.activeLocks = [];
    this.holderLabel = null;
    this.activeTailTok = 0;
    if (inheritedTail !== null) {
      this.protectTokensTarget = inheritedTail;
      const crev = ++this.revCounter;
      this.emit({ type: "config", protectTokens: this.protectTokensTarget, rev: crev });
    }
    const touched = /* @__PURE__ */ new Set();
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const id of touched) this.lastChangedRev.set(id, rev);
    this.emit({ type: "locks", locks: this.activeLocks, holder: null, tailTokens: 0, rev });
  }
  releaseLockedDomains(locks, touched) {
    const lockHuman = hasLock(locks, "human-steering");
    const lockAgent = hasLock(locks, "agent-unfold");
    if (!lockHuman && !lockAgent) return;
    for (const b of this.blockLog) {
      const human = b.by === "you" && (b.override === "pinned" || b.override === "folded" || b.override === "unfolded");
      const agentUnfold = b.by === "agent" && b.override === "unfolded";
      if (lockHuman && human || lockAgent && agentUnfold) {
        b.override = null;
        b.by = null;
        this.birthFolded.delete(b.id);
        touched.add(b.id);
      }
    }
    if (lockHuman && this.groupList.length) {
      const kept = this.groupList.filter((g) => g.by === "auto");
      if (kept.length !== this.groupList.length) this.groupList = kept;
    }
  }
  // ── housekeeping ──────────────────────────────────────────────────────────
  housekeep(touched) {
    this.pruneProtectedGroups(touched);
    this.healProtected(touched);
  }
  pruneProtectedGroups(touched) {
    if (!this.groupList.length) return;
    const pf = this.protectedFromIndexUncached();
    const kept = this.groupList.filter((g) => !g.memberIds.some((id) => (this.index.get(id) ?? Infinity) >= pf));
    if (kept.length !== this.groupList.length) {
      for (const g of this.groupList) if (!kept.includes(g)) touched.add(g.id);
      this.groupList = kept;
    }
  }
  /**
   * Engine invariant — protection is absolute for the human. Heal a HUMAN fold the tail has grown
   * over, and a STRATEGY fold of a block the model already saw whole, in ONE coherent pass that
   * clears EVERY fold field so nothing half-heals.
   *
   * Never touched:
   *   - a PIN (`override === "pinned"`) — protection never revokes a hard pin, and clearing `by`
   *     underneath it would corrupt the pin's provenance;
   *   - a sticky UNFOLD (`override === "unfolded"`) — a human/agent decision to hold the block open
   *     (ADR 0005) is not a fold to heal, and it is already live;
   *   - a BIRTH-FOLD (strategy fold applied while protected AND unsent) — the model never saw it
   *     whole, so the tail growing over it yanks nothing.
   *
   * Everything else that is folded — a human fold (`override:"folded"`), a strategy fold
   * (`autoFolded`), a `replace` subst, OR a freeze-converted fold (which is `override:"folded"`
   * AND `autoFolded` AND carries a `subst`) — is fully reset in the single branch below. The old
   * two-branch shape left a frozen fold half-healed (cleared the override but left `autoFolded`/
   * `subst`, so `isFolded` stayed true) and could zero a pin's `by`; this pass fixes both.
   */
  healProtected(touched) {
    const pf = this.protectedFromIndexUncached();
    for (let i = pf; i < this.blockLog.length; i++) {
      const b = this.blockLog[i];
      if (b.override === "pinned" || b.override === "unfolded") continue;
      if (this.birthFolded.has(b.id)) continue;
      if (b.override === "folded" || b.autoFolded || b.subst !== void 0) {
        b.override = null;
        b.autoFolded = false;
        b.subst = void 0;
        b.by = null;
        touched.add(b.id);
      }
    }
  }
  /** protectedFromIndex without touching the rev-keyed cache (used mid-mutation before rev bumps). */
  protectedFromIndexUncached() {
    return this.computeProtectedFromIndex();
  }
  // ── the single write path ─────────────────────────────────────────────────
  apply(ops, by, baseRev) {
    const results = [];
    const touched = /* @__PURE__ */ new Set();
    let didReset = false;
    for (const op of ops) {
      const r = this.applyOne(op, by, baseRev, touched);
      results.push(r);
      if (r.applied && op.kind === "resetAll") didReset = true;
    }
    const anyApplied = results.some((r) => r.applied);
    if (!anyApplied) return { rev: this.revCounter, results };
    this.housekeep(touched);
    const rev = ++this.revCounter;
    for (const id of touched) this.lastChangedRev.set(id, rev);
    if (didReset) {
      const otherResults = results.filter((r) => r.applied && r.op.kind !== "resetAll");
      if (otherResults.length) this.emit({ type: "ops-applied", by, results: otherResults, rev });
      this.emit({ type: "reset", rev });
    } else {
      this.emit({ type: "ops-applied", by, results, rev });
    }
    return { rev, results };
  }
  stale(id, baseRev) {
    if (baseRev === void 0) return false;
    const lc = this.lastChangedRev.get(id);
    return lc !== void 0 && lc > baseRev;
  }
  applyOne(op, by, baseRev, touched) {
    switch (op.kind) {
      case "fold":
        return this.opFold(op, by, baseRev, touched);
      case "unfold":
        return this.opUnfold(op, by, baseRev, touched);
      case "pin":
        return this.opPin(op, by, baseRev, touched);
      case "unpin":
        return this.opUnpin(op, by, baseRev, touched);
      case "auto":
        return this.opAuto(op, by, baseRev, touched);
      case "replace":
        return this.opReplace(op, by, baseRev, touched);
      case "group":
        return this.opGroup(op, by, baseRev, touched);
      case "ungroup":
        return this.opUngroup(op, by, baseRev, touched);
      case "foldGroup":
        return this.opFoldGroup(op, by, baseRev, touched);
      case "unfoldGroup":
        return this.opUnfoldGroup(op, by, baseRev, touched);
      case "resetAll":
        return this.opReset(op, by, touched);
      case "freeze":
        return this.opFreeze(op, touched);
    }
  }
  // A per-op result helper.
  done(op, touched, id) {
    touched.add(id);
    return { op, applied: true };
  }
  clamp(op, reason, detail) {
    return { op, applied: false, clamped: reason, detail };
  }
  // Multi-id ops fold their per-id outcome into one result (applied iff ANY id applied). The batch
  // `applied`/`clamped` stay what existing callers read; `perId` records EACH id's outcome so the
  // replica-facing event can forward only the ids that actually applied (see the `perId` doc in
  // ops.ts and `wireEventFromTruthEvent`) — a per-id clamp must never replay on a baseRev-less
  // replica and diverge it while both revs still advance in lockstep.
  eachId(op, touched, fn) {
    const perId = [];
    let applied = false;
    let lastClamp;
    for (const id of op.ids) {
      const c = fn(id);
      if (c === null) {
        applied = true;
        touched.add(id);
        perId.push({ id, applied: true });
      } else {
        lastClamp = c;
        perId.push({ id, applied: false, reason: c });
      }
    }
    return applied ? { op, applied: true, perId } : { op, applied: false, clamped: lastClamp ?? "noop", perId };
  }
  opFold(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    return this.eachId(op, touched, (id) => {
      const b = this.get(id);
      if (!b) return "unknown-id";
      if (this.stale(id, baseRev)) return "stale";
      if (this.inFoldedGroup(id)) return "grouped";
      if (!wireFoldable(b)) return "not-foldable";
      if (this.wireAttached && !isDurableId(id)) return "non-durable";
      if (by === "you") {
        if (b.override === "pinned") return "human-override";
        if (this.isProtected(b)) return "protected";
        b.override = "folded";
        b.by = "you";
        b.subst = void 0;
        this.birthFolded.delete(id);
        return null;
      }
      if (b.override !== null) return "human-override";
      if (this.isProtected(b)) {
        if (this.sent(b)) return "protected";
        this.birthFolded.add(id);
      }
      b.autoFolded = true;
      b.by = "auto";
      b.subst = op.digest && op.digest.length ? op.digest : void 0;
      return null;
    });
  }
  opReplace(op, by, baseRev, touched) {
    if (by === "you") return this.clamp(op, "not-foldable", "replace is a strategy op");
    const b = this.get(op.id);
    if (!b) return this.clamp(op, "unknown-id");
    if (this.stale(op.id, baseRev)) return this.clamp(op, "stale");
    if (this.inFoldedGroup(op.id)) return this.clamp(op, "grouped");
    if (b.override !== null) return this.clamp(op, "human-override");
    if (!wireFoldable(b)) return this.clamp(op, "not-foldable");
    if (this.wireAttached && !isDurableId(op.id)) return this.clamp(op, "non-durable");
    if (this.isProtected(b)) {
      if (this.sent(b)) return this.clamp(op, "protected");
      this.birthFolded.add(op.id);
    }
    b.autoFolded = true;
    b.by = "auto";
    const recoverable = op.recoverable ?? true;
    if (op.content === "") {
      b.subst = void 0;
    } else if (recoverable) {
      b.subst = `${foldTag(op.id)} ${op.content.replace(LEADING_FOLD_TAG, "")}`;
    } else {
      b.subst = op.content;
    }
    return this.done(op, touched, op.id);
  }
  opUnfold(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    if (by === "agent" && this.isLocked("agent-unfold")) return this.clamp(op, "locked");
    return this.eachId(op, touched, (id) => {
      const b = this.get(id);
      if (!b) return "unknown-id";
      if (this.stale(id, baseRev)) return "stale";
      if (this.inFoldedGroup(id)) return "grouped";
      if (by === "agent") {
        if (b.override === "pinned") return "human-override";
        if (!this.isFolded(b)) return "noop";
        b.override = "unfolded";
        b.by = "agent";
        this.birthFolded.delete(id);
        return null;
      }
      if (by === "auto") {
        if (b.override !== null) return "human-override";
        if (!b.autoFolded && b.subst === void 0) return "noop";
        b.autoFolded = false;
        b.subst = void 0;
        b.by = null;
        this.birthFolded.delete(id);
        return null;
      }
      b.override = "unfolded";
      b.by = "you";
      b.subst = void 0;
      this.birthFolded.delete(id);
      return null;
    });
  }
  opPin(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    return this.eachId(op, touched, (id) => {
      const b = this.get(id);
      if (!b) return "unknown-id";
      if (this.stale(id, baseRev)) return "stale";
      if (this.inFoldedGroup(id)) return "grouped";
      if (by === "you") {
        b.override = "pinned";
        b.by = "you";
        b.subst = void 0;
        this.birthFolded.delete(id);
        return null;
      }
      if (b.override !== null) return "human-override";
      if (!b.autoFolded && b.subst === void 0) return "noop";
      b.autoFolded = false;
      b.subst = void 0;
      b.by = null;
      this.birthFolded.delete(id);
      return null;
    });
  }
  opUnpin(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    return this.eachId(op, touched, (id) => {
      const b = this.get(id);
      if (!b) return "unknown-id";
      if (this.stale(id, baseRev)) return "stale";
      if (b.override !== "pinned") return "noop";
      if (by !== "you" && b.by === "you") return "human-override";
      b.override = null;
      b.by = by === "you" ? "you" : null;
      return null;
    });
  }
  opAuto(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    return this.eachId(op, touched, (id) => {
      const b = this.get(id);
      if (!b) return "unknown-id";
      if (this.stale(id, baseRev)) return "stale";
      if (this.inFoldedGroup(id)) return "grouped";
      if (by === "you") {
        b.override = null;
        b.by = null;
        this.birthFolded.delete(id);
        return null;
      }
      if (b.override !== null) return "human-override";
      if (!b.autoFolded && b.subst === void 0) return "noop";
      b.autoFolded = false;
      b.subst = void 0;
      b.by = null;
      this.birthFolded.delete(id);
      return null;
    });
  }
  opGroup(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    if (!op.ids.length) return this.clamp(op, "invalid-group", "a group needs \u22651 block");
    const memberIds = this.snappedRange(op.ids[0], op.ids[op.ids.length - 1]);
    if (!memberIds) return this.clamp(op, "unknown-id");
    if (baseRev !== void 0 && memberIds.some((id) => this.stale(id, baseRev))) return this.clamp(op, "stale");
    if ((this.index.get(memberIds[memberIds.length - 1]) ?? Infinity) >= this.protectedFromIndex()) return this.clamp(op, "protected");
    for (const id of memberIds) if (this.groupOf(this.get(id))) return this.clamp(op, "invalid-group", "overlaps an existing group");
    if (by !== "you" && memberIds.some((id) => this.get(id).override !== null)) return this.clamp(op, "human-override");
    const g = { id: `g:${memberIds[0]}`, memberIds, folded: true, by, digest: op.summary };
    if (this.classifyGroup(g).carrier === null) return this.clamp(op, "invalid-group", "nothing collapses (all stragglers)");
    this.groupList = [...this.groupList, g];
    for (const id of memberIds) touched.add(id);
    touched.add(g.id);
    return { op, applied: true, detail: g.id };
  }
  opUngroup(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    const g = this.groupById(op.groupId);
    if (!g) return this.clamp(op, "invalid-group", "no such group");
    if (this.stale(op.groupId, baseRev)) return this.clamp(op, "stale");
    this.groupList = this.groupList.filter((x) => x.id !== op.groupId);
    for (const id of g.memberIds) touched.add(id);
    touched.add(g.id);
    return { op, applied: true };
  }
  opFoldGroup(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    const g = this.groupById(op.groupId);
    if (!g) return this.clamp(op, "invalid-group", "no such group");
    if (this.stale(op.groupId, baseRev)) return this.clamp(op, "stale");
    if (g.folded) return this.clamp(op, "noop");
    g.folded = true;
    this.groupList = [...this.groupList];
    for (const id of g.memberIds) touched.add(id);
    touched.add(g.id);
    return { op, applied: true };
  }
  opUnfoldGroup(op, by, baseRev, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    if (by === "agent" && this.isLocked("agent-unfold")) return this.clamp(op, "locked");
    const g = this.groupById(op.groupId);
    if (!g) return this.clamp(op, "invalid-group", "no such group");
    if (this.stale(op.groupId, baseRev)) return this.clamp(op, "stale");
    if (!g.folded) return this.clamp(op, "noop");
    g.folded = false;
    this.groupList = [...this.groupList];
    for (const id of g.memberIds) touched.add(id);
    touched.add(g.id);
    return { op, applied: true };
  }
  opReset(op, by, touched) {
    if (by === "you" && this.isLocked("human-steering")) return this.clamp(op, "locked");
    let changed = this.groupList.length > 0;
    for (const b of this.blockLog) {
      if (b.override !== null || b.autoFolded || b.subst !== void 0 || b.by !== null) {
        b.override = null;
        b.autoFolded = false;
        b.subst = void 0;
        b.by = null;
        touched.add(b.id);
        changed = true;
      }
    }
    if (this.groupList.length) {
      for (const g of this.groupList) touched.add(g.id);
      this.groupList = [];
    }
    this.birthFolded.clear();
    if (!changed) return this.clamp(op, "noop");
    return { op, applied: true };
  }
  /**
   * Conductor-detach kill switch. Mirrors `opReset`'s shape (a single global op, no ids, no
   * `by`/lock gate, one aggregate `OpResult`) but transfers ownership instead of clearing it:
   * every strategy-owned fold becomes human-owned with `subst` preserved verbatim, and every
   * folded strategy group is reassigned to "you". Deliberately does NOT check
   * `isLocked("human-steering")` — see the `freeze` Op doc in ops.ts.
   */
  opFreeze(op, touched) {
    let changed = false;
    for (const b of this.blockLog) {
      if (b.override === null && b.autoFolded && !this.inFoldedGroup(b.id)) {
        b.override = "folded";
        b.by = "you";
        touched.add(b.id);
        changed = true;
      }
    }
    let groupsChanged = false;
    for (const g of this.groupList) {
      if (g.folded && g.by === "auto") {
        g.by = "you";
        touched.add(g.id);
        changed = true;
        groupsChanged = true;
      }
    }
    if (groupsChanged) this.groupList = [...this.groupList];
    if (!changed) return this.clamp(op, "noop");
    return { op, applied: true };
  }
  // ── wire serialization ────────────────────────────────────────────────────
  /**
   * Compute fold/group ops from the current state and run them through `applyPlan`. Correctness
   * over cleverness: it reuses the tested `applyPlan`. A per-message cache is a Phase-B option.
   */
  serializeWire(messages) {
    return applyPlan(messages, this.computeFoldOps(), this.computeGroupOps());
  }
  computeFoldOps() {
    const ops = [];
    for (const b of this.blockLog) {
      if (!this.isFolded(b)) continue;
      if (this.groupOf(b)?.folded) continue;
      if (!wireFoldable(b)) continue;
      if (!isDurableId(b.id)) continue;
      const digestText = this.digestOf(b);
      if (!digestText) continue;
      ops.push({ id: b.id, digestText });
    }
    return ops;
  }
  computeGroupOps() {
    const out = [];
    for (const g of this.groupList) {
      if (!g.folded) continue;
      const memberIds = g.memberIds.filter(isDurableId);
      if (!memberIds.length) continue;
      const summaryText = this.isDropGroup(g) ? null : this.groupSummary(g);
      if (summaryText !== null && !summaryText.trim()) continue;
      out.push({ id: g.id, memberIds, summaryText });
    }
    return out;
  }
};

// core/replica.ts
function hydrateSnapshot(meta, state) {
  const overlayById = /* @__PURE__ */ new Map();
  for (const o of state.overlay) overlayById.set(o.id, o);
  const blocks = state.blocks.map((w) => {
    const b = wireToBlock(w);
    const o = overlayById.get(w.id);
    if (o) {
      b.override = o.override;
      b.autoFolded = o.autoFolded;
      b.by = o.by;
      b.subst = o.subst;
    }
    return b;
  });
  const groups = state.groups.map((g) => ({ ...g, memberIds: g.memberIds.slice() }));
  const truth = new Truth({ meta, blocks: [], lineCount: 0, skipped: 0 });
  truth.adoptSnapshot({
    blocks,
    groups,
    budget: state.budget,
    contextWindow: state.contextWindow,
    protectTokens: state.protectTokens,
    locks: state.locks,
    lockHolder: state.lockHolder,
    tailTokens: state.tailTokens,
    sentThroughOrder: state.sentThroughOrder,
    wireAttached: state.wireAttached,
    birthFolded: state.birthFolded,
    // Optional on the wire (v15) so a peer/test constructing a `SnapshotState` literal without it
    // still type-checks — the version bump is the real cross-version gate; the host serializer
    // always emits it. Default `[]` (a session that never rebuilt has no carried sent-ness).
    carriedSent: state.carriedSent ?? [],
    // Optional on the wire (v18, same treatment as v15's `carriedSent` above); default to the
    // cold-start value `1` for a peer/test literal that omits it — the host serializer always emits it.
    calibration: state.calibration ?? 1,
    // Optional AND nullable on the wire (v19, issue #93); default `null` for a peer/test literal
    // that omits it — the host serializer always emits the field (as `null` before first capture).
    systemPrompt: state.systemPrompt ?? null,
    rev: state.rev
  });
  return truth;
}
function applyWireEvent(truth, ev) {
  switch (ev.kind) {
    case "appended":
      truth.append(ev.blocks.map(wireToBlock));
      return;
    case "ops":
      truth.apply(ev.ops, ev.by);
      return;
    case "config":
      if (ev.budget !== void 0) truth.setBudget(ev.budget);
      if (ev.contextWindow !== void 0 && ev.contextWindow !== null) truth.setContextWindow(ev.contextWindow);
      if (ev.protectTokens !== void 0) truth.setProtect(ev.protectTokens);
      if (ev.calibration !== void 0) truth.setCalibration(ev.calibration);
      if (ev.systemPrompt !== void 0) truth.setSystemPrompt(ev.systemPrompt.text, ev.systemPrompt.tokens);
      return;
    case "locks":
      if (ev.locks.length) truth.setLocks(ev.locks, ev.holder ?? "", ev.tailTokens);
      else truth.clearLocks();
      return;
    case "sent":
      truth.markSent(ev.throughOrder);
      return;
    case "reset":
      truth.apply([{ kind: "resetAll" }], ev.by);
      return;
  }
}

// core/conductor/hostAdapter.ts
function viewBlockOf(truth, b) {
  return {
    id: b.id,
    kind: b.kind,
    turn: b.turn,
    order: b.order,
    tokens: truth.calTokens(b.tokens),
    rawTokens: b.tokens,
    foldedTokens: truth.calTokens(truth.foldedTokensOf(b)),
    toolName: b.toolName,
    callId: b.callId,
    isError: b.isError,
    held: truth.held(b),
    folded: truth.isFolded(b),
    protected: truth.isProtected(b),
    grouped: truth.inFoldedGroup(b.id),
    sent: truth.sent(b),
    text: b.text
  };
}
function stateChangeFromOp(op, by) {
  switch (op.kind) {
    case "fold":
      return { id: op.ids[0], what: "fold", by };
    case "replace":
      return { id: op.id, what: "replace", by };
    case "unfold":
      return { id: op.ids[0], what: "unfold", by };
    case "auto":
      return { id: op.ids[0], what: "unfold", by };
    case "pin":
      return { id: op.ids[0], what: "pin", by };
    case "unpin":
      return { id: op.ids[0], what: "unpin", by };
    case "group":
      return { groupId: op.ids.join("|"), what: "group", by };
    case "ungroup":
      return { groupId: op.groupId, what: "ungroup", by };
    case "foldGroup":
      return { groupId: op.groupId, what: "group", by };
    case "unfoldGroup":
      return { groupId: op.groupId, what: "ungroup", by };
    case "resetAll":
      return { what: "unfold", by };
    case "freeze":
      return null;
  }
}
function hostEventsFromTruthEvent(truth, e) {
  if (e.type === "appended") {
    const s = truth.stats();
    return [{ type: "blocks-appended", blocks: e.blocks.map((b) => viewBlockOf(truth, b)), rev: e.rev, liveTokens: s.liveTokens, budget: s.budget }];
  }
  if (e.type === "ops-applied") {
    const changes = [];
    for (const r of e.results) {
      if (!r.applied) continue;
      const c = stateChangeFromOp(r.op, e.by);
      if (c) changes.push(c);
    }
    return changes.length ? [{ type: "state-changed", changes, rev: e.rev }] : [];
  }
  if (e.type === "config") {
    if (e.systemPrompt !== void 0) {
      return [{ type: "state-changed", changes: [{ what: "systemPrompt", by: "you" }], rev: e.rev }];
    }
    if (e.budget === void 0 && e.protectTokens === void 0 && e.contextWindow === void 0) return [];
    const what = e.budget !== void 0 ? "budget" : "protect";
    return [{ type: "state-changed", changes: [{ what, by: "you" }], rev: e.rev }];
  }
  if (e.type === "reset") {
    return [{ type: "resync", rev: e.rev }];
  }
  return [];
}
function recallHostEvent(ids, by, rev) {
  return { type: "state-changed", changes: ids.map((id) => ({ id, what: "recall", by })), rev };
}

// core/protocol.ts
var PROTOCOL_VERSION = 19;
var SERVER_TYPES = /* @__PURE__ */ new Set([
  "hello",
  "snapshot",
  "event",
  "folding",
  "recall",
  "telemetry",
  "commandResult",
  "stream",
  "conductorState",
  "conductorStatus",
  "wireDeparting",
  "turnCommitted",
  "proposeResult",
  "completeResult",
  "controller",
  "notice"
]);
function isServerMessage(v) {
  if (!v || typeof v !== "object" || !("type" in v)) return false;
  return SERVER_TYPES.has(v.type);
}

// core/conductor/remote.ts
var WS_OPEN = 1;
function defaultWsFactory(url) {
  const Ctor = globalThis.WebSocket;
  if (!Ctor) {
    throw new Error(
      "remote conductor SDK: no global WebSocket available in this runtime \u2014 pass opts.wsFactory (Node 22+ ships one built in)"
    );
  }
  return new Ctor(url);
}
function runRemoteConductor(conductor, opts) {
  const host = opts.host ?? "127.0.0.1";
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const url = `ws://${host}:${opts.port}/?role=conductor&token=${encodeURIComponent(opts.token)}`;
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let attached = false;
    let helloOk = false;
    let sawFirstSnapshot = false;
    let awaitingResnapshot = false;
    let proposeSeq = 0;
    let reqId = 0;
    let replica = null;
    let meta = { format: "pi", title: "", cwd: "", model: "" };
    const listeners = /* @__PURE__ */ new Set();
    const pendingProposes = /* @__PURE__ */ new Map();
    const pendingCompletes = /* @__PURE__ */ new Map();
    let ws;
    try {
      ws = wsFactory(url);
    } catch (e) {
      rejectPromise(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    function send(msg) {
      if (ws.readyState !== WS_OPEN) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
      }
    }
    function requestResnapshot() {
      awaitingResnapshot = true;
      send({ type: "resnapshot" });
    }
    async function dispatch(e) {
      const pending = [];
      for (const fn of listeners) {
        try {
          const r = fn(e);
          if (r && typeof r.then === "function") pending.push(r);
        } catch {
        }
      }
      if (pending.length) await Promise.allSettled(pending);
    }
    function installReplica(t) {
      replica = t;
      t.onEvent((e) => {
        for (const he of hostEventsFromTruthEvent(t, e)) void dispatch(he);
      });
    }
    function sendPropose(baseRev, ops) {
      return new Promise((resolve) => {
        const seq = ++proposeSeq;
        pendingProposes.set(seq, { ops, resolve });
        send({ type: "propose", seq, baseRev, ops });
      });
    }
    function sendCompleteRequest(req) {
      return new Promise((resolve, reject) => {
        const id = ++reqId;
        pendingCompletes.set(id, { resolve, reject });
        send({
          type: "completeRequest",
          reqId: id,
          system: req.system,
          prompt: req.prompt,
          maxOutputTokens: req.maxOutputTokens,
          model: req.model && req.model !== "current" ? req.model : void 0
        });
        const signal = req.signal;
        if (signal) {
          const onAbort2 = () => {
            if (!pendingCompletes.has(id)) return;
            pendingCompletes.delete(id);
            send({ type: "cancelComplete", reqId: id });
            reject(signal.reason instanceof Error ? signal.reason : new Error("remote conductor: completion aborted"));
          };
          if (signal.aborted) onAbort2();
          else signal.addEventListener("abort", onAbort2, { once: true });
        }
      });
    }
    function buildHost() {
      return {
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        get(id) {
          const b = replica.get(id);
          return b ? viewBlockOf(replica, b) : void 0;
        },
        blocks() {
          return replica.blocks.map((b) => viewBlockOf(replica, b));
        },
        groups() {
          return replica.groups.map((g) => ({ id: g.id, memberIds: g.memberIds.slice(), folded: g.folded, by: g.by ?? null, summary: g.digest }));
        },
        textOf(id) {
          return replica.get(id)?.text ?? null;
        },
        stats() {
          return replica.stats();
        },
        systemPrompt() {
          return replica.systemPrompt;
        },
        countTokens(text) {
          return replica.calTokens(estTokens(text));
        },
        digestOf(id) {
          const b = replica.get(id);
          return b ? digest(b) : null;
        },
        complete(req) {
          return sendCompleteRequest(req);
        },
        setStatus(text, metrics) {
          send({ type: "setConductorStatus", text, metrics });
        },
        propose(txn) {
          return sendPropose(txn.baseRev, txn.ops);
        }
      };
    }
    function drainPending() {
      for (const [, p] of pendingProposes) {
        p.resolve({ rev: replica ? replica.rev : 0, results: p.ops.map((op) => ({ op, applied: false, clamped: "stale" })) });
      }
      pendingProposes.clear();
      for (const [, p] of pendingCompletes) {
        p.reject(new Error("remote conductor: connection closed before completion resolved"));
      }
      pendingCompletes.clear();
    }
    function finish(err) {
      if (settled) return;
      settled = true;
      try {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      } catch {
      }
      if (opts.signal) {
        try {
          opts.signal.removeEventListener("abort", onAbort);
        } catch {
        }
      }
      drainPending();
      if (attached) {
        try {
          conductor.detach();
        } catch {
        }
      }
      if (err) rejectPromise(err);
      else resolvePromise();
    }
    function onAbort() {
      try {
        ws.close();
      } catch {
      }
    }
    function onSignal() {
      try {
        ws.close();
      } catch {
      }
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    } catch {
    }
    function handleMessage(msg) {
      switch (msg.type) {
        case "hello": {
          if (msg.protocolVersion !== PROTOCOL_VERSION || msg.role !== "conductor") {
            const detail = `remote conductor: protocol/role mismatch \u2014 expected v${PROTOCOL_VERSION} role "conductor", got v${msg.protocolVersion} role "${msg.role}"`;
            try {
              ws.close();
            } catch {
            }
            finish(new Error(detail));
            return;
          }
          helloOk = true;
          const m = msg.meta && typeof msg.meta === "object" ? msg.meta : {};
          meta = { format: "pi", title: m.title || "", cwd: m.cwd || "", model: m.model || "" };
          break;
        }
        case "snapshot": {
          if (!helloOk) return;
          if (!msg.state || typeof msg.state !== "object") return;
          const state = msg.state;
          const t = hydrateSnapshot(meta, state);
          if (!sawFirstSnapshot) {
            sawFirstSnapshot = true;
            installReplica(t);
            attached = true;
            conductor.attach(buildHost());
          } else {
            installReplica(t);
            awaitingResnapshot = false;
            void dispatch({ type: "resync", rev: t.rev });
          }
          break;
        }
        case "event": {
          if (!replica || awaitingResnapshot) return;
          const ev = msg.event;
          if (!ev || typeof ev !== "object") return;
          if (ev.kind === "reset") {
            requestResnapshot();
            return;
          }
          applyWireEvent(replica, ev);
          if (replica.rev !== ev.rev) requestResnapshot();
          break;
        }
        case "wireDeparting": {
          if (!replica) return;
          const holdId = msg.holdId;
          const event = { type: "wire-departing", rev: msg.rev, liveTokens: msg.liveTokens, budget: msg.budget, freshIds: msg.freshIds, holdId };
          void dispatch(event).finally(() => send({ type: "holdRelease", holdId }));
          break;
        }
        case "turnCommitted": {
          void dispatch({ type: "turn-committed", turn: msg.turn, rev: msg.rev });
          break;
        }
        case "recall": {
          if (!replica) return;
          void dispatch(recallHostEvent(msg.ids, msg.by, replica.rev));
          break;
        }
        case "proposeResult": {
          const p = pendingProposes.get(msg.seq);
          if (!p) return;
          pendingProposes.delete(msg.seq);
          p.resolve({ rev: msg.rev, results: msg.results });
          break;
        }
        case "completeResult": {
          const p = pendingCompletes.get(msg.reqId);
          if (!p) return;
          pendingCompletes.delete(msg.reqId);
          if (msg.ok) p.resolve({ text: msg.text ?? "", model: msg.model ?? "", inputTokens: msg.inputTokens, outputTokens: msg.outputTokens });
          else p.reject(new Error(msg.error ?? "remote conductor: completion failed"));
          break;
        }
        default:
          break;
      }
    }
    ws.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) return;
      handleMessage(parsed);
    };
    ws.onerror = () => {
    };
    ws.onclose = () => {
      finish();
    };
  });
}

// core/conductor/view.ts
var ViewConductor = class {
  description;
  locks;
  tailTokens;
  holdWireUpToMs;
  /** The host, available to subclasses between `attach` and `detach`. */
  host;
  off = null;
  attached = false;
  /** Per-block strategy folds this conductor has successfully applied and still wants. id → sig. */
  applied = /* @__PURE__ */ new Map();
  /** Strategy groups successfully applied, keyed by the named-ids run. */
  appliedGroups = /* @__PURE__ */ new Map();
  /**
   * True for the full synchronous duration of this conductor's OWN `host.propose(...)` call (set
   * right before, cleared in a `finally` right after). Guards a real reentrancy hazard: `Truth.emit`
   * (`core/truth.ts`) notifies every subscriber SYNCHRONOUSLY, inside the same call stack as the
   * `apply()` that produced the change — so this conductor's own successful propose fires a
   * `state-changed` HostEvent back into `onHostEvent` BEFORE that propose's own promise has even
   * resolved, let alone before `applyDesired` has reconciled `applied`/`appliedGroups` with the
   * result. Reacting to `state-changed` (below) is exactly what main's UX did on ANY context
   * change, so it must stay — but without this guard, that reentrant `state-changed` would trigger
   * an immediate second `rerun()` that computes the SAME desired ops against STALE tracked state
   * (the reconciliation from the first call hasn't run yet) and re-proposes them, recursing into
   * `host.propose` a second time from inside the first one's own synchronous call chain. Skipping
   * `state-changed` while `busy` is true is safe: `applyDesired`'s reconciliation always runs
   * immediately after the (now-settled) propose call returns, at which point the tracked state is
   * already caught up — no rerun is lost, only deduplicated.
   *
   * Caveat: the "nothing else can run in the window" reasoning holds for IN-PROCESS hosts, whose
   * `propose` applies synchronously and resolves on a microtask. Over an out-of-process host the
   * awaited propose is a full wire round trip, and a genuinely external `state-changed` arriving
   * mid-flight would be skipped until the next host event. One shipped `ViewConductor` does run
   * out of process (triptych, via the remote SDK; thermocline is a raw `Conductor`) — for it this
   * is an accepted, benign miss: the skipped rerun is recomputed from scratch on the next
   * `turn-committed`/`state-changed`, and triptych's desired state is a pure function of the view.
   */
  busy = false;
  attach(host) {
    this.host = host;
    this.attached = true;
    this.off = host.on((e) => this.onHostEvent(e));
  }
  detach() {
    this.attached = false;
    this.off?.();
    this.off = null;
    this.applied.clear();
    this.appliedGroups.clear();
  }
  onHostEvent(e) {
    if (!this.attached) return;
    if (e.type === "turn-committed") return this.rerun();
    else if (e.type === "wire-departing" && (this.holdWireUpToMs ?? 0) > 0) return this.rerun();
    else if (e.type === "state-changed") {
      if (this.busy) return;
      return this.rerun();
    } else if (e.type === "resync") this.rebuildFromTruth();
  }
  /**
   * Re-materialize the view, call `conduct()`, diff, and propose. The local successor to the old
   * `host.requestRerun()` — an in-process conductor that finishes async work (e.g. an LLM summary)
   * calls this to emit its derived ops. `propose` is async (contract v2), so this is async too;
   * the returned promise settles once the transaction's per-op results are reconciled. No-op while
   * detached.
   */
  async rerun() {
    if (!this.attached || !this.host) return;
    const view = this.materialize();
    const cmds = this.conduct(view);
    if (cmds === null) return;
    await this.applyDesired(cmds);
  }
  materialize() {
    const stats = this.host.stats();
    return {
      blocks: this.host.blocks().slice(),
      budget: stats.budget,
      contextWindow: stats.contextWindow,
      liveTokens: stats.liveTokens,
      protectedFromIndex: stats.protectedFromIndex,
      protectTokens: stats.protectTokens
    };
  }
  /** On a structural resync, rebuild the tracked folded-set AND the tracked group-set from the
   *  host's actual state so undo-diffing stays correct: a block folded in truth this conductor no
   *  longer wants gets an `auto` op next pass, and a GROUP it still owns (`by === "auto"`) gets
   *  re-claimed rather than orphaned — a later pass proposing no group intention for it now
   *  correctly emits `ungroup` instead of leaving the group stranded in Truth forever. */
  rebuildFromTruth() {
    this.applied.clear();
    this.appliedGroups.clear();
    for (const b of this.host.blocks()) {
      if (b.folded && !b.held && !b.grouped) this.applied.set(b.id, "\0resync");
    }
    for (const g of this.host.groups()) {
      if (g.by !== "auto") continue;
      this.appliedGroups.set(g.memberIds.join("|"), { ids: g.memberIds.slice(), digest: g.summary, groupId: g.id });
    }
  }
  async applyDesired(cmds) {
    const baseRev = this.host.stats().rev;
    const desiredFolds = /* @__PURE__ */ new Map();
    const desiredGroups = /* @__PURE__ */ new Map();
    const explicitLive = /* @__PURE__ */ new Set();
    for (const c of cmds) {
      if (c.kind === "fold") {
        for (const id of c.ids) desiredFolds.set(id, { op: { kind: "fold", ids: [id], digest: c.digest }, sig: `fold:${c.digest ?? ""}` });
      } else if (c.kind === "replace") {
        const recoverable = c.recoverable ?? false;
        desiredFolds.set(c.id, { op: { kind: "replace", id: c.id, content: c.content, recoverable }, sig: `replace:${recoverable}:${c.content}` });
      } else if (c.kind === "group") {
        desiredGroups.set(c.ids.join("|"), { ids: c.ids.slice(), digest: c.digest });
      } else if (c.kind === "restore" || c.kind === "pin") {
        for (const id of c.ids) explicitLive.add(id);
      }
    }
    const groupMemberIds = /* @__PURE__ */ new Set();
    for (const g of desiredGroups.values()) for (const id of g.ids) groupMemberIds.add(id);
    const ops = [];
    for (const [key, g] of this.appliedGroups) {
      const want = desiredGroups.get(key);
      if (!want || want.digest !== g.digest) ops.push({ kind: "ungroup", groupId: g.groupId });
    }
    for (const id of this.applied.keys()) {
      if (!desiredFolds.has(id) || explicitLive.has(id) || groupMemberIds.has(id)) ops.push({ kind: "auto", ids: [id] });
    }
    for (const [id, d] of desiredFolds) {
      if (explicitLive.has(id) || groupMemberIds.has(id)) continue;
      if (this.applied.get(id) !== d.sig) ops.push(d.op);
    }
    for (const [key, g] of desiredGroups) {
      const prior = this.appliedGroups.get(key);
      if (!prior || prior.digest !== g.digest) ops.push({ kind: "group", ids: g.ids, summary: g.digest });
    }
    if (!ops.length) return;
    this.busy = true;
    let res;
    try {
      res = await this.host.propose({ baseRev, ops });
    } finally {
      this.busy = false;
    }
    for (const r of res.results) {
      const op = r.op;
      if (op.kind === "auto") {
        if (r.applied) for (const id of op.ids) this.applied.delete(id);
      } else if (op.kind === "fold") {
        if (r.applied) this.applied.set(op.ids[0], `fold:${op.digest ?? ""}`);
      } else if (op.kind === "replace") {
        if (r.applied) this.applied.set(op.id, `replace:${op.recoverable ?? false}:${op.content}`);
      } else if (op.kind === "ungroup") {
        if (r.applied) {
          for (const [k, g] of this.appliedGroups) if (g.groupId === op.groupId) {
            this.appliedGroups.delete(k);
            break;
          }
        }
      } else if (op.kind === "group") {
        if (r.applied && r.detail) this.appliedGroups.set(op.ids.join("|"), { ids: op.ids.slice(), digest: op.summary, groupId: r.detail });
      }
    }
  }
  /** The engine's canonical fold tag for `id`, for subclasses building recoverable substitutions. */
  foldTag(id) {
    return foldTag(id);
  }
};

// conductors/in-process/agedSummaryConductor.ts
var TRIGGER = 0.9;
var MAX_OUTPUT_TOKENS = 8e3;
var MIN_OUTPUT_TOKENS = 1e3;
var OUTPUT_SAFETY_MARGIN = 512;
var MIN_PASS_SAVING = 32;
function neutralizeClosingTags(s, tags) {
  const alt = tags.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
  return s.replace(new RegExp(`<\\s*\\/\\s*(${alt})`, "gi"), "&lt;/$1");
}
var ERROR_STATUS_MAX_LEN = 200;
function truncateForStatus(s, max = ERROR_STATUS_MAX_LEN) {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}
function isUnavailableError(err) {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /no model available/i.test(msg);
}
function sumTokens(blocks) {
  let n = 0;
  for (const b of blocks) n += b.tokens;
  return n;
}
function blockLabel(b) {
  switch (b.kind) {
    case "user":
      return "user";
    case "text":
      return "assistant";
    case "thinking":
      return "assistant thinking";
    case "tool_call":
      return b.toolName ? `tool call: ${b.toolName}` : "tool call";
    case "tool_result":
      return b.toolName ? `tool result: ${b.toolName}` : "tool result";
    default: {
      const _never = b.kind;
      return String(_never);
    }
  }
}
var AgedSummaryConductor = class extends ViewConductor {
  description;
  locks;
  tailTokens;
  /** May `b` be swallowed into the non-recoverable summary group? Default: every kind. Excluded
   *  blocks still feed the prompt as CONTEXT (via `newlyAged`) — they are only ever excluded from
   *  actually being folded away, splitting the group run around them. */
  includeInGroup(_b) {
    return true;
  }
  /**
   * The EXCLUSIVE upper index of the region this conductor may summarize — `agedRegion` and
   * `emitCoverageGroup` walk blocks `[0, agedBoundaryIndex)`. Default: the host's protected-tail
   * boundary (both shipped subclasses summarize everything older than the tail, main parity). A
   * subclass with its own banding (triptych's thirds) overrides this to a NARROWER boundary; it must
   * never return an index past `view.protectedFromIndex` (the protected tail is not this
   * conductor's to summarize — `Truth` would clamp the group anyway, but the accounting here
   * assumes the boundary is honest).
   */
  agedBoundaryIndex(view) {
    return view.protectedFromIndex;
  }
  /**
   * The text a block contributes to the completion prompt (`buildPrompt`). Default: the block's
   * full original text. A subclass that has already compressed a block (triptych's skeletons)
   * overrides this to feed the compressed form instead — the conversation as the agent actually
   * experienced it, and a much smaller prompt.
   */
  promptTextOf(b) {
    return (b.text ?? "").trim();
  }
  // ── shared instance state ────────────────────────────────────────────────────
  /** The current completion result (with its subclass-formatted count preamble). Null until the
   *  first completion succeeds. */
  text = null;
  /**
   * The block ids currently represented by `text` — the monotonic "already summarized" set.
   * Grows only within a session (replaced wholesale by each successful completion's full aged
   * snapshot); cleared on attach. The group covers `coveredIds ∩ aged region ∩ includeInGroup`.
   */
  coveredIds = /* @__PURE__ */ new Set();
  /** AbortController for the current in-flight completion, or null when idle. */
  inflight = null;
  /**
   * A stable key for the NEWLY AGED block set most recently ATTEMPTED. Keyed on `newlyAged` ids
   * (NOT the full aged set) so a pure SHRINK of the aged set (e.g. a human pins an old block)
   * does not change the key and does not relaunch; a genuinely new aged block does.
   */
  lastAttemptKey = "";
  /**
   * A STICKY, human-visible failure message from the most recent attempt (provider rejection,
   * empty output, or a window too tight to attempt). Null when the last attempt succeeded or none
   * has run. It survives subsequent `conduct()` passes on purpose: a completion failure lands in
   * the async reject handler, out of band from the model call, so the only way the human learns
   * it broke is a status that is not wiped by the next pass. Cleared exactly when a genuine retry
   * launches or a result commits — every `conduct()` path that would otherwise bare-clear the
   * status bar calls `surfaceIdleStatus()` instead, so a failure is never erased before it is seen.
   *
   * PROTECTED (not private) so a subclass with its own out-of-band failure source can join the
   * same sticky mechanism instead of racing it — triptych's skeleton-engine init failure writes
   * here so an idle pass surfaces it rather than wiping a bare `setStatus` (adversarial-review
   * finding: a subclass status set outside this field was cleared by the very next idle pass).
   */
  failureStatus = null;
  /**
   * Wire tokens the most recently COMMITTED pass actually removed (`liveTokens` before its ops
   * applied minus after). Null until one completes — and a FAILED attempt never sets it, so a
   * provider error can never look like an unproductive pass. Read only by the back-off in
   * `conduct()`.
   */
  lastPassSaving = null;
  /** Σ full tokens of the aged region the most recently COMMITTED pass was handed — the bar a
   *  refill has to clear before an unproductive conductor spends another model call. */
  lastPassAgedTokens = 0;
  // ── lifecycle ────────────────────────────────────────────────────────────────
  /** A conductor lifetime starts fresh on attach — don't let state from a prior session leak into
   *  the next one, even if the same instance is re-attached. */
  attach(host) {
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
    this.text = null;
    this.coveredIds = /* @__PURE__ */ new Set();
    this.lastAttemptKey = "";
    this.failureStatus = null;
    this.lastPassSaving = null;
    this.lastPassAgedTokens = 0;
    super.attach(host);
  }
  /** Cancel any in-flight completion so a stale result cannot mutate state after detach. */
  detach() {
    if (this.inflight) {
      this.inflight.abort();
      this.inflight = null;
    }
    this.host.setStatus(null);
    super.detach();
  }
  // ── main conduct loop ─────────────────────────────────────────────────────────
  conduct(view) {
    const aged = this.agedRegion(view);
    if (view.budget <= 0 || view.blocks.length === 0) {
      return this.text !== null ? this.emitCoverageGroup(view) : [];
    }
    if (this.inflight !== null) return this.emitCoverageGroup(view);
    const visible = view.liveTokens;
    const cap = view.contextWindow != null ? Math.min(view.budget, view.contextWindow) : view.budget;
    const overThreshold = visible >= cap * TRIGGER;
    const newlyAged = aged.filter((b) => !this.coveredIds.has(b.id));
    if (aged.length === 0 && this.text === null) {
      this.surfaceIdleStatus();
      return [];
    }
    const productive = this.lastPassSaving === null || this.lastPassSaving > MIN_PASS_SAVING;
    const refilled = sumTokens(newlyAged) > this.lastPassAgedTokens;
    const needsRun = overThreshold && newlyAged.length > 0 && (productive || refilled);
    if (!needsRun) {
      this.surfaceIdleStatus();
      return this.text !== null ? this.emitCoverageGroup(view) : [];
    }
    const attemptKey = newlyAged.map((b) => b.id).sort().join("\0");
    if (attemptKey === this.lastAttemptKey) {
      this.surfaceIdleStatus();
      return this.text !== null ? this.emitCoverageGroup(view) : [];
    }
    this.launchCompletion(aged, newlyAged, attemptKey, view.contextWindow);
    return this.emitCoverageGroup(view);
  }
  // ── helpers ───────────────────────────────────────────────────────────────────
  /**
   * Ids currently inside a FOLDED group this conductor did NOT create. Every conductor-proposed
   * op runs under actor `"auto"` (`ConductorHost.propose` → `Truth.apply(ops, "auto", …)`, see
   * `ViewConductor.applyDesired`), so `g.by !== "auto"` reliably means "a human made this group"
   * — the only kind of FOREIGN group an exclusive conductor like this can encounter.
   */
  foreignGroupedIds() {
    const ids = /* @__PURE__ */ new Set();
    for (const g of this.host.groups()) {
      if (g.by === "auto") continue;
      for (const id of g.memberIds) ids.add(id);
    }
    return ids;
  }
  /**
   * The aged region: every block older than the protected working tail that is not human-held and
   * not already inside a FOREIGN group. All kinds included (per-kind group-eligibility is decided
   * separately by `includeInGroup`, applied only where a block would be folded away).
   */
  agedRegion(view) {
    const foreign = this.foreignGroupedIds();
    const aged = [];
    const boundary = Math.min(this.agedBoundaryIndex(view), view.protectedFromIndex);
    for (let i = 0; i < boundary && i < view.blocks.length; i++) {
      const b = view.blocks[i];
      if (!b.held && !foreign.has(b.id)) aged.push(b);
    }
    return aged;
  }
  /**
   * Emit `text` as `group` command(s) covering the covered survivors in the aged prefix that are
   * also `includeInGroup`-eligible. Re-derived from the LIVE view on every call:
   *   - A survivor is a block in `coveredIds` that is still in the aged prefix, not held, not
   *     inside a FOREIGN group, and `includeInGroup(b)`. A block this conductor has "covered"
   *     (fed to the model at least once) but which is NOT group-eligible (only possible if a
   *     subclass overrides `includeInGroup` to exclude a kind) is never a survivor here — it
   *     stays live and forces the run to split.
   *   - Runs are the MAXIMAL CONTIGUOUS spans of survivors, found by walking the FULL aged prefix
   *     (including held/foreign-grouped/excluded blocks) so any of those SPLIT a run rather than
   *     being spanned by it.
   *   - Each surviving run becomes one `group(first, last, digest)` unless a run-level exclusion
   *     below keeps it out; no run proposed → `[]` (clear to raw; lossless).
   *
   * ONLY THE FIRST EMITTED RUN CARRIES `text` (issue #90): a held/pinned block or a foreign group
   * can fragment the aged prefix into K > 1 survivor runs, and every run used to get the FULL
   * summary as its digest — the wire then carried K copies of the same text while the trigger
   * charged it once. Every run after the first instead gets digest `""` — the group-op
   * vocabulary's explicit DROP sentinel (`Truth.isDropGroup` / `core/ops.ts`'s `group.summary`
   * doc: `null`/`""` → no wire message at all), not the default-recap `undefined` would trigger.
   * K = 1 (the common case, no fragmentation) is unaffected: the single run still gets the full
   * `text` digest, byte-identical to before that fix.
   *
   * THREE RUN-LEVEL EXCLUSIONS (#90 review). An excluded run is simply not proposed — its blocks
   * stay live exactly as a held/foreign block already keeps itself out of a run — so all three are
   * lossless, and all three are re-evaluated from the live view every pass:
   *
   *   1. NOT A FIXED POINT OF THE HOST'S RANGE SNAP. `Truth.opGroup` does not group the ids it is
   *      handed: it groups `snappedRange(first, last)`, which walks each boundary OUTWARD over
   *      blocks sharing its `messageKey` — sibling parts of the same assistant message that this
   *      walk deliberately EXCLUDED. Vetting the run while Truth applies a wider set is a hole big
   *      enough to lose data through: a snapped-in HELD sibling trips `opGroup`'s human-override
   *      clamp, and a snapped-in `tool_call` whose result is outside flips the carrier verdict —
   *      either way the carrier is rejected while a sibling DROP commits (exclusion 2's failure
   *      mode, reached around the back). So each run is first trimmed INWARD to the largest
   *      sub-window that `snappedRange` leaves alone (`snapToMessageAtoms`, mirroring
   *      `conductors/ws/thermocline/policy.ts`'s `safeRunFromUnits`), and THAT window is both what
   *      gets vetted and what gets proposed — so the group Truth applies is byte-identical to the
   *      one judged here. A run that shrinks to nothing is dropped entirely.
   *   2. NO VIABLE CARRIER (P1 #2 — silent data loss). `Truth.opGroup` rejects a group whose run
   *      has nothing the wire may actually remove (`"nothing collapses (all stragglers)"` — e.g. a
   *      run holding a `tool_call` whose paired `tool_result` is held OUTSIDE it). `Truth.apply`
   *      validates each op INDEPENDENTLY and `ViewConductor.applyDesired` silently drops the
   *      failures, so a rejected FIRST run (the summary carrier) alongside an accepted sibling
   *      DROP removed content from the wire with no summary anywhere. Running the SAME fixpoint
   *      `Truth.classifyGroup` runs (`collapsibleMessageKeys`, core/groupShape.ts — not a
   *      re-derivation) BEFORE proposing means a doomed carrier is never proposed, so no sibling
   *      drop is ever built on a summary that will not commit. Note the coupling: if the first run
   *      is excluded, `text` moves to the first run that IS viable.
   *   3. A DROP THAT COSTS MORE THAN IT SAVES (P1 #1 — the wire growing). The wire's role-validity
   *      floor (`computeDegradedDropRuns`, core/wire.ts) turns a DROP run into a paid recap stub
   *      when removing it would weld two same-role neighbors, at a cost that is ~flat per run
   *      regardless of run size. Under heavy fragmentation (many tiny runs) that turned
   *      "compaction" into net wire GROWTH. `dropEconomics` below compares what the drop actually
   *      removes against what it can actually cost; a drop that cannot pay for itself is not made.
   *      The summary CARRIER is exempt — it is this conductor's entire product, and a REPLACE run
   *      is never degraded — so growth stays bounded by one summary's own cost.
   *
   * Returns:
   *   - null  → no result yet (used ONLY while a first-trip completion is in-flight).
   *   - []    → nothing worth (or able to) collapse (clear to raw; lossless).
   *   - [...] → one `group` command per proposed run — the first carries `text`, every subsequent
   *             one carries `""` (DROP).
   */
  emitCoverageGroup(view) {
    if (this.text === null) return null;
    const foreign = this.foreignGroupedIds();
    const runs = [];
    let start = -1;
    const pfi = Math.min(this.agedBoundaryIndex(view), view.protectedFromIndex, view.blocks.length);
    for (let i = 0; i < pfi; i++) {
      const b = view.blocks[i];
      if (this.coveredIds.has(b.id) && !b.held && !foreign.has(b.id) && this.includeInGroup(b)) {
        if (start === -1) start = i;
      } else if (start !== -1) {
        runs.push([start, i - 1]);
        start = -1;
      }
    }
    if (start !== -1) runs.push([start, pfi - 1]);
    const cmds = [];
    for (const [runStart, runEnd] of runs) {
      const snapped = this.snapToMessageAtoms(view, runStart, runEnd);
      if (!snapped) continue;
      const members = view.blocks.slice(snapped[0], snapped[1] + 1);
      const removable = collapsibleMessageKeys(members, true);
      if (removable.size === 0) continue;
      if (cmds.length > 0) {
        const { saving, cost } = this.dropEconomics(members, removable);
        if (saving <= cost) continue;
      }
      cmds.push({ kind: "group", ids: [members[0].id, members[members.length - 1].id], digest: cmds.length === 0 ? this.text : "" });
    }
    return cmds;
  }
  /**
   * Trim `[start..end]` INWARD to the largest sub-window that is a FIXED POINT of `Truth`'s
   * `snappedRange`: a window neither of whose boundary messages continues past it. A run is a
   * contiguous index span with no interior hole, so "no boundary straddles" is the whole condition
   * (`policy.ts`'s `safeRunFromUnits` additionally checks for holes because its units can skip
   * blocks). Shrinks the FRONT first when the front message straddles, otherwise the back — same
   * order as that function. Null when nothing survives.
   */
  snapToMessageAtoms(view, start, end) {
    const keyAt = (i) => messageKey(view.blocks[i].id);
    let lo = start;
    let hi = end;
    while (lo <= hi) {
      const frontStraddles = lo > 0 && keyAt(lo - 1) === keyAt(lo);
      const backStraddles = hi < view.blocks.length - 1 && keyAt(hi + 1) === keyAt(hi);
      if (!frontStraddles && !backStraddles) return [lo, hi];
      if (frontStraddles) lo++;
      else hi--;
    }
    return null;
  }
  /**
   * What DROPPING `members` would actually save, against the most it could actually cost.
   *
   * SAVING is only the members the wire may genuinely remove (`removable`, from the shared
   * fixpoint). A STRAGGLER — a message the tool-pair fixpoint demoted — stays live at full cost
   * inside the group (`Truth.groupLiveTokens` charges it exactly that), so counting it as saved
   * would overstate the drop and is precisely how a "worth it" verdict could approve a group that
   * grows the wire.
   *
   * COST is one role-floor recap stub per COLLAPSED SUB-RUN, not one per group: an interior
   * straggler splits a group into several runs (`GroupShape.collapsedRuns`), and
   * `computeDegradedDropRuns` degrades each independently, so N sub-runs can cost N stubs. Each
   * stub is priced in ORIGINAL WIRE units from the EXACT text `applyPlan` synthesizes
   * (`roleFloorRecap`, exported from `core/wire.ts` for this reason) plus the same
   * `BLOCK_OVERHEAD` framing `Truth.runWireTok` charges it. `ViewBlock.rawTokens` keeps this sign
   * check immune to provider calibration and its per-item rounding; pressure/budget decisions
   * remain calibrated everywhere else. The floor's real verdict depends on every other run in the
   * wire at once, so this is deliberately the WORST case: it can leave a small saving on the table,
   * never cause growth.
   * The group id is the one `Truth.opGroup` will mint (`g:<first member id>`) — exact, because the
   * proposed member set is now snap-stable (exclusion 1).
   */
  dropEconomics(members, removable) {
    const groupId = `g:${members[0].id}`;
    let saving = 0;
    let cost = 0;
    let runMessages = 0;
    let prevKey = null;
    const closeRun = () => {
      if (runMessages === 0) return;
      cost += estTokens(roleFloorRecap(groupId, runMessages)) + BLOCK_OVERHEAD;
      runMessages = 0;
      prevKey = null;
    };
    for (const b of members) {
      const k = messageKey(b.id);
      if (!removable.has(k)) {
        closeRun();
        continue;
      }
      saving += b.rawTokens ?? b.tokens;
      if (k !== prevKey) {
        runMessages++;
        prevKey = k;
      }
    }
    closeRun();
    return { saving, cost };
  }
  /** Surface the sticky failure status (or clear the bar when there is none). Used in every
   *  `conduct()` path that would otherwise bare-`setStatus(null)`, so a completion failure set out
   *  of band in the async handlers is not erased before the human sees it. Cleared exactly when a
   *  genuine retry launches (see `launchCompletion`) or a result commits. */
  surfaceIdleStatus() {
    this.host.setStatus(this.failureStatus);
  }
  /** Neutralize a sentinel-breakout attempt against BOTH tags this conductor's prompt ever wraps
   *  content in: the always-present `"conversation"` wrapper and the subclass's `priorTag`. */
  neutralize(s) {
    return neutralizeClosingTags(s, ["conversation", this.priorTag]);
  }
  /**
   * Fire-and-forget: build the completion prompt and launch a `host.complete()` call. `conduct()`
   * returns immediately after calling this; the result comes back via the resolve handler, which
   * calls `this.rerun()` (`ViewConductor`'s local successor to the old `host.requestRerun()`) to
   * schedule a fresh `conduct()` pass so the group takes effect immediately.
   *
   * @param agedBlocks    - all aged blocks at launch time (SNAPSHOT — don't use the view later).
   * @param newlyAged     - subset not already in `coveredIds` (used to build the recursive prompt).
   * @param attemptKey    - the sorted-join key of the NEWLY AGED set being attempted; stored to
   *                        prevent relaunching the same newly-aged set after a rejection.
   * @param contextWindow - the model's total context window (or null if unknown), used to reserve
   *                        output room so `input + output` cannot overflow the window.
   */
  launchCompletion(agedBlocks, newlyAged, attemptKey, contextWindow) {
    if (this.inflight !== null) return;
    const launchedAgedIds = new Set(agedBlocks.map((b) => b.id));
    const launchedAgedTokens = sumTokens(agedBlocks);
    const count = agedBlocks.filter((b) => this.includeInGroup(b)).length;
    const prompt = this.buildPrompt(newlyAged);
    this.lastAttemptKey = attemptKey;
    let maxOutputTokens = MAX_OUTPUT_TOKENS;
    if (contextWindow != null && contextWindow > 0) {
      const inputTokens = this.host.countTokens(this.systemPrompt) + this.host.countTokens(prompt);
      const reserve = contextWindow - inputTokens - OUTPUT_SAFETY_MARGIN;
      if (reserve < MIN_OUTPUT_TOKENS) {
        this.failureStatus = this.windowTooTightMessage(inputTokens, contextWindow);
        this.host.setStatus(this.failureStatus, { input: inputTokens, window: contextWindow });
        return;
      }
      maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS, reserve);
    }
    this.failureStatus = null;
    this.host.setStatus(null);
    const controller = new AbortController();
    this.inflight = controller;
    this.host.complete({
      system: this.systemPrompt,
      prompt,
      maxOutputTokens,
      signal: controller.signal
    }).then(
      (result) => {
        if (this.inflight !== controller) return;
        const text = result.text.trim();
        if (!text) {
          this.inflight = null;
          this.failureStatus = this.emptyOutputMessage(count);
          this.host.setStatus(this.failureStatus, { aged: count });
          return;
        }
        this.inflight = null;
        this.failureStatus = null;
        const liveBefore = this.host.stats().liveTokens;
        this.text = this.formatText(count, text);
        this.coveredIds = launchedAgedIds;
        void this.rerun().then(() => {
          this.lastPassSaving = liveBefore - this.host.stats().liveTokens;
          this.lastPassAgedTokens = launchedAgedTokens;
        });
      },
      (err) => {
        if (this.inflight !== controller) return;
        this.inflight = null;
        if (isUnavailableError(err)) {
          this.failureStatus = this.unavailableMessage();
          this.host.setStatus(this.failureStatus, { aged: count });
          this.lastAttemptKey = "";
        } else {
          this.failureStatus = this.rejectMessage(err);
          this.host.setStatus(this.failureStatus, { aged: count });
        }
      }
    );
  }
  /**
   * Build the user-role prompt for the completion. The format spec lives in `systemPrompt`
   * (identical for both passes); this only varies the input wrapper and the one-line mode
   * preamble, both supplied by the subclass.
   *
   * FIRST round (`text == null`): `<conversation>` … `</conversation>` + `firstPassInstruction()`.
   * Every newly-aged block is included verbatim (all kinds, labeled by role/kind) — INCLUDING
   * kinds `includeInGroup` would later exclude from the fold, since they are still valid CONTEXT
   * for the model even when they must stay live on the wire.
   *
   * RECURSIVE round (`text != null`): `<${priorTag}>` … `</${priorTag}>` + `<conversation>` …
   * `</conversation>` + `recursiveInstruction()`. The originals already fed into a prior round are
   * deliberately not re-read (recursive amnesia by design for the assistant/tool/thinking content
   * that DID get folded away; see each subclass for why).
   *
   * INJECTION DEFENSE: block text, block labels, and the prior round's text are all interpolated
   * inside `<conversation>` / `<${priorTag}>` tags. A tool_result carrying a literal closing tag
   * (a web fetch or file read — attacker-influenceable) would otherwise break out of the data
   * section and inject instructions into the completion call. `neutralize` breaks any such
   * closing tag in interpolated content; `systemPrompt` is expected to declare everything inside
   * those tags untrusted data, never instructions.
   */
  buildPrompt(newlyAged) {
    const conversation = newlyAged.map((b) => {
      const label = this.neutralize(blockLabel(b));
      const text = this.neutralize(this.promptTextOf(b));
      return text ? `[${label}]
${text}` : `[${label}]`;
    }).join("\n\n");
    if (this.text !== null) {
      return [
        `<${this.priorTag}>`,
        this.neutralize(this.text),
        `</${this.priorTag}>`,
        "",
        "<conversation>",
        conversation,
        "</conversation>",
        "",
        this.recursiveInstruction()
      ].join("\n");
    }
    return ["<conversation>", conversation, "</conversation>", "", this.firstPassInstruction()].join("\n");
  }
};

// conductors/in-process/compaction-naive/compaction-naive.ts
var COMPACTION_SYSTEM = `You are a context-compaction assistant. Your task is to read a segment of an AI assistant's conversation history and produce a compact, structured briefing that the assistant can use to continue working effectively without seeing the original messages.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.

USER MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM, in order, exactly as originally written, in the "## User messages" section. Do not paraphrase, abbreviate, summarize, or omit a single user message \u2014 the human's intent and instructions must survive compaction intact. (Assistant text, thinking, tool calls, and tool results ARE summarized; only user messages are preserved word-for-word.)

Produce your output in EXACTLY this structure \u2014 no prose outside the sections. Keep every section even when empty; write "(none)" where nothing applies:

## User messages
Every user message from the summarized segment, reproduced verbatim, in order, each clearly separated. If there are no user messages, write "(none)".

## Goal
One sentence: what is the overall task or objective being pursued?

## Progress
Bullet list of what has been accomplished so far. Be specific: files changed, commands run, decisions made, errors encountered and resolved.

## Key decisions
Bullet list of the important choices made (architecture, approach, libraries, workarounds). Include the reasoning where it matters for future steps.

## Next steps
Bullet list of what is expected to happen next, in the order the work is heading.

## Critical context
Any facts, invariants, or constraints the assistant MUST remember: API keys pattern (never actual values), file paths, environment quirks, non-obvious rules from the human's instructions, hard constraints on scope. Err on the side of including something here if it would be surprising to lose it.

## Relevant files
- {file path}: why it matters. List files that were read, written, or are central to the task. Write "(none)" if none.

Be terse everywhere EXCEPT the verbatim user messages, which must be complete. Omit pleasantries, meta-commentary, and filler. The output will be placed directly into the agent's context window.`;

// conductors/in-process/doorman/classify.ts
var READ_TOOLS = /* @__PURE__ */ new Set(["read", "view", "cat", "readfile", "read_file", "open"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set([
  "bash",
  "shell",
  "sh",
  "exec_command",
  "run_command",
  "execute",
  "powershell",
  "pwsh"
]);
var CODE_EXTS = /* @__PURE__ */ new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "svelte",
  "vue",
  "py",
  "pyi",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cxx",
  "rb",
  "php",
  "swift",
  "sql",
  "css",
  "scss",
  "less",
  "sh",
  "bash"
]);
var PROSE_DATA_EXTS = /* @__PURE__ */ new Set([
  "md",
  "markdown",
  "txt",
  "rst",
  "json",
  "yaml",
  "yml",
  "toml",
  "lock",
  "csv",
  "log",
  "html",
  "xml",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "pdf"
]);
var CSS_EXTS = /* @__PURE__ */ new Set(["css", "scss", "less"]);
var CODE_KEYWORDS = [
  "function ",
  "class ",
  "def ",
  "import ",
  "export ",
  "const ",
  "fn ",
  "struct ",
  "impl ",
  "interface ",
  "public ",
  "async ",
  "return ",
  "package ",
  "#include"
];
function classifyCodeRead(block, callById) {
  if (block.kind !== "tool_result" || block.isError) return null;
  const rawOutput = block.text;
  if (typeof rawOutput !== "string" || rawOutput.length === 0) return null;
  const call = block.callId ? callById.get(block.callId) : void 0;
  const callText = call?.text;
  const args = parseCallArgs(callText);
  const effName = effectiveToolName(block.toolName, callText);
  if (!effName) return null;
  let path;
  if (READ_TOOLS.has(effName)) {
    path = asPath(args.file_path) ?? asPath(args.path);
  } else if (SHELL_TOOLS.has(effName)) {
    const command = asString(args.command);
    if (command === void 0) return null;
    path = singleFileCatTarget(command);
    if (path === void 0) return null;
  } else {
    return null;
  }
  if (path !== void 0) {
    const ext2 = extensionOf(path);
    if (ext2 !== void 0) {
      if (PROSE_DATA_EXTS.has(ext2)) return null;
      if (!CODE_EXTS.has(ext2)) return null;
    } else {
    }
  }
  const source = cleanSource(rawOutput);
  if (source.length === 0) return null;
  const ext = path !== void 0 ? extensionOf(path) : void 0;
  const cssMode = ext !== void 0 && CSS_EXTS.has(ext);
  const knownCodeExt = ext !== void 0 && CODE_EXTS.has(ext);
  if (!looksLikeCode(source, cssMode)) return null;
  if (!knownCodeExt && !cssMode) {
    if (!hasCodeKeyword(source)) return null;
    if (looksLikeJson(source)) return null;
  }
  return { path, source };
}
function leadingToolName(callText) {
  if (typeof callText !== "string") return void 0;
  const trimmed = callText.trimStart();
  if (trimmed.length === 0) return void 0;
  const m = trimmed.match(/^([^\s{]+)/);
  if (!m) return void 0;
  return m[1].toLowerCase();
}
function effectiveToolName(toolName, callText) {
  const own = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  if (own !== "" && own !== "tool") return own;
  return leadingToolName(callText);
}
function parseCallArgs(callText) {
  if (typeof callText !== "string") return {};
  const start = callText.indexOf("{");
  if (start < 0) return {};
  const jsonPart = callText.slice(start);
  try {
    const parsed = JSON.parse(jsonPart);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return {};
}
function asString(v) {
  return typeof v === "string" ? v : void 0;
}
function asPath(v) {
  if (typeof v !== "string") return void 0;
  const t = v.trim();
  return t.length > 0 ? t : void 0;
}
function extensionOf(path) {
  const cleaned = path.trim().replace(/^["']|["']$/g, "");
  const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return void 0;
  return base.slice(dot + 1).toLowerCase();
}
function singleFileCatTarget(command) {
  const cmd = command.trim();
  if (cmd.length === 0) return void 0;
  if (/[|]/.test(cmd)) return void 0;
  if (/&&|\|\||;/.test(cmd)) return void 0;
  if (/[<>]/.test(cmd)) return void 0;
  if (/`|\$\(/.test(cmd)) return void 0;
  if (/(^|\s)(-f|-F|--follow(=\S*)?|-Wait)(\s|$)/.test(cmd)) return void 0;
  if (/\b(grep|rg|egrep|fgrep|ag|ack|find|fd|ls|dir|get-childitem|gci|tree)\b/i.test(cmd)) return void 0;
  if (/\bgit\s+\w/i.test(cmd)) return void 0;
  const tokens = tokenizeCommand(cmd);
  if (tokens.length === 0) return void 0;
  let i = 0;
  const first = tokens[0].toLowerCase();
  if ((first === "type" || first === "cat" || first === "bat") && tokens.length > 2) {
    const second = tokens[1].toLowerCase();
    if (DUMP_VERBS.has(second) || (second === "get-content" || second === "gc")) {
      i = 1;
    }
  }
  const verb = tokens[i].toLowerCase();
  let rest = tokens.slice(i + 1);
  if (verb === "sed") {
    if (!rest.some((t) => t === "-n")) return void 0;
    const fileCandidates = rest.filter((t) => !t.startsWith("-") && !isSedScript(t));
    return soleFile(fileCandidates);
  }
  if (verb === "get-content" || verb === "gc") {
    return soleFile(stripFlagsAndValues(rest));
  }
  if (DUMP_VERBS.has(verb)) {
    return soleFile(stripFlagsAndValues(rest));
  }
  return void 0;
}
var DUMP_VERBS = /* @__PURE__ */ new Set(["cat", "head", "tail", "type"]);
function isSedScript(t) {
  const s = t.replace(/^["']|["']$/g, "");
  return /^[$\d][\d,]*[a-z]?$/i.test(s) || /p$/.test(s);
}
function soleFile(candidates) {
  const files = candidates.map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => t.length > 0);
  if (files.length !== 1) return void 0;
  const file = files[0];
  if (file.includes("*") || file.includes("?")) return void 0;
  if (/[\\/]$/.test(file)) return void 0;
  return file;
}
function stripFlagsAndValues(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      const next = tokens[i + 1];
      if (next !== void 0 && /^\d+$/.test(next.replace(/^["']|["']$/g, ""))) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}
function tokenizeCommand(cmd) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}
function cleanSource(raw) {
  let text = stripExecHeader(raw);
  text = stripLineNumberPrefixes(text);
  text = stripTrailingTruncation(text);
  return text;
}
function stripExecHeader(raw) {
  const lines = raw.split("\n");
  const limit = Math.min(lines.length, 12);
  let outputIdx = -1;
  for (let i = 0; i < limit; i++) {
    if (lines[i].trim() === "Output:") {
      outputIdx = i;
      break;
    }
  }
  if (outputIdx < 0) return raw;
  const strongRe = /^(Wall time:|Chunk ID:|Original token count:|Process exited with code\b)/i;
  let strong = 0;
  for (let i = 0; i < outputIdx; i++) {
    if (strongRe.test(lines[i].trim())) strong++;
  }
  if (strong === 0) return raw;
  return lines.slice(outputIdx + 1).join("\n");
}
function stripLineNumberPrefixes(text) {
  const lines = text.split("\n");
  const prefixRe = /^\s*(\d+)\t/;
  let nonEmpty = 0;
  let matching = 0;
  let prev = -Infinity;
  let monotonic = true;
  for (const line of lines) {
    if (line.trim() === "") continue;
    nonEmpty++;
    const m = prefixRe.exec(line);
    if (m) {
      matching++;
      const n = Number(m[1]);
      if (n < prev) monotonic = false;
      prev = n;
    }
  }
  if (nonEmpty === 0) return text;
  if (matching / nonEmpty <= 0.6) return text;
  if (!monotonic) return text;
  return lines.map((line) => prefixRe.test(line) ? line.replace(prefixRe, "") : line).join("\n");
}
function stripTrailingTruncation(text) {
  return text.replace(/[\s.…]*[([]?\s*truncated\s*[)\]]?\s*$/i, "");
}
function looksLikeCode(source, cssMode) {
  const head = source.slice(0, 4096);
  if (cssMode) {
    return head.includes("{") && head.includes("}");
  }
  let signals = 0;
  if (hasCodeKeyword(head)) signals++;
  const punct = (head.match(/[{}()\[\];:]/g) ?? []).length;
  if (punct >= 6 && punct / head.length >= 0.012) signals++;
  const lines = head.split("\n");
  let indented = 0;
  for (const line of lines) {
    if (/^(\t| {2,})\S/.test(line)) indented++;
  }
  if (indented >= 2) signals++;
  return signals >= 2;
}
function hasCodeKeyword(text) {
  const head = text.slice(0, 4096);
  return CODE_KEYWORDS.some((kw) => head.includes(kw));
}
function looksLikeJson(source) {
  const trimmed = source.trim();
  if (trimmed.length === 0) return false;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

// conductors/ws/triptych/triptych.ts
var SHRINK_MAX = 0.7;
var MIN_SKELETON_TOKENS = 700;
var TriptychConductor = class extends AgedSummaryConductor {
  constructor(skel) {
    super();
    this.skel = skel;
  }
  id = "triptych";
  label = "Triptych";
  description = "Pressure-gated thirds: raw recent band, code-skeleton middle band, lossy compaction summary top band.";
  /**
   * Involvement locks (ADR 0011): fully exclusive, compaction-naive's posture (owner decision).
   * `human-steering` keeps the summarized region contiguous (a mid-region pin would split the
   * single group); `agent-unfold` declares the agent cannot reopen a skeleton — `recall` (never
   * lockable) remains its read path to elided bodies. `tail-size` is deliberately NOT locked:
   * the bottom band respects whatever tail the human sets.
   */
  locks = ["human-steering", "agent-unfold"];
  systemPrompt = COMPACTION_SYSTEM;
  priorTag = "previous-summary";
  /** Sticky pressure gate: false until the visible window first crosses `TRIGGER`; never unset
   *  until detach/re-attach. */
  active = false;
  /**
   * Per-block skeleton cache: block id → the full labeled replacement content, or null for
   * "evaluated and declined" (not code / unsupported language / didn't shrink) so a declined
   * block is never re-parsed every pass. Block text is immutable once appended, so id-keyed
   * caching is safe; the map is reset on attach.
   */
  skelCache = /* @__PURE__ */ new Map();
  attach(host) {
    this.active = false;
    this.skelCache = /* @__PURE__ */ new Map();
    super.attach(host);
    void this.skel.init().then(
      () => this.rerun(),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.failureStatus = truncateForStatus(`Triptych: skeleton engine failed to load \u2014 summaries only (${msg})`);
        this.host.setStatus(this.failureStatus);
      }
    );
  }
  // ── the triptych pass ──────────────────────────────────────────────────────────
  conduct(view) {
    const cap = this.effectiveCap(view);
    if (!this.active && cap > 0 && view.blocks.length > 0 && sumTokens(view.blocks) >= cap * TRIGGER) {
      this.active = true;
    }
    const summary = super.conduct(view);
    if (summary === null) return null;
    if (!this.active) return summary;
    return [...summary, ...this.skeletonCommands(view)];
  }
  // ── band geometry ────────────────────────────────────────────────────────────
  /** The effective cap the bands are thirds of — same clamp the base trigger uses. */
  effectiveCap(view) {
    return view.contextWindow != null ? Math.min(view.budget, view.contextWindow) : view.budget;
  }
  /**
   * Band boundaries, measured in RAW (full) tokens walking from the newest block backward:
   *   bottom band = blocks[bottomStart ..)  — the suffix that first accumulates cap/3.
   *   middle band = blocks[topEnd .. bottomStart)
   *   top band    = blocks[0 .. topEnd)     — everything older than 2·cap/3 from the tip.
   * Raw tokens on purpose: boundaries measure AGE in original content, so they do not lurch
   * when a fold changes a block's visible cost. `bottomStart` is clamped to the protected-tail
   * boundary so the untouched band always contains the tail (the tail is never ours to touch).
   */
  bands(view) {
    const third = this.effectiveCap(view) / 3;
    let bottomStart = 0;
    let topEnd = 0;
    if (third > 0) {
      let cum = 0;
      let haveBottom = false;
      for (let i = view.blocks.length - 1; i >= 0; i--) {
        cum += view.blocks[i].tokens;
        if (!haveBottom && cum >= third) {
          bottomStart = i;
          haveBottom = true;
        }
        if (cum >= 2 * third) {
          topEnd = i;
          break;
        }
      }
      if (!haveBottom) bottomStart = 0;
    }
    bottomStart = Math.min(bottomStart, view.protectedFromIndex);
    topEnd = Math.min(topEnd, bottomStart);
    while (topEnd > 0 && topEnd < view.blocks.length && messageKey(view.blocks[topEnd].id) === messageKey(view.blocks[topEnd - 1].id)) {
      topEnd--;
    }
    return { bottomStart, topEnd };
  }
  // ── AgedSummaryConductor hooks ───────────────────────────────────────────────
  /** The summary machinery may sweep ONLY the top band — and nothing at all pre-activation. */
  agedBoundaryIndex(view) {
    if (!this.active) return 0;
    return this.bands(view).topEnd;
  }
  /** Feed the summarizer the skeleton for skeletonized blocks (implementer decision #1). */
  promptTextOf(b) {
    const skel = this.skelCache.get(b.id);
    return skel != null ? skel : (b.text ?? "").trim();
  }
  // ── the middle band: skeleton folds ──────────────────────────────────────────
  /**
   * One labeled `replace` (recoverable ⇒ `{#code FOLDED}`-tagged) per classified code read
   * older than the bottom band that the summary group does not already cover. Blocks in the
   * not-yet-summarized part of the top band are included on purpose — they benefit from the
   * skeleton until a summary run sweeps them (at which point `ViewConductor`'s diffing clears
   * the replace as the block enters the group).
   */
  skeletonCommands(view) {
    if (!this.skel.ready()) return [];
    const { bottomStart } = this.bands(view);
    const limit = Math.min(bottomStart, view.protectedFromIndex, view.blocks.length);
    if (limit <= 0) return [];
    let callById = null;
    const out = [];
    for (let i = 0; i < limit; i++) {
      const b = view.blocks[i];
      if (b.kind !== "tool_result" || b.held || b.grouped) continue;
      if (b.tokens < MIN_SKELETON_TOKENS) continue;
      if (this.coveredIds.has(b.id) && this.includeInGroup(b)) continue;
      let content = this.skelCache.get(b.id);
      if (content === void 0) {
        if (callById === null) {
          callById = /* @__PURE__ */ new Map();
          for (const c of view.blocks) if (c.kind === "tool_call" && c.callId) callById.set(c.callId, c);
        }
        content = this.evaluateSkeleton(b, callById);
        this.skelCache.set(b.id, content);
      }
      if (content === null) continue;
      out.push({ kind: "replace", id: b.id, content, recoverable: true });
    }
    return out;
  }
  /** Classify → skeletonize → label → shrink-gate. Null = decline (cached, never re-parsed). */
  evaluateSkeleton(b, callById) {
    const info = classifyCodeRead(b, callById);
    if (info === null) return null;
    const skeleton = this.skel.skeletonize(info.path, info.source);
    if (skeleton === null) return null;
    const srcLines = countLines(info.source);
    const content = `${skeletonHeader(info.path, srcLines)}
${skeleton}`;
    const original = b.text ?? "";
    if (original.length === 0 || content.length > original.length * SHRINK_MAX) return null;
    return content;
  }
  // ── summary prompt + status strings (subclass-owned by the AgedSummaryConductor contract) ──
  /* The two instruction strings are compaction-naive's VERBATIM (the owner's spec is "the same
   * prompt as compaction naive", end to end). They are protected methods on that class, so the
   * strings are mirrored here rather than imported — keep in lockstep with
   * `NaiveCompactionConductor.firstPassInstruction` / `.recursiveInstruction`. */
  firstPassInstruction() {
    return "Create a structured summary from the conversation history above.";
  }
  recursiveInstruction() {
    return 'Update the summary in <previous-summary> using the new conversation history in <conversation>. PRESERVE all still-relevant details from the previous summary; remove stale ones; merge in new facts. Move completed work into "Progress" and revise "Next Steps" accordingly. Preserve exact file paths, function names, and error messages when known. Carry forward every verbatim user message from the previous summary and append the new user messages from the conversation \u2014 all still reproduced word-for-word in "## User messages".';
  }
  formatText(count, body) {
    return `[Compacted summary of ${count} earlier message${count === 1 ? "" : "s"}]

${body}`;
  }
  emptyOutputMessage(_count) {
    return "Triptych: summary failed \u2014 model returned empty output";
  }
  windowTooTightMessage(inputTokens, contextWindow) {
    return `Triptych: summary needs a bigger window \u2014 input \u2248 ${inputTokens} tokens leaves no room to write in a ${contextWindow}-token window`;
  }
  rejectMessage(err) {
    return truncateForStatus(`Triptych: summary failed \u2014 ${err instanceof Error ? err.message : String(err)}`);
  }
  unavailableMessage() {
    return "Triptych: summary unavailable \u2014 waiting for live model link";
  }
};
function skeletonHeader(path, srcLines) {
  const what = path !== void 0 ? path : "a code file";
  return `[code skeleton of ${what} \u2014 signatures kept, bodies elided (${srcLines} source lines). Use recall with the fold code above for the full file.]`;
}
function countLines(s) {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
export {
  TriptychConductor,
  runRemoteConductor
};
