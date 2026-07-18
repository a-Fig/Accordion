// remote-sdk.mjs — GENERATED ARTIFACT, DO NOT EDIT BY HAND.
// Bundled from core/conductor/remote.ts + conductors/thermocline/thermocline.ts (and their core/
// graph) by extension/build-remote-sdk.mjs. Regenerate with:
//     node extension/build-remote-sdk.mjs      (or: npm --prefix extension run build:remote-sdk)
// Flat ESM, runnable under plain `node` (Node 22+ ships the global WebSocket the SDK dials with).
// `ws` is intentionally NOT bundled/required. Exports: runRemoteConductor, ThermoclineConductor.

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
      } else {
        prevRole = void 0;
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

// core/truth.ts
var PROTECT_OVERFLOW_CAP = 1.25;
var LEADING_FOLD_TAG = /^\s*\{#[0-9a-z]{6} FOLDED\}\s*/;
function messageKey(id) {
  const live = id.match(/^(.*):p(?:\d+|\?)$/);
  if (live) return live[1];
  const parsed = id.match(/^(.+):\d+$/);
  if (parsed && !/^[a-z]:\d+$/.test(id)) return parsed[1];
  return id;
}
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
  messageKeyOf(id) {
    return messageKey(id);
  }
  liveTokens() {
    let n = 0;
    for (const b of this.blockLog) n += this.effTokens(b);
    return n;
  }
  fullTokens() {
    let n = 0;
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
      liveTokens: this.liveTokens(),
      fullTokens: this.fullTokens(),
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
  protectedFromIndex() {
    if (this.pfiCache.rev === this.revCounter) return this.pfiCache.value;
    const value = this.computeProtectedFromIndex();
    this.pfiCache = { rev: this.revCounter, value };
    return value;
  }
  computeProtectedFromIndex() {
    const blocks = this.blockLog;
    if (!blocks.length) return 0;
    const target = this.isLocked("tail-size") ? this.activeTailTok : this.protectTokensTarget;
    if (target === 0) return blocks.length;
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
  classifyGroup(g) {
    const members = [];
    for (const id of g.memberIds) {
      const b = this.get(id);
      if (b) members.push(b);
    }
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
    const live = this.wireAttached;
    const removable = /* @__PURE__ */ new Set();
    for (const k of msgOrder) {
      const msgBlocks = byMsg.get(k);
      if (live && msgBlocks.some((b) => !isDurableId(b.id))) continue;
      removable.add(k);
    }
    let changed = true;
    do {
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
        const unbalanced = msgCalls.get(k).some((c) => !results.has(c)) || msgResults.get(k).some((c) => !calls.has(c));
        if (unbalanced) {
          removable.delete(k);
          changed = true;
        }
      }
    } while (changed);
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
    tokens: b.tokens,
    foldedTokens: truth.foldedTokensOf(b),
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
var PROTOCOL_VERSION = 15;
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
  "completeResult"
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
        countTokens(text) {
          return estTokens(text);
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

// conductors/thermocline/thermocline.ts
import { mkdirSync, writeFileSync as writeFileSync2, renameSync, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// conductors/thermocline/policy.ts
var FOLDABLE_KINDS2 = /* @__PURE__ */ new Set(["text", "thinking", "tool_result"]);
var DEFAULT_CFG = {
  highWater: 0.9,
  // conductor: a planned epoch must have finished before this
  lowWater: 0.7,
  // planEpoch composes moves until project(plan) ≤ lowWater·cap
  warmWater: 0.8,
  // conductor: begin preparing the next epoch around here
  ceilingFrac: 0.2,
  // Σ stratum tokens may not exceed this fraction of cap
  coldThreshold: 0.35,
  // temperature below which a unit counts as cold
  K: 3,
  // dwell epochs a unit must stay cold+untouched before it graduates to a stratum
  minRunUnits: 3,
  // a run shorter than this stays merely folded, never becomes a stratum
  minFoldTokens: 200
  // a deepen whose savings is below this is not worth a cache slot
};
function buildUnits(blocks) {
  const resultByCall = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    if (b.kind === "tool_result" && b.callId) resultByCall.set(b.callId, b);
  }
  const pairedResultIds = /* @__PURE__ */ new Set();
  for (const b of blocks) {
    if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
      pairedResultIds.add(resultByCall.get(b.callId).id);
    }
  }
  const units = [];
  for (const b of blocks) {
    if (b.kind === "tool_result" && pairedResultIds.has(b.id)) continue;
    let members;
    if (b.kind === "tool_call" && b.callId && resultByCall.has(b.callId)) {
      members = [b, resultByCall.get(b.callId)];
    } else {
      members = [b];
    }
    units.push(makeUnit(members));
  }
  return units;
}
function makeUnit(members) {
  const first = members[0];
  const result = members.find((m) => m.kind === "tool_result");
  let tokens = 0;
  let foldedTokens = 0;
  let held = false;
  let protectedFlag = false;
  let grouped = false;
  let foldable = true;
  for (const m of members) {
    tokens += m.tokens;
    foldedTokens += m.foldedTokens;
    held = held || m.held;
    protectedFlag = protectedFlag || m.protected;
    grouped = grouped || m.grouped;
    if (!FOLDABLE_KINDS2.has(m.kind)) foldable = false;
  }
  return {
    id: first.id,
    ids: members.map((m) => m.id),
    kinds: members.map((m) => m.kind),
    blocks: members,
    tokens,
    foldedTokens,
    order: first.order,
    turn: first.turn,
    foldable,
    temperatureKey: result ? result.id : first.id,
    held,
    protected: protectedFlag,
    grouped
  };
}
function project(view, applied) {
  const byId = new Map(view.blocks.map((b) => [b.id, b]));
  let t = view.liveTokens;
  for (const id of applied.foldedIds ?? /* @__PURE__ */ new Set()) {
    const b = byId.get(id);
    if (b) t -= Math.max(0, b.tokens - b.foldedTokens);
  }
  for (const s of applied.strata ?? []) {
    let members = 0;
    for (const id of s.memberIds) {
      const b = byId.get(id);
      if (b) members += b.tokens;
    }
    t -= Math.max(0, members - s.summaryTokens);
  }
  return Math.max(0, t);
}
function updateGraduation(state, view, scores, cfg = DEFAULT_CFG) {
  const units = buildUnits(view.blocks);
  const prevDwell = state.dwell ?? /* @__PURE__ */ new Map();
  const everWarm = state.everWarm ?? /* @__PURE__ */ new Set();
  const touched = unionSet(state.agentTouched, state.recalledThisEpoch);
  const dwell = /* @__PURE__ */ new Map();
  const graduated = /* @__PURE__ */ new Set();
  for (const u of units) {
    const temp = scores.get(u.temperatureKey);
    const cold = temp !== void 0 && temp < cfg.coldThreshold;
    const folded = isUnitFolded(u);
    const reWarm = !cold || u.ids.some((id) => touched.has(id)) || u.held;
    if (reWarm || !folded || u.protected) {
      dwell.set(u.id, 0);
      continue;
    }
    const next = (prevDwell.get(u.id) ?? 0) + 1;
    dwell.set(u.id, next);
    const need = everWarm.has(u.id) ? 2 * cfg.K : cfg.K;
    if (next >= need) graduated.add(u.id);
  }
  return { dwell, graduated };
}
function isUnitFolded(u) {
  return u.blocks.every((b) => b.folded);
}
function runCtx(view) {
  const pos = /* @__PURE__ */ new Map();
  const keys = [];
  const idAt = [];
  view.blocks.forEach((b, i) => {
    pos.set(b.id, i);
    keys.push(messageKey(b.id));
    idAt.push(b.id);
  });
  return { pos, keys, idAt };
}
function safeRunFromUnits(runUnits, ctx) {
  for (const u of runUnits) for (const id of u.ids) if (!ctx.pos.has(id)) return null;
  let i0 = 0;
  let i1 = runUnits.length;
  while (i0 < i1) {
    let firstPos = Infinity;
    let lastPos = -Infinity;
    const memberSet = /* @__PURE__ */ new Set();
    for (let k = i0; k < i1; k++) {
      for (const id of runUnits[k].ids) {
        const p = ctx.pos.get(id);
        memberSet.add(p);
        if (p < firstPos) firstPos = p;
        if (p > lastPos) lastPos = p;
      }
    }
    let lo = firstPos;
    let hi = lastPos;
    while (lo > 0 && ctx.keys[lo - 1] === ctx.keys[lo]) lo--;
    while (hi < ctx.keys.length - 1 && ctx.keys[hi + 1] === ctx.keys[hi]) hi++;
    let exact = lo === firstPos && hi === lastPos && hi - lo + 1 === memberSet.size;
    if (exact) {
      for (let p = lo; p <= hi; p++) if (!memberSet.has(p)) {
        exact = false;
        break;
      }
    }
    if (exact) {
      const units = runUnits.slice(i0, i1);
      return {
        unitIds: units.map((u) => u.id),
        memberIds: units.flatMap((u) => u.ids),
        firstId: ctx.idAt[firstPos],
        lastId: ctx.idAt[lastPos]
      };
    }
    if (lo < firstPos) i0++;
    else i1--;
  }
  return null;
}
function sedimentRuns(view, scores, graduated, cfg = DEFAULT_CFG, units = null) {
  if (!units) units = buildUnits(view.blocks);
  const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
  const protectedFrom = view.blocks[pfi]?.order ?? Infinity;
  const ctx = runCtx(view);
  const runs = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= cfg.minRunUnits) {
      const safe = safeRunFromUnits(cur, ctx);
      if (safe && safe.unitIds.length >= cfg.minRunUnits) runs.push(safe);
    }
    cur = [];
  };
  for (const u of units) {
    const olderThanTail = u.order < protectedFrom;
    const isGraduatedCold = graduated.has(u.id) && olderThanTail;
    if (isGraduatedCold) cur.push(u);
    else flush();
  }
  flush();
  return runs;
}
function ageBasedRuns(units, view, claimed, cfg, minUnits = cfg.minRunUnits) {
  const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
  const protectedFrom = view.blocks[pfi]?.order ?? Infinity;
  const ctx = runCtx(view);
  const runs = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= minUnits) {
      const safe = safeRunFromUnits(cur, ctx);
      if (safe && safe.unitIds.length >= minUnits) runs.push(safe);
    }
    cur = [];
  };
  for (const u of units) {
    const olderThanTail = u.order < protectedFrom;
    const notClaimed = !claimed.has(u.id);
    const eligible = olderThanTail && notClaimed && !u.held && !u.protected && !u.grouped;
    if (eligible) cur.push(u);
    else flush();
  }
  flush();
  return runs;
}
function planEpoch(view, scores, _state, cfg = DEFAULT_CFG, opts = {}) {
  const deterministic = !!opts.deterministic;
  const cap = capOf(view);
  const targetTokens = cfg.lowWater * cap;
  const units = buildUnits(view.blocks);
  const byUnit = new Map(units.map((u) => [u.id, u]));
  const graduated = opts.graduated ?? /* @__PURE__ */ new Set();
  const runs = sedimentRuns(view, scores, graduated, cfg, units);
  const strata = runs.map((r) => ({
    ids: [r.firstId, r.lastId],
    unitIds: r.unitIds,
    memberIds: r.memberIds,
    digestKind: "summary",
    // an LLM (or deterministic recap) summary; never DROP at birth
    summaryTokens: estimateStratumTokens(r, byUnit)
  }));
  const claimedByStratum = new Set(strata.flatMap((s) => s.unitIds));
  const cands = units.filter((u) => isEligibleToDeepen(u, scores, cfg) && !claimedByStratum.has(u.id)).filter((u) => savingOf(u) >= cfg.minFoldTokens).sort(
    (a, b) => savingOf(b) - savingOf(a) || // biggest saving first
    (scores.get(a.temperatureKey) ?? 1) - (scores.get(b.temperatureKey) ?? 1) || // colder first
    a.order - b.order
    // older first
  );
  const folds = [];
  const foldedIds = /* @__PURE__ */ new Set();
  const applied = () => ({
    foldedIds,
    strata: strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens }))
  });
  let ci = 0;
  while (project(view, applied()) > targetTokens && ci < cands.length) {
    const u = cands[ci++];
    const tier = deterministic ? "trim" : "digest";
    folds.push({ unitId: u.id, ids: u.ids.filter((id) => isMemberFoldable(byUnit.get(u.id), id)), tier });
    for (const id of u.ids) {
      if (isMemberFoldable(byUnit.get(u.id), id)) foldedIds.add(id);
    }
  }
  mergeOverCeiling(strata, cap, cfg, byUnit);
  if (project(view, applied()) > targetTokens) {
    const claimedBeforeLastResort = /* @__PURE__ */ new Set([
      ...claimedByStratum,
      ...folds.flatMap((f) => byUnit.get(f.unitId)?.ids ?? [])
    ]);
    const ageRuns = ageBasedRuns(units, view, claimedBeforeLastResort, cfg);
    for (const r of ageRuns) {
      if (project(view, applied()) <= targetTokens) break;
      const alreadyClaimed = r.unitIds.some((id) => claimedBeforeLastResort.has(id));
      if (alreadyClaimed) continue;
      const stratumEntry = {
        ids: [r.firstId, r.lastId],
        unitIds: r.unitIds,
        memberIds: r.memberIds,
        digestKind: "summary",
        summaryTokens: estimateStratumTokens(r, byUnit)
      };
      strata.push(stratumEntry);
      for (const uid of r.unitIds) claimedBeforeLastResort.add(uid);
    }
    mergeOverCeiling(strata, cap, cfg, byUnit);
  }
  dropStrataOldestFirst(strata, view, applied, targetTokens);
  if (project(view, applied()) > cap) {
    const claimed = /* @__PURE__ */ new Set([...claimedByStratum, ...strata.flatMap((s) => s.unitIds)]);
    for (const f of folds) claimed.add(f.unitId);
    let prev = Infinity;
    while (project(view, applied()) > cap) {
      const before = project(view, applied());
      if (before >= prev) break;
      prev = before;
      const foldU = biggestForceFoldable(units, foldedIds, claimed);
      if (foldU) {
        const tier = deterministic ? "trim" : "digest";
        folds.push({
          unitId: foldU.id,
          ids: foldU.ids.filter((id) => isMemberFoldable(byUnit.get(foldU.id), id)),
          tier
        });
        for (const id of foldU.ids) {
          if (isMemberFoldable(byUnit.get(foldU.id), id)) foldedIds.add(id);
        }
        claimed.add(foldU.id);
        continue;
      }
      const forceRuns = ageBasedRuns(units, view, claimed, cfg, 1);
      if (forceRuns.length) {
        const best = forceRuns[0];
        const bestTok = runMemberTokens(best, byUnit);
        const summaryTokens = estimateStratumTokens(best, byUnit);
        const reduces = bestTok > summaryTokens;
        strata.push({
          ids: [best.firstId, best.lastId],
          unitIds: best.unitIds,
          memberIds: best.memberIds,
          digestKind: reduces ? "summary" : "drop",
          summaryTokens: reduces ? summaryTokens : 0
        });
        for (const uid of best.unitIds) claimed.add(uid);
        continue;
      }
      const droppedAny = dropStrataOldestFirst(strata, view, applied, cap);
      if (!droppedAny) break;
    }
  }
  const projected = project(view, applied());
  return {
    folds,
    strata,
    targetTokens,
    cap,
    projected,
    // The Rung-5 loop above is gated on `project(...) > cap`; if it still is here (either break —
    // the no-progress guard at its top, or the `!droppedAny` exhaustion floor inside branch (c) —
    // left it unsatisfied), the floor genuinely cannot reach cap. See the Plan.irreducible doc.
    irreducible: projected > cap
  };
}
function dropStrataOldestFirst(strata, view, applied, bound) {
  const orderOf = new Map(view.blocks.map((b) => [b.id, b.order]));
  const sorted = strata.map((s, i) => ({ s, i, ord: orderOf.get(s.ids[0]) ?? Infinity })).sort((a, b) => a.ord - b.ord);
  let droppedAny = false;
  for (const { s } of sorted) {
    if (project(view, applied()) <= bound) break;
    if (s.digestKind !== "drop") {
      s.digestKind = "drop";
      s.summaryTokens = 0;
      droppedAny = true;
    }
  }
  return droppedAny;
}
function biggestForceFoldable(units, foldedIds, inStratum) {
  let best = null;
  let bestSave = 0;
  for (const u of units) {
    if (!u.foldable) continue;
    if (u.held || u.protected || u.grouped) continue;
    if (u.foldedTokens >= u.tokens) continue;
    if (inStratum.has(u.id)) continue;
    if (u.ids.some((id) => foldedIds.has(id))) continue;
    const save = savingOf(u);
    if (save > bestSave) {
      best = u;
      bestSave = save;
    }
  }
  return best;
}
function runMemberTokens(run, byUnit) {
  let t = 0;
  for (const uid of run.unitIds) {
    const u = byUnit.get(uid);
    if (u) t += u.tokens;
  }
  return t;
}
function isEligibleToDeepen(u, scores, cfg) {
  if (!u.foldable) return false;
  if (u.held || u.protected || u.grouped) return false;
  if (u.foldedTokens >= u.tokens) return false;
  const temp = scores.get(u.temperatureKey);
  if (temp !== void 0 && temp >= cfg.coldThreshold) return false;
  return true;
}
function savingOf(u) {
  return Math.max(0, u.tokens - u.foldedTokens);
}
function isMemberFoldable(unit, id) {
  const idx = unit.ids.indexOf(id);
  return idx >= 0 && FOLDABLE_KINDS2.has(unit.kinds[idx]);
}
function estimateStratumTokens(run, byUnit) {
  let members = 0;
  for (const uid of run.unitIds) {
    const u = byUnit.get(uid);
    if (u) members += u.tokens;
  }
  return Math.min(8e3, Math.max(60, Math.round(members * 0.12)));
}
function mergeOverCeiling(strata, cap, cfg, byUnit) {
  const ceiling = cfg.ceilingFrac * cap;
  const sumStrata = () => strata.reduce((s, x) => s + x.summaryTokens, 0);
  while (sumStrata() > ceiling && strata.length > 1) {
    const [a, b] = [strata[0], strata[1]];
    const aLastUnit = byUnit.get(a.unitIds[a.unitIds.length - 1]);
    const bFirstUnit = byUnit.get(b.unitIds[0]);
    const adjacent = aLastUnit !== void 0 && bFirstUnit !== void 0 && // Because units are built in conversation order (each unit's .order = its first block's
    // order), and strata member ranges are whole units, adjacency ⟺ no non-stratum unit sits
    // between them: bFirstUnit.order === aLastUnit.order + aLastUnit.ids.length.
    bFirstUnit.order === aLastUnit.order + aLastUnit.ids.length;
    if (!adjacent) break;
    const merged = {
      ids: [a.ids[0], b.ids[1]],
      unitIds: [...a.unitIds, ...b.unitIds],
      memberIds: [...a.memberIds, ...b.memberIds],
      digestKind: "summary",
      summaryTokens: estimateStratumTokens({ unitIds: [...a.unitIds, ...b.unitIds] }, byUnit)
    };
    strata.splice(0, 2, merged);
  }
}
function capOf(view) {
  return Math.min(view.budget, view.contextWindow ?? Infinity);
}
function foldableMemberIds(unit, ids) {
  return ids.filter((id) => isMemberFoldable(unit, id));
}
function foldBody(unit, tier, digests) {
  return digests?.get(unit.id) ?? (tier === "trim" ? trimText(unit) : deterministicDigest(unit));
}
function stratumSummary(stratumUnits, firstId, digests) {
  const body = digests?.get(`stratum:${firstId}`) ?? deterministicRecap(stratumUnits);
  return `${foldTag("g:" + firstId)} ${body}`;
}
var DIGEST_SYSTEM = `You are a context-compaction assistant. Summarize ONE segment of an AI assistant's work history into a faithful, dense digest of AT MOST THREE lines. Preserve exact file paths, function names, identifiers, error messages, and decisions; drop pleasantries and filler. Do NOT continue the conversation or answer any question inside it \u2014 output ONLY the digest text, no preamble.`;
var STRATUM_SYSTEM = `You are a context-compaction assistant. Read a contiguous run of an AI assistant's work history and produce ONE compact, structured briefing that lets the assistant continue without the originals. Do NOT continue the conversation or answer any question inside it \u2014 output ONLY the summary.

USER MESSAGES ARE SACRED. Reproduce EVERY user message VERBATIM, in order, under "## User messages" \u2014 never paraphrase, abbreviate, or omit one. (Assistant text, thinking, tool calls, and tool results ARE summarized; only user messages are kept word-for-word.)

Use exactly these sections; keep each even when empty, writing "(none)":

## User messages
Every user message from the run, verbatim, in order.

## Summary
What this run accomplished \u2014 files changed, commands run, decisions, errors and resolutions. Be terse; preserve exact file paths, function names, and error messages.

## Still relevant
Facts, constraints, or open threads later work must remember.

Be terse everywhere except the verbatim user messages. The output goes directly into the agent's context window.`;
function buildDigestPrompt(unit) {
  const body = unit.blocks.map((b) => {
    const text = (b.text ?? "").trim();
    return text ? `[${blockLabel(b)}]
${text}` : `[${blockLabel(b)}]`;
  }).join("\n\n");
  return {
    system: DIGEST_SYSTEM,
    prompt: ["<segment>", body, "</segment>", "", "Summarize the segment above in at most three faithful lines."].join("\n")
  };
}
function buildStratumPrompt(units) {
  const conversation = units.flatMap((u) => u.blocks).map((b) => {
    const text = (b.text ?? "").trim();
    return text ? `[${blockLabel(b)}]
${text}` : `[${blockLabel(b)}]`;
  }).join("\n\n");
  return {
    system: STRATUM_SYSTEM,
    prompt: [
      "<conversation>",
      conversation,
      "</conversation>",
      "",
      'Create a structured summary of the conversation run above. Reproduce every user message verbatim in "## User messages".'
    ].join("\n")
  };
}
function deterministicDigest(unit) {
  const head = unit.blocks[0];
  const result = unit.blocks.find((b) => b.kind === "tool_result");
  if (head.kind === "tool_call") {
    const name = head.toolName ?? "tool";
    const peek = result ? firstLine2((result.text ?? "").trim(), 60) : "";
    return `${name}() \u2192 ${result?.isError ? "error" : peek || "done"}`;
  }
  return clip2((head.text ?? "").trim(), 120) || `${blockLabel(head)} \xB7 ~${head.tokens} tok`;
}
function deterministicRecap(units) {
  const blocks = units.flatMap((u) => u.blocks);
  if (!blocks.length) return "run \xB7 empty";
  let tokens = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let ask = "";
  const counts = /* @__PURE__ */ new Map();
  for (const b of blocks) {
    tokens += b.tokens;
    if (b.turn < lo) lo = b.turn;
    if (b.turn > hi) hi = b.turn;
    counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
    if (b.kind === "user" && !ask) ask = firstLine2((b.text ?? "").trim(), 70);
  }
  const span = lo === hi ? lo > 0 ? `turn ${lo}` : "preamble" : lo > 0 ? `turns ${lo}\u2013${hi}` : `preamble\u2013turn ${hi}`;
  const breakdown = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
  const quote = ask ? ` \xB7 \u201C${ask}\u201D` : "";
  return `run \xB7 ${blocks.length} block${blocks.length === 1 ? "" : "s"} \xB7 ${span} \xB7 ~${tokens} tok \xB7 ${breakdown}${quote}`;
}
function trimText(unit) {
  const text = unit.blocks.map((b) => (b.text ?? "").trim()).filter(Boolean).join("\n");
  const lines = text.split("\n");
  if (lines.length <= 6) return clip2(text, 240);
  const headN = Math.max(2, Math.ceil(lines.length * 0.15));
  const tailN = Math.max(2, Math.ceil(lines.length * 0.15));
  const keep = /* @__PURE__ */ new Set();
  for (let i = 0; i < headN; i++) keep.add(i);
  for (let i = lines.length - tailN; i < lines.length; i++) keep.add(i);
  const salient = /[\\/][\w.-]+|error|exception|fail|"[^"]+"|'[^']+'/i;
  for (let i = 0; i < lines.length; i++) {
    if (salient.test(lines[i])) keep.add(i);
  }
  const out = [];
  let gapped = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      out.push(lines[i]);
      gapped = false;
    } else if (!gapped) {
      out.push("\u2026");
      gapped = true;
    }
  }
  return clip2(out.join("\n"), 600);
}
function unionSet(a, b) {
  const out = new Set(a ?? []);
  for (const x of b ?? []) out.add(x);
  return out;
}
function firstLine2(s, n) {
  const line = (s.split("\n").find((l) => l.trim()) ?? "").trim();
  return clip2(line, n);
}
function clip2(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "\u2026";
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
    default:
      return String(b.kind);
  }
}

// conductors/thermocline/scorer.ts
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname(fileURLToPath(import.meta.url));
var TAIL_CHAR_CAP = 12e3;
var BLOCK_CHAR_CAP = 3e3;
function resolvePython() {
  if (process.env.ATTN_PROBE_PYTHON) return process.env.ATTN_PROBE_PYTHON;
  const win = join(HERE, "probe", ".venv", "Scripts", "python.exe");
  const nix = join(HERE, "probe", ".venv", "bin", "python");
  for (const p of [win, nix]) {
    if (existsSync(p)) return p;
  }
  return "python3";
}
var PROBE_SCRIPT = process.env.ATTN_PROBE_SCRIPT || join(HERE, "probe", "probe.py");
function capHeadTail(text, cap) {
  if (!text) return "";
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.75);
  return text.slice(0, head) + " \u2026 " + text.slice(text.length - (cap - head));
}
function capTailNewest(text, cap) {
  if (!text) return "";
  return text.length <= cap ? text : text.slice(text.length - cap);
}
function scoreCandidates({
  tailText,
  candidates,
  python = resolvePython(),
  script = PROBE_SCRIPT,
  batch = 24,
  attnImpl = "sdpa",
  timeoutMs = 18e4,
  signal,
  log = () => {
  }
}) {
  return new Promise((resolvePromise, reject) => {
    if (!candidates.length) {
      resolvePromise(/* @__PURE__ */ new Map());
      return;
    }
    if (signal?.aborted) {
      reject(new Error("probe aborted before start"));
      return;
    }
    const payload = {
      tail: capTailNewest(tailText || "", TAIL_CHAR_CAP),
      blocks: candidates.map((c) => ({ id: c.id, text: capHeadTail(c.text || "", BLOCK_CHAR_CAP) }))
    };
    const dir = mkdtempSync(join(tmpdir(), "thermo-probe-"));
    const inPath = join(dir, "in.json");
    const outPath = join(dir, "out.json");
    let proc;
    try {
      writeFileSync(inPath, JSON.stringify(payload), "utf8");
      const args = [script, "--in", inPath, "--out", outPath, "--batch", String(batch), "--attn-impl", attnImpl];
      proc = spawn(python, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
      reject(new Error(`probe setup failed: ${e.message}`));
      return;
    }
    const t0 = Date.now();
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const kill = () => {
      try {
        proc.kill();
      } catch {
      }
    };
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
      fn(arg);
    };
    const timer = setTimeout(() => {
      kill();
      done(reject, new Error(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      kill();
      done(reject, new Error("probe aborted (connection closed)"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    proc.on("error", (err) => done(reject, new Error(`probe spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        done(reject, new Error(`probe exited ${code}: ${stderr.trim().split("\n").slice(-1)[0] || ""}`));
        return;
      }
      let result;
      try {
        result = JSON.parse(readFileSync(outPath, "utf8"));
      } catch (e) {
        done(reject, new Error(`probe output unreadable: ${e.message}`));
        return;
      }
      const scores = /* @__PURE__ */ new Map();
      for (const [id, v] of Object.entries(result.scores || {})) {
        if (typeof v === "number" && Number.isFinite(v)) scores.set(id, v);
      }
      const meta = result.meta || {};
      log(`scored ${scores.size} blocks in ${Date.now() - t0}ms (probe ${meta.wallMs}ms, ${meta.device})`);
      done(resolvePromise, scores);
    });
  });
}
function tailTextFromView(blocks) {
  let text = "";
  for (let i = blocks.length - 1; i >= 0 && text.length < TAIL_CHAR_CAP; i--) {
    const b = blocks[i];
    if (!b.protected) break;
    if (b.text !== void 0) text = b.text + "\n" + text;
  }
  return text;
}

// conductors/thermocline/thermocline.ts
var ID = "thermocline";
var LABEL = "Thermocline";
function persistPath(dir, key) {
  return join2(dir, `thermocline-state-${key}.json`);
}
var ThermoclineConductor = class {
  id = ID;
  label = LABEL;
  description = "Attention-gated LLM compression in deliberate epochs; live tokens stay at or under budget whenever protected/held content leaves room to compress, else the shortfall is surfaced as OVERFLOW \u2014 never silent.";
  // human-steering ONLY — agent-unfold stays open (the agent's unfold is graduation gate ②).
  locks = ["human-steering"];
  // Small hold: the pre-model-call wire-departing hook runs a strictly deterministic emergency.
  holdWireUpToMs = 200;
  cfg;
  scorer;
  persistDir;
  sessionKey;
  host;
  off = null;
  attached = false;
  // ── applied state (the FRONT buffer — what we have committed to the engine) ──
  appliedFolds = /* @__PURE__ */ new Map();
  // id → bare fold body
  appliedStrata = [];
  appliedPlan = null;
  // ── graduation (dwell + everWarm — persisted) ──
  grad = {
    dwell: /* @__PURE__ */ new Map(),
    graduated: /* @__PURE__ */ new Set(),
    everWarm: /* @__PURE__ */ new Set()
  };
  // ── scoring (from the attention probe) ──
  scores = /* @__PURE__ */ new Map();
  scoringInFlight = false;
  rescoreNeeded = true;
  attempted = /* @__PURE__ */ new Set();
  // ── agent/human touch tracking (resets dwell, vetoes graduation) ──
  agentTouched = /* @__PURE__ */ new Set();
  recalledThisEpoch = /* @__PURE__ */ new Set();
  // ── digest cache: key → LLM summary text (survives across epochs) ──
  digestCache = /* @__PURE__ */ new Map();
  // ── PREPARE state ──
  preparing = false;
  prepareToken = 0;
  // ── tick serialization ──
  // Ticks (`blocks-appended` / `turn-committed`) are async — each awaits its proposes (and, on the
  // remote host, those cross a socket). Two closely-spaced events could otherwise interleave two
  // runTick bodies that share appliedFolds/appliedStrata/appliedPlan/preparing. Chain them so a tick
  // never starts until the previous one has fully settled; a rejected tick is swallowed so it never
  // poisons the chain. `null` means idle (no tick in flight or queued) — the next tick then runs its
  // SYNCHRONOUS prefix during dispatch, preserving the pre-serialization timing (e.g. a tick firing
  // PREPARE's `host.complete` before the dispatching event returns). The wire-departing EMERGENCY
  // deliberately does NOT ride this chain (it must ride the departing wire promptly) — see
  // `onWireDeparting`.
  tickChain = null;
  // ── per-tick / bookkeeping ──
  gradAdvanced = false;
  lastView = null;
  restoredPendingValidation = false;
  lastAction = "hold";
  lastFill = 0;
  lastStatusText = "";
  abort = new AbortController();
  // ── IRREDUCIBLE OVERFLOW (P1-4) ── re-derived fresh every epoch from `Plan.irreducible` (never
  // cached across a config change) by `commit()`, the ONE place both the deterministic emergency
  // path and the LLM-prepared path converge. Gates PREPARE in `runTick` so an un-winnable plan
  // doesn't burn a `host.complete` call every event; cleared the instant `commit()` (or a
  // still-under-cap tick) observes the projection fits again. See `setOverflowState`/`sendStatus`.
  irreducibleOverflow = false;
  overflowTokens = 0;
  overflowCapTokens = 0;
  overflowProtectedTokens = 0;
  overflowHeldTokens = 0;
  constructor(opts = {}) {
    this.cfg = { ...DEFAULT_CFG, ...opts.cfg ?? {} };
    this.scorer = opts.scorer ?? scoreCandidates;
    this.persistDir = opts.persistDir ?? join2(process.env.ACCORDION_HOME || homedir(), ".accordion", "conductors");
    this.sessionKey = opts.sessionKey ?? null;
  }
  // ── Conductor lifecycle ─────────────────────────────────────────────────────
  attach(host) {
    this.host = host;
    this.attached = true;
    this.abort = new AbortController();
    this.tickChain = null;
    this.restore();
    this.off = host.on((e) => this.onEvent(e));
  }
  detach() {
    this.attached = false;
    this.off?.();
    this.off = null;
    this.abort.abort();
    ++this.prepareToken;
    this.preparing = false;
  }
  // ── event routing ───────────────────────────────────────────────────────────
  onEvent(e) {
    if (!this.attached) return;
    switch (e.type) {
      case "blocks-appended":
      case "turn-committed":
        return this.enqueueTick();
      case "state-changed":
        return this.onStateChanged(e.changes);
      case "wire-departing":
        return this.onWireDeparting();
      case "resync":
        this.onResync();
        return;
    }
  }
  /**
   * Agent recall/unfold is graduation gate ②; a human edit resets graduation via `held` next tick.
   *
   * P2 FIX — a human raising `setProtect` (a `what:"protect"` change) can HEAL an already-applied
   * fold, or PRUNE an already-applied stratum's group, UNDERNEATH the conductor: Truth's
   * `healProtected`/`pruneProtectedGroups` run synchronously inside `setProtect`, BEFORE this
   * event even fires — and the event itself carries NO block ids (see `StateChange`), so nothing
   * else would ever surface which id(s) healed. Because thermocline locks `human-steering` (the
   * ONLY other channel through which a human could directly fold/unfold/pin a block), a `protect`
   * heal is the ONE remaining way `appliedFolds`/`appliedStrata` can silently drift from reality.
   * React to it the same tick: reconcile our applied-state bookkeeping against the live view (see
   * `reconcileAppliedAgainstView`) and kick a tick so `project()`/fill catches up PROMPTLY, rather
   * than sitting stale until the next natural blocks-appended/turn-committed event.
   */
  onStateChanged(changes) {
    let sawAgentTouch = false;
    let sawProtectChange = false;
    for (const c of changes) {
      if (c.by === "agent" && (c.what === "recall" || c.what === "unfold") && c.id) {
        this.agentTouched.add(c.id);
        this.recalledThisEpoch.add(c.id);
        sawAgentTouch = true;
        if (c.what === "unfold") this.appliedFolds.delete(c.id);
      }
      if (c.what === "protect") sawProtectChange = true;
    }
    if (sawAgentTouch && this.preparing) {
      ++this.prepareToken;
      this.preparing = false;
    }
    if (sawProtectChange && this.reconcileAppliedAgainstView()) {
      return this.enqueueTick();
    }
  }
  /** The host state was rebuilt — drop tracked desired state and re-restore from disk. */
  onResync() {
    this.appliedFolds.clear();
    this.appliedStrata = [];
    this.appliedPlan = null;
    this.grad = { dwell: /* @__PURE__ */ new Map(), graduated: /* @__PURE__ */ new Set(), everWarm: /* @__PURE__ */ new Set() };
    this.scores.clear();
    this.attempted.clear();
    this.digestCache.clear();
    this.agentTouched.clear();
    this.recalledThisEpoch.clear();
    this.restore();
  }
  /** LAST-LINE HARD-CAP guarantee, right before the wire departs to the model. Strictly
   *  deterministic (no LLM, no inline disk I/O); the only `await` is the async-by-contract (v2)
   *  `propose` inside `runEmergency`, whose ops are INVOKED synchronously so the emergency fold
   *  rides this wire — the awaited tail settles on a microtask, inside the declared hold window.
   *
   *  Deliberately does NOT ride the tick chain: the emergency must run the instant the wire departs,
   *  never queued behind a slow in-flight tick. When it DOES overlap an in-flight tick (that tick is
   *  suspended at its own `await host.propose`), the two are backstopped by the engine, not by luck —
   *  every mutation funnels through `applyDesired`, which reconciles `appliedFolds`/`appliedStrata`
   *  from the propose's REAL per-op results (a duplicate/stale op clamps to a no-op, never
   *  double-recorded), and `runEmergency` bumps `prepareToken` + clears `preparing` synchronously so
   *  a concurrent prepare is discarded. Any residual bookkeeping drift self-heals on the next tick's
   *  `holdOrResend`, which re-derives desired-from-plan against the live view. */
  async onWireDeparting() {
    const view = this.materialize();
    this.lastView = view;
    this.reconcileAppliedAgainstView();
    if (project(view, this.appliedForProject()) > capOf(view)) {
      await this.runEmergency(view);
    }
  }
  // ── view + state adapters ─────────────────────────────────────────────────────
  materialize() {
    const stats = this.host.stats();
    return {
      blocks: this.host.blocks().slice(),
      budget: stats.budget,
      contextWindow: stats.contextWindow,
      // RAW baseline, NOT stats.liveTokens. The policy's `project()` re-derives OUR savings from a
      // baseline where none of our folds/strata are applied. In the new engine our folds PERSIST,
      // so stats.liveTokens ALREADY reflects them — feeding that in would double-count our own
      // folding (fill/projection would read far too low). Because we hold `human-steering`, the
      // ONLY foldable overlay is ours, so the raw "none-of-mine-folded" baseline is exactly
      // stats.fullTokens; `project(view, appliedForProject())` then reproduces stats.liveTokens.
      liveTokens: stats.fullTokens,
      protectedFromIndex: stats.protectedFromIndex,
      protectTokens: stats.protectTokens
    };
  }
  gradState() {
    return {
      dwell: this.grad.dwell,
      graduated: this.grad.graduated,
      everWarm: this.grad.everWarm,
      agentTouched: this.agentTouched,
      recalledThisEpoch: this.recalledThisEpoch
    };
  }
  appliedForProject() {
    return {
      foldedIds: new Set(this.appliedFolds.keys()),
      strata: this.appliedStrata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens }))
    };
  }
  /**
   * VIEW-DERIVED RECONCILIATION (P2 fix) — a human raising `setProtect` mid-session can HEAL an
   * already-applied fold (Truth's `healProtected`) or PRUNE an already-applied stratum's group
   * (`pruneProtectedGroups`) UNDERNEATH the conductor: both run synchronously inside `setProtect`,
   * BEFORE the `state-changed{what:"protect"}` event even fires, and that event carries NO block
   * ids — so nothing tells us WHICH id(s) healed. `project()` doesn't re-derive its own savings
   * from live fold state either: for a fold it subtracts `tokens − foldedTokens` for every id in
   * `appliedFolds` unconditionally, and for a stratum it subtracts `Σ member tokens − summaryTokens`
   * for every entry in `appliedStrata` unconditionally — so a STALE entry keeps crediting a saving
   * that no longer exists on the wire, fill under-reports, and the hard-budget invariant is
   * defeated with NO overflow status. Because thermocline locks `human-steering` (a human can't
   * directly fold/unfold/pin while it's held), a `protect` heal is the ONE remaining channel this
   * can happen through.
   *
   * The fix: re-derive both applied sets from the ACTUAL current view/groups rather than trusting
   * our own memory of what we last applied.
   *   - an `appliedFolds` entry whose block no longer renders `folded` (healed, or vanished) is
   *     dropped;
   *   - an `appliedStrata` entry whose engine group id no longer exists is dropped (a restored-but-
   *     not-yet-grouped entry — `groupId == null` — is left alone; there is nothing in the engine
   *     to check yet).
   *
   * Dropping an entry never re-folds it here: the freed block/members simply fall OUT of our
   * bookkeeping and become visible to `project()`/`planEpoch` again through the NORMAL epoch
   * machinery (HOLD/PREPARE/EMERGENCY) on its own schedule, which already refuses to fold/group
   * inside the (now possibly larger) protected tail via the engine's own protected clamp — forcing
   * an immediate re-fold here would just be clamped right back. Cheap (two small-map scans + one
   * `host.groups()` read) and self-contained: no new host event, no disk I/O, safe on every tick.
   *
   * Returns whether anything was actually dropped, so `onStateChanged` can kick a tick ONLY when
   * there was real drift to react to — a `protect` change that heals/prunes nothing (e.g. the
   * routine `setProtect` call during initial setup, before any epoch has ever applied anything) must
   * stay a complete no-op, exactly as before this fix, rather than spuriously firing a tick against
   * an empty/pre-epoch view (which could, for one, trip `validateRestoredStrata` before the first
   * real blocks have even landed).
   */
  reconcileAppliedAgainstView() {
    let changed = false;
    for (const [id] of this.appliedFolds) {
      const b = this.host.get(id);
      if (!b || !b.folded) {
        this.appliedFolds.delete(id);
        changed = true;
      }
    }
    if (this.appliedStrata.length) {
      const liveGroupIds = new Set(this.host.groups().map((g) => g.id));
      const kept = this.appliedStrata.filter((s) => s.groupId == null || liveGroupIds.has(s.groupId));
      if (kept.length !== this.appliedStrata.length) {
        this.appliedStrata = kept;
        changed = true;
      }
    }
    return changed;
  }
  // ── the main steady-state tick ─────────────────────────────────────────────────
  /** Run a tick, serialized: if one is already in flight/queued, chain behind it (deferred — it must
   *  wait); if the chain is idle, START NOW so the tick's synchronous prefix executes during this
   *  dispatch (the pre-serialization timing). Either way the returned promise resolves when THIS tick
   *  has settled, and a rejection is swallowed on the stored chain so one failed tick never poisons
   *  the chain for later ticks. */
  enqueueTick() {
    const start = () => this.attached ? this.runTick() : Promise.resolve();
    const prev = this.tickChain;
    const settled = (prev ? prev.then(start) : start()).catch(() => {
    });
    this.tickChain = settled;
    void settled.then(() => {
      if (this.tickChain === settled) this.tickChain = null;
    });
    return settled;
  }
  async runTick() {
    const view = this.materialize();
    this.lastView = view;
    this.gradAdvanced = false;
    this.validateRestoredStrata(view);
    this.reconcileAppliedAgainstView();
    const cap = capOf(view);
    let fill = cap > 0 ? project(view, this.appliedForProject()) / cap : 0;
    const units = buildUnits(view.blocks);
    for (const u of units) {
      const temp = this.scores.get(u.temperatureKey);
      if (temp !== void 0 && temp >= this.cfg.coldThreshold) this.grad.everWarm.add(u.id);
    }
    this.pruneMaps(view, units);
    if (fill > 1) {
      await this.runEmergency(view);
      fill = cap > 0 ? project(view, this.appliedForProject()) / cap : fill;
    } else {
      this.irreducibleOverflow = false;
      this.overflowTokens = 0;
    }
    this.lastFill = fill;
    if (fill >= this.cfg.warmWater && !this.preparing && !this.irreducibleOverflow && this.needNewEpoch(fill)) {
      this.preparing = true;
      this.advanceGraduationOnce(view);
      const token = ++this.prepareToken;
      void this.prepareEpoch(view, token).catch(() => {
        this.preparing = false;
      });
    }
    await this.holdOrResend(view);
    this.maybeScore(view);
    this.sendStatus();
  }
  /** A new epoch is warranted when there is no plan, OR the projected fill is already ≥ highWater. */
  needNewEpoch(fill) {
    if (!this.appliedPlan) return true;
    if (fill >= this.cfg.highWater) return true;
    return false;
  }
  /** Advance dwell at most ONCE per tick, and only when an epoch actually fires — so the K-epoch
   *  probation is measured in compaction EPOCHS, not raw ticks. */
  advanceGraduationOnce(view) {
    if (this.gradAdvanced) return;
    this.gradAdvanced = true;
    const g = updateGraduation(this.gradState(), view, this.scores, this.cfg);
    this.grad.dwell = g.dwell;
    this.grad.graduated = g.graduated;
  }
  // ── EMERGENCY: deterministic plan, no LLM, immediate ─────────────────────────────
  async runEmergency(view) {
    ++this.prepareToken;
    this.preparing = false;
    this.advanceGraduationOnce(view);
    const plan = planEpoch(view, this.scores, this.gradState(), this.cfg, {
      deterministic: true,
      graduated: this.grad.graduated
    });
    await this.commit(view, plan, void 0);
    this.lastAction = "emergency";
  }
  // ── PREPARE: score + LLM summaries + commit (async, off every hook path) ─────────
  async prepareEpoch(view, token) {
    const plan = planEpoch(view, this.scores, this.gradState(), this.cfg, { graduated: this.grad.graduated });
    const units = buildUnits(view.blocks);
    const byUnit = new Map(units.map((u) => [u.id, u]));
    const jobs = [];
    for (const f of plan.folds) {
      if (f.tier !== "digest") continue;
      if (this.digestCache.has(f.unitId)) continue;
      const u = byUnit.get(f.unitId);
      if (!u) continue;
      const { system, prompt } = buildDigestPrompt(u);
      jobs.push(
        this.host.complete({ system, prompt, maxOutputTokens: 120, signal: this.abort.signal }).then((r) => ({ key: f.unitId, text: r.text })).catch(() => null)
        // rejection → null → emitOps falls back to deterministicDigest
      );
    }
    for (const s of plan.strata) {
      if (s.digestKind !== "summary") continue;
      const key = `stratum:${s.ids[0]}`;
      if (this.digestCache.has(key)) continue;
      const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean);
      if (!stratumUnits.length) continue;
      const { system, prompt } = buildStratumPrompt(stratumUnits);
      jobs.push(
        this.host.complete({ system, prompt, maxOutputTokens: 600, signal: this.abort.signal }).then((r) => ({ key, text: r.text })).catch(() => null)
      );
    }
    const results = await Promise.allSettled(jobs);
    if (this.prepareToken !== token) return;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && r.value.text && r.value.text.trim()) {
        this.digestCache.set(r.value.key, r.value.text);
      }
    }
    const lv = this.lastView ?? view;
    const freshPlan = planEpoch(lv, this.scores, this.gradState(), this.cfg, { graduated: this.grad.graduated });
    if (this.attached) await this.commit(lv, freshPlan, this.digestCache);
    this.preparing = false;
    this.sendStatus();
  }
  // ── COMMIT: reconcile + real tokens + top-up, then propose ONE transaction ─────────
  async commit(view, plan, digests) {
    const touched = unionSet(this.agentTouched, this.recalledThisEpoch);
    let working = reconcilePlan(plan, touched);
    working = planWithRealStratumTokens(working, digests);
    working = this.topUpToCap(working, view, working.cap || capOf(view));
    const finalProjected = project(view, appliedShapeOf(working));
    const finalCap = working.cap || capOf(view);
    working = { ...working, projected: finalProjected };
    this.setOverflowState(working.irreducible === true, finalProjected, finalCap, view);
    const desired = this.desiredFromPlan(working, digests, view);
    await this.applyDesired(desired);
    this.appliedPlan = working;
    this.schedulePersist();
    this.recalledThisEpoch = /* @__PURE__ */ new Set();
    this.agentTouched = /* @__PURE__ */ new Set();
    this.lastAction = "epoch";
    this.rescoreNeeded = true;
    this.sendStatus();
  }
  /** Record (or clear) the irreducible-overflow signal so `sendStatus` can surface it with the exact
   *  numbers and `runTick` can gate PREPARE off an un-winnable plan. Always overwrites — there is no
   *  latching to a stale `true`, so a config change that makes the projection fit again clears it on
   *  the very next `commit()` (see also the `runTick` `fill <= 1.0` reset for the case where a change
   *  drops fill under 1.0 before an emergency/commit even runs). */
  setOverflowState(irreducible, projected, cap, view) {
    this.irreducibleOverflow = irreducible;
    this.overflowTokens = irreducible ? Math.max(0, projected - cap) : 0;
    this.overflowCapTokens = cap;
    if (irreducible) {
      this.overflowProtectedTokens = protectedTailTokens(view);
      this.overflowHeldTokens = heldOutsideTailTokens(view);
    }
  }
  /**
   * BLOCKER 1 — guarantee the agent NEVER receives a batch whose projected live exceeds cap, using
   * the REAL summary token counts. Deterministically merges extra folds/age-strata into the plan
   * (skipping already-claimed units/members), then, if still over, drops our OWN strata oldest-first.
   * Always terminates: the deterministic floor (folds + protected tail) is ≤ cap by planEpoch's
   * hard-cap guarantee. Mutates + returns `plan`.
   */
  topUpToCap(plan, view, cap) {
    const settle = () => {
      plan.irreducible = project(view, appliedShapeOf(plan)) > cap;
      return plan;
    };
    if (project(view, appliedShapeOf(plan)) <= cap) return settle();
    const liveUnits = buildUnits(view.blocks);
    const memberIdsOfUnit = new Map(liveUnits.map((u) => [u.id, u.ids]));
    const claimedUnits = /* @__PURE__ */ new Set([...plan.folds.map((f) => f.unitId), ...plan.strata.flatMap((s) => s.unitIds)]);
    const foldedMembers = /* @__PURE__ */ new Set([...plan.folds.flatMap((f) => f.ids), ...plan.strata.flatMap((s) => s.memberIds)]);
    const MAX_PASSES = 3;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (project(view, appliedShapeOf(plan)) <= cap) return settle();
      const det = planEpoch(view, this.scores, this.gradState(), this.cfg, { deterministic: true, graduated: this.grad.graduated });
      let added = false;
      for (const f of det.folds) {
        if (claimedUnits.has(f.unitId)) continue;
        if (f.ids.some((id) => foldedMembers.has(id))) continue;
        plan.folds.push({ unitId: f.unitId, ids: f.ids, tier: f.tier });
        for (const id of f.ids) foldedMembers.add(id);
        claimedUnits.add(f.unitId);
        added = true;
      }
      for (const s of det.strata) {
        const units = s.unitIds ?? [];
        if (units.some((id) => claimedUnits.has(id))) continue;
        if (s.memberIds.some((id) => foldedMembers.has(id))) continue;
        plan.strata.push({
          ids: s.ids,
          unitIds: units,
          memberIds: s.memberIds,
          digestKind: s.digestKind,
          summaryTokens: s.summaryTokens
        });
        for (const id of units) claimedUnits.add(id);
        for (const id of s.memberIds) foldedMembers.add(id);
        for (const uid of units) for (const mid of memberIdsOfUnit.get(uid) ?? []) foldedMembers.add(mid);
        added = true;
      }
      if (project(view, appliedShapeOf(plan)) <= cap) return settle();
      if (!added) break;
    }
    dropOwnStrataOldestFirst(plan, view, cap);
    return settle();
  }
  /** HOLD — re-derive the desired state from the committed plan against the CURRENT view and
   *  propose only the delta. An unchanged desired state yields an empty transaction (the diff IS
   *  the signature-dedup). Also the seam that first applies a restored deep zone to the engine. */
  async holdOrResend(view) {
    if (!this.appliedPlan) return;
    const desired = this.desiredFromPlan(this.appliedPlan, this.digestCache, view);
    await this.applyDesired(desired);
  }
  // ── desired state + diff ────────────────────────────────────────────────────────
  desiredFromPlan(plan, digests, view) {
    const units = buildUnits(view.blocks);
    const byUnit = new Map(units.map((u) => [u.id, u]));
    const folds = /* @__PURE__ */ new Map();
    for (const f of plan.folds) {
      const u = byUnit.get(f.unitId);
      if (!u) continue;
      const ids = foldableMemberIds(u, f.ids);
      if (!ids.length) continue;
      const body = foldBody(u, f.tier, digests);
      for (const id of ids) folds.set(id, body);
    }
    const strata = plan.strata.map((s) => {
      const drop = s.digestKind === "drop";
      const stratumUnits = s.unitIds.map((id) => byUnit.get(id)).filter(Boolean);
      return {
        firstId: s.ids[0],
        lastId: s.ids[1],
        unitIds: s.unitIds.slice(),
        memberIds: s.memberIds.slice(),
        summary: drop ? null : stratumSummary(stratumUnits, s.ids[0], digests),
        summaryTokens: s.summaryTokens
      };
    });
    return { folds, strata };
  }
  /** Diff `desired` against the applied state and propose ONE transaction (undo removed folds/
   *  strata, then apply new/changed ones). Update the applied state from what actually applied. */
  async applyDesired(desired) {
    const stratumKey = (firstId, lastId) => `${firstId}|${lastId}`;
    const desiredStrataByKey = new Map(desired.strata.map((s) => [stratumKey(s.firstId, s.lastId), s]));
    const desiredStratumMembers = new Set(desired.strata.flatMap((s) => s.memberIds));
    const ops = [];
    for (const old of this.appliedStrata) {
      const want = desiredStrataByKey.get(stratumKey(old.firstId, old.lastId));
      if ((!want || want.summary !== old.summary) && old.groupId) ops.push({ kind: "ungroup", groupId: old.groupId });
    }
    for (const [id] of this.appliedFolds) {
      if (!desired.folds.has(id) || desiredStratumMembers.has(id)) ops.push({ kind: "auto", ids: [id] });
    }
    for (const [id, body] of desired.folds) {
      if (desiredStratumMembers.has(id)) continue;
      if (this.appliedFolds.get(id) !== body) ops.push({ kind: "replace", id, content: body, recoverable: true });
    }
    for (const s of desired.strata) {
      const prior = this.appliedStrata.find((p) => p.firstId === s.firstId && p.lastId === s.lastId);
      if (!prior || prior.summary !== s.summary || prior.groupId == null) {
        ops.push({ kind: "group", ids: [s.firstId, s.lastId], summary: s.summary });
      }
    }
    if (!ops.length) return;
    const baseRev = this.host.stats().rev;
    const res = await this.host.propose({ baseRev, ops });
    const groupsAfter = this.host.groups();
    const repairs = [];
    for (const r of res.results) {
      if (!r.applied) continue;
      const op = r.op;
      if (op.kind === "auto") {
        for (const id of op.ids) this.appliedFolds.delete(id);
      } else if (op.kind === "replace") {
        this.appliedFolds.set(op.id, op.content);
      } else if (op.kind === "ungroup") {
        this.appliedStrata = this.appliedStrata.filter((s) => s.groupId !== op.groupId);
      } else if (op.kind === "group") {
        const d = desiredStrataByKey.get(stratumKey(op.ids[0], op.ids[op.ids.length - 1]));
        if (!d) continue;
        const expectedId = `g:${d.firstId}`;
        const appliedId = r.detail ?? expectedId;
        const applied = groupsAfter.find((g) => g.id === appliedId);
        const membersMatch = applied != null && sameIdSet(applied.memberIds, d.memberIds);
        if (appliedId !== expectedId || !membersMatch) {
          repairs.push({ kind: "ungroup", groupId: appliedId });
          this.appliedStrata = this.appliedStrata.filter((s) => !(s.firstId === d.firstId && s.lastId === d.lastId));
          console.warn(
            `[thermocline] stratum ${expectedId} discarded: applied group ${appliedId} (${applied ? applied.memberIds.length : 0} members) does not match the plan (${d.memberIds.length} members) \u2014 recall tag would not resolve; repairing.`
          );
          continue;
        }
        this.appliedStrata = this.appliedStrata.filter((s) => !(s.firstId === d.firstId && s.lastId === d.lastId));
        this.appliedStrata.push({
          firstId: d.firstId,
          lastId: d.lastId,
          unitIds: d.unitIds,
          memberIds: d.memberIds,
          summary: d.summary,
          summaryTokens: d.summaryTokens,
          groupId: appliedId
        });
      }
    }
    if (repairs.length) await this.host.propose({ baseRev: this.host.stats().rev, ops: repairs });
  }
  // ── background scoring ──────────────────────────────────────────────────────────
  maybeScore(view) {
    const units = buildUnits(view.blocks);
    const cands = units.filter((u) => !u.protected && !u.held && !this.attempted.has(u.temperatureKey));
    const fill = this.lastFill;
    if (fill < this.cfg.warmWater || this.scoringInFlight || !(this.rescoreNeeded || cands.length)) return;
    if (!cands.length) return;
    const tailText = tailTextFromView(view.blocks);
    if (!tailText.trim()) return;
    this.scoringInFlight = true;
    const candidates = cands.map((u) => ({ id: u.temperatureKey, text: u.blocks.map((b) => b.text ?? "").join("\n") }));
    const ids = candidates.map((c) => c.id);
    this.scorer({ tailText, candidates, signal: this.abort.signal }).then((scores) => {
      for (const [id, v] of scores) this.scores.set(id, v);
      this.attempted = new Set(ids);
      this.rescoreNeeded = false;
      this.scoringInFlight = false;
      this.sendStatus();
    }).catch(() => {
      this.scoringInFlight = false;
      this.sendStatus();
    });
  }
  // ── map pruning (bound per-session memory) ──────────────────────────────────────
  pruneMaps(view, units) {
    const liveBlockIds = new Set(view.blocks.map((b) => b.id));
    const liveTempKeys = new Set(units.map((u) => u.temperatureKey));
    const liveUnitIds = new Set(units.map((u) => u.id));
    for (const k of this.scores.keys()) if (!liveTempKeys.has(k)) this.scores.delete(k);
    for (const k of this.attempted) if (!liveTempKeys.has(k)) this.attempted.delete(k);
    for (const k of this.digestCache.keys()) {
      const stale = k.startsWith("stratum:") ? !liveBlockIds.has(k.slice("stratum:".length)) : !liveUnitIds.has(k);
      if (stale) this.digestCache.delete(k);
    }
  }
  // ── restore + validate persisted state ──────────────────────────────────────────
  restore() {
    if (!this.sessionKey) return;
    const saved = this.loadPersisted();
    if (!saved) return;
    const savedStrata = Array.isArray(saved.strata) ? saved.strata.filter((s) => Array.isArray(s.unitIds) && s.unitIds.length > 0) : [];
    if (savedStrata.length) {
      this.appliedStrata = savedStrata.map((s) => ({ ...s, unitIds: s.unitIds.slice(), memberIds: s.memberIds.slice() }));
      for (const s of savedStrata) {
        if (s.summary != null) this.digestCache.set(`stratum:${s.firstId}`, stripTag(s.summary));
      }
      this.appliedPlan = {
        folds: [],
        strata: this.appliedStrata.map((s) => ({
          ids: [s.firstId, s.lastId],
          unitIds: s.unitIds.slice(),
          memberIds: s.memberIds.slice(),
          digestKind: s.summary == null ? "drop" : "summary",
          summaryTokens: s.summaryTokens ?? 0
        })),
        projected: 0,
        cap: 0,
        targetTokens: 0
      };
      for (const s of this.appliedStrata) s.groupId = null;
      this.restoredPendingValidation = true;
    }
    if (Array.isArray(saved.dwell)) this.grad.dwell = new Map(saved.dwell);
    if (Array.isArray(saved.everWarm)) this.grad.everWarm = new Set(saved.everWarm);
  }
  /** On the first real view after a restore, drop any stratum with a member id absent from the view
   *  (an interior member can vanish while boundary ids survive — project() would stay low forever and
   *  the group could swallow drifted-in live blocks). A stratum is safe only if EVERY member is live. */
  validateRestoredStrata(view) {
    if (!this.restoredPendingValidation) return;
    this.restoredPendingValidation = false;
    const liveIds = new Set(view.blocks.map((b) => b.id));
    const valid = this.appliedStrata.filter(
      (s) => liveIds.has(s.firstId) && liveIds.has(s.lastId) && Array.isArray(s.memberIds) && s.memberIds.length > 0 && s.memberIds.every((id) => liveIds.has(id))
    );
    if (valid.length !== this.appliedStrata.length) {
      this.appliedStrata = valid;
      this.appliedPlan = valid.length ? {
        folds: [],
        strata: valid.map((s) => ({
          ids: [s.firstId, s.lastId],
          unitIds: s.unitIds.slice(),
          memberIds: s.memberIds.slice(),
          digestKind: s.summary == null ? "drop" : "summary",
          summaryTokens: s.summaryTokens ?? 0
        })),
        projected: 0,
        cap: 0,
        targetTokens: 0
      } : null;
    }
  }
  loadPersisted() {
    if (!this.sessionKey) return null;
    try {
      return JSON.parse(readFileSync2(persistPath(this.persistDir, this.sessionKey), "utf8"));
    } catch {
      return null;
    }
  }
  /** Defer persistence off EVERY hook path (invariant: no disk I/O on a pre-model-call hook). */
  schedulePersist() {
    if (!this.sessionKey) return;
    queueMicrotask(() => this.persistNow());
  }
  persistNow() {
    if (!this.sessionKey) return;
    try {
      mkdirSync(this.persistDir, { recursive: true });
    } catch {
      return;
    }
    const data = {
      strata: this.appliedStrata.map((s) => ({ ...s })),
      dwell: [...this.grad.dwell.entries()],
      everWarm: [...this.grad.everWarm]
    };
    const p = persistPath(this.persistDir, this.sessionKey);
    const tmp = `${p}.${process.pid}.tmp`;
    try {
      writeFileSync2(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, p);
    } catch {
    }
  }
  // ── status ──────────────────────────────────────────────────────────────────────
  sendStatus() {
    const pct = Math.round((Number.isFinite(this.lastFill) ? this.lastFill : 0) * 100);
    const folded = this.appliedFolds.size;
    const strata = this.appliedStrata.length;
    const scoring = this.scoringInFlight ? " \xB7 scoring\u2026" : "";
    const action = this.irreducibleOverflow ? "OVERFLOW" : this.preparing ? "PREPARE" : this.lastAction === "emergency" ? "EMERGENCY" : "HOLD";
    const text = this.irreducibleOverflow ? this.overflowHeldTokens > 0 ? `over budget and irreducible: protected tail \u2248 ${fmtK(this.overflowProtectedTokens)}k + held content \u2248 ${fmtK(this.overflowHeldTokens)}k > cap ${fmtK(this.overflowCapTokens)}k \u2014 raise the budget, shrink the protected tail, or unpin held content` : `over budget and irreducible: protected tail \u2248 ${fmtK(this.overflowProtectedTokens)}k > cap ${fmtK(this.overflowCapTokens)}k \u2014 raise the budget or shrink the protected tail` : `${action} ${pct}% \xB7 ${folded} folded \xB7 ${strata} strata${scoring}`;
    if (text === this.lastStatusText) return;
    this.lastStatusText = text;
    this.host.setStatus(text, {
      fullness: pct,
      action,
      folded,
      strata,
      scoring: this.scoringInFlight,
      lowWater: Math.round(this.cfg.lowWater * 100),
      highWater: Math.round(this.cfg.highWater * 100),
      irreducibleOverflow: this.irreducibleOverflow,
      overflowTokens: this.overflowTokens,
      overflowHeldTokens: this.overflowHeldTokens
    });
  }
};
function protectedTailTokens(view) {
  const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
  let t = 0;
  for (let i = pfi; i < view.blocks.length; i++) t += view.blocks[i].tokens;
  return t;
}
function heldOutsideTailTokens(view) {
  const pfi = Math.min(view.protectedFromIndex, view.blocks.length);
  let t = 0;
  for (let i = 0; i < pfi; i++) if (view.blocks[i].held) t += view.blocks[i].tokens;
  return t;
}
function fmtK(tokens) {
  return String(Math.round(tokens / 1e3));
}
function stripTag(s) {
  return s.replace(/^\s*\{#[0-9a-z]{6} FOLDED\}\s*/, "");
}
function sameIdSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const id of b) if (!set.has(id)) return false;
  return true;
}
function appliedShapeOf(plan) {
  return {
    foldedIds: new Set(plan.folds.flatMap((f) => f.ids)),
    strata: plan.strata.map((s) => ({ memberIds: s.memberIds, summaryTokens: s.summaryTokens }))
  };
}
function reconcilePlan(plan, touched) {
  if (!touched || touched.size === 0) return plan;
  const folds = plan.folds.filter((f) => !f.ids.some((id) => touched.has(id)));
  const strata = plan.strata.filter((s) => !s.memberIds.some((id) => touched.has(id)));
  if (folds.length === plan.folds.length && strata.length === plan.strata.length) return plan;
  return { ...plan, folds, strata };
}
function planWithRealStratumTokens(plan, digests) {
  const d = digests ?? /* @__PURE__ */ new Map();
  const strata = plan.strata.map((s) => {
    if (s.digestKind === "drop") return s;
    const summary = d.get(`stratum:${s.ids[0]}`);
    if (summary == null) return s;
    return { ...s, summaryTokens: Math.ceil(summary.length / 4) };
  });
  return { ...plan, strata };
}
function dropOwnStrataOldestFirst(plan, view, bound) {
  const orderOf = new Map(view.blocks.map((b) => [b.id, b.order]));
  const sorted = plan.strata.map((s) => ({ s, ord: orderOf.get(s.ids[0]) ?? Infinity })).sort((a, b) => a.ord - b.ord);
  let dropped = false;
  for (const { s } of sorted) {
    if (project(view, appliedShapeOf(plan)) <= bound) break;
    if (s.digestKind !== "drop") {
      s.digestKind = "drop";
      s.summaryTokens = 0;
      dropped = true;
    }
  }
  return dropped;
}
export {
  ThermoclineConductor,
  runRemoteConductor
};
