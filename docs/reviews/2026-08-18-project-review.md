# Accordion project review — 2026-08-18

A full-repo review: core engine, pi extension, conductors, app/UI, docs, packaging, and process.
Five parallel deep audits plus a verification run on Linux. Every finding below was verified
against the current tree (`devmain` — content-identical to `main` at time of review) with
file:line evidence; the two core accounting bugs were confirmed with runnable repros.

## Verdict

The codebase is in genuinely good shape — 827/827 tests pass, `svelte-check` is 0/0, both
smoke suites pass, the committed conductor SDK bundles are byte-identical to fresh rebuilds,
and the hard problems (WS auth, freeze-on-detach, calibration frontier, controller lease)
mostly have explicit, tested solutions. The biggest problems are not in the code you've been
writing — they're at the edges:

1. **The front door is stale.** The published npm package (`0.1.2`, protocol v5, 2026-06-27)
   is 17 protocol versions behind the repo (v22). Every `pi install npm:@a-fig/accordion`
   user gets a pre-conductor-v2, pre-door, pre-system-block product.
2. **There is no CI.** The only workflow is a manual Windows release build. "Keep devmain
   green" is enforced entirely by hand.
3. **Two verified core bugs break the product's own honesty promise** — the UI can report
   blocks as live that never ride the wire.

## What's healthy

- 50 test files / 827 tests, all passing (core + conductors + app through one vitest config).
- `svelte-check`: 0 errors / 0 warnings. Both extension smokes pass on Linux.
- `remote-sdk.mjs` / `triptych-sdk.mjs` committed bundles verified byte-identical to rebuilds.
- Extension security posture is solid: single-use conductor tokens consumed at accept,
  origin/token WS gates, freeze-before-clearLocks on every detach path (incl. crash/timeout),
  spawn locks deferred to socket-accept, registry reap re-reads before unlink.
- Issue #90 (fragmented-run summary duplication) is **fixed** at `5ffc2b2` with a regression
  matrix; #102 (token spikes) is fixed by the calibration frontier (`88d5142`); #106 (system
  block) shipped in v22. All three can be closed.

---

## P0 — the three structural gaps

### 1. Ship the front door (npm publish + release discipline)

`extension/package.json` is `0.1.2`; the last publish (2026-06-27) speaks protocol **v5**
against the repo's **v22**. Concretely: npm users have no conductor v2, no thermocline hold
protocol, no controller/door (ADR 0024), no system block, no calibration. Worse, a stale
extension that binds the door port is treated as "transient" by a modern extension's
`probeDoor` (extension/accordion.ts:1554), which would retry forever and never claim —
mixed-version machines degrade quietly. Issue #100's protocol-skew half is this.

Do: bump + publish now; then make staleness mechanically impossible — a `prepack` assertion
comparing a `package.json` field against `core/protocol.ts`'s `PROTOCOL_VERSION`, and a
policy of publishing on every protocol bump. Hygiene while in there: `package.json` has no
`license` field (npm shows "unlicensed" despite the repo LICENSE), no `repository`/`homepage`.

### 2. Add CI

`.github/workflows/` contains only `release-windows.yml` (manual Windows build). One PR
workflow closes the gap and is cheap (measured on this run: app install 5.8s, tests fast,
bundle rebuild ~11ms):

- `app/`: `npm ci` → `npm run check` → `npm run test`
  (plus a one-time `npm install` in `conductors/ws/triptych/` so its 20 skeleton tests run
  instead of silently skipping — `describe.skipIf` hides them today).
- `extension/`: `npm ci` → `node smoke.mjs` → `node smoke-conductor.mjs`.
- Bundle-drift gate: `node extension/build-remote-sdk.mjs && git diff --exit-code
  conductors/` — nothing enforces the committed-SDK-bundle convention today.

### 3. Fix the wire-vs-accounting honesty bugs (core)

The product's core claim is that the readout cannot diverge from the wire. Two verified
counterexamples:

- **HIGH — cross-group split tool pair** (core/truth.ts:939-963 vs core/wire.ts:432-449).
  `classifyGroup` runs the collapse fixpoint per group; `applyPlan` runs it globally across
  all groups. Two groups that each contain one half of a `tool_call`/`tool_result` pair are
  each individually accepted (each half is a "straggler" locally), but the global fixpoint
  sees a balanced pair and removes both messages. Verified repro: engine reports the pair's
  tokens as live; the wire drops both messages. Provider-safe, but the map lies.
- **MEDIUM — zero-block messages fork the floor** (core/truth.ts:890-931 vs wire.ts:416-417).
  `degradedRunKeys` reconstructs wire shapes from `blockLog` only; messages that emit no
  blocks (e.g. `bashExecution` without summary) still ride the real wire and participate in
  `applyPlan`'s role-validity floor. Verified repro: engine believes a leading-drop recap stub
  rides the wire; the wire emits none. Root-cause fix per the audit: have the extension cache
  real `WireMsgShape[]` into Truth instead of reconstructing from block ids.

Both live at the same seam; extracting `classifyGroup`/`degradedRunKeys`/`buildWireShapes`
into a `core/groupAccounting.ts` with a direct engine==wire parity property test is the
structural fix (see Debt below).

---

## P1 — high-value fixes (each small, each real)

| # | Finding | Where |
|---|---|---|
| 1 | **Thermocline prompt injection**: `buildDigestPrompt`/`buildStratumPrompt` interpolate raw tool output with no `neutralizeClosingTags` and no untrusted-data clause — a fetched page containing `</conversation>` can inject into a summary that lands verbatim in the agent's context. The base class already defends this (`agedSummaryConductor.ts:79-94`); port it. | conductors/ws/thermocline/policy.ts:936-1004 |
| 2 | **Unguarded ingest handlers**: the `context` hook try/catches ingest (counted in `hookErrors`); the same code runs bare in `message_end`/`agent_end` (`agent_end` also derefs `event.messages.length` unguarded). A parse quirk that's a counted passthrough at `context` is an uncaught throw at `message_end`. | extension/accordion.ts:2585-2627 |
| 3 | **`runCompletion` ignores `stopReason`/`errorMessage`**: pi-ai resolves (not rejects) MAX_TOKENS/provider errors; they surface as empty-text "successes" — conductors report "model returned empty output" or silently degrade. This is the real residual of issue #57. | extension/accordion.ts:685-694 |
| 4 | **Issue #100 still true**: `resolveAccordionApp` scans Windows + repo paths only; the documented Linux (`~/.local/share/Accordion/accordion`) and macOS (`/Applications/Accordion.app/...`) candidates don't exist. Reporter has a ready patch on a fork. | extension/accordion.ts:290-335 |
| 5 | **Controller heartbeat TOCTOU**: read→write-rename race can re-install the old holder over a fresh takeover, snapping the new controller to READ-ONLY with no human action. Needs verify-unchanged-before-rename or claimedAt precedence. | extension/accordion.ts:1760-1770 |
| 6 | **Stale `ws.onerror` clobbers new connections**: `onclose` has the `socket === ws` guard, `onerror` doesn't — switching sessions mid-dial paints the new session's state with the old socket's error and nulls `live.port` (which also disables the discovery fallback). One-line fix. | app/src/lib/live/liveClient.svelte.ts:462-467 |
| 7 | **Inspector bypasses the controller lease**: every mutator (fold/unfold/pin/group ops) calls the store directly; on a READ-ONLY mirror the buttons render enabled and send commands the host refuses. Every sibling surface routes through `attemptSteer`; Inspector is the one hole. | app/src/lib/ui/map/Inspector.svelte |
| 8 | **Group ops lack human precedence**: `opUngroup`/`opFoldGroup`/`opUnfoldGroup` have no `by:"auto"` vs human-owned-group clamp (unlike `opUnpin`) — a conductor can delete or re-collapse a human's group, contradicting "held state always wins". | core/truth.ts:1613-1651 |
| 9 | **Conductor switch destroys frozen birth-folds**: `releaseLockedDomains` clears the frozen override *and* the `birthFolded` entry, so `housekeep` heals a giant tool_result the model never saw whole — right as the new conductor attaches to manage budget. | core/truth.ts:1224-1242 |
| 10 | **Live-link errors invisible outside the empty state**: protocol mismatch, refused dial, and WS drop produce zero visible feedback once any store renders; the only cue is a READ-ONLY badge whose tooltip says "Viewing a recording". | app/src/routes/+page.svelte:344, MapHeader.svelte:271 |

## P2 — the conductor track (your stated main frontier)

- **#114 (triptych code discovery) — confirmed fully true, all three claims.**
  `classifyCodeRead` reads only `args.command` (misses `exec_command`'s `cmd`); provenance
  gates run before any content inspection; rejections are cached for the attachment's
  lifetime; `CODE_EXTS` accepts ~30 extensions while the tree-sitter engine loads 4 grammars
  (ts/tsx/js/py) — a `.rs` read classifies as code then silently declines. No diagnostics
  surface any of it. This is the gap between triptych's promise and behavior; the issue's
  acceptance list is the right spec.
- **#109 (thermocline probe degradation) — confirmed fully true.** `maybeScore` swallows
  probe failure; status strings are identical with or without attention scores. Minimum
  viable fix: a probe-health field in `sendStatus` + a visibly distinct status/named
  fallback mode; the fail-closed decision is yours to make.
- **#57 — rescope** to the two residuals: `runCompletion` stopReason masking (P1.3) and
  thermocline's unbounded stratum prompts (`buildStratumPrompt` concatenates full member
  text; `mergeOverCeiling` caps *output*, and merging grows the input).
- **Drift-by-convention metadata**: registry hand-mirrors thermocline/triptych
  locks/holds; triptych copies compaction-naive's instruction strings verbatim with a
  "keep in lockstep" comment. Export shared constants / a plain metadata object both sides
  import.
- **Two skeleton engines** (doorman regex, MIN 1500/0.6 vs triptych tree-sitter, MIN
  700/0.7) share only the classifier — any #114 fix must remember both consumers; worth
  unifying deliberately.
- **Test gaps**: triptych is thinnest (8 tests, no spawn e2e — `smoke-conductor.mjs` only
  spawns thermocline); no test pins #109's status behavior; no `cmd`-field classifier case;
  no `stopReason:"error"` completion test; the completion relay
  (`completeRequest`/`completeResult`/`cancelComplete`) is never exercised end-to-end.
- Stale comments that will mislead the next editor: `compaction-naive.ts:155-158` and
  `handoff.ts:88-91` still say no host applies declared locks ("Phase C, not yet built") —
  `liveHost` applies them eagerly today; `remote.ts` banners still say v13/v14 against v22.

## P3 — structure and debt

- **Split `extension/accordion.ts` (2,903 lines, one closure).** Lowest-risk order:
  `launch.ts` (where the #100 fix lands) and `staticServe.ts` (stateless), then
  `doorSecret.ts` + `controllerLease.ts` (own file + timers each), then the high-value one —
  `ingest.ts` (`TruthIngest` over `{truth, lastMessages, lastFps}`), the most
  correctness-critical code currently only testable through the whole extension. Keep
  `accordion.ts` as composition root; copy `LiveConductorHost`'s DI pattern.
- **Split `core/truth.ts` (1,739 lines).** Extract the group/wire accounting seam
  (~200 lines, where both P0.3 bugs live) into `core/groupAccounting.ts` with parity
  property tests; extract `rebuildFrom`; dedupe the op-handler guard preamble (the
  "clear strategy fold" body appears three times verbatim — a shared helper would have made
  the P1.8 asymmetry visible).
- Sync static serving with the codebase's own async rationale (`statSync`/`readFileSync`
  serve multi-MB chunks on the loop the `context` hook shares —
  extension/accordion.ts:1029,1185,1201).
- Transcript view renders every block's full text unvirtualized — the 982-block sample
  lays out hundreds of KB of pre-wrap text on view switch (ContextMap.svelte:1209-1259).
- Missing tests elsewhere: `core/agentView.ts` has **no test file** (fold-code hash
  collision path untested); `digest.ts`/`tokens.ts` untested directly (fold-code format is
  a cross-session contract); zero component-level tests (ContextMap interaction machinery,
  MapHeader drag, Inspector — exactly where P1.7 lives); `applyWireEvent` locks replay
  untested; no Rust tests.
- Low-severity extension items worth a line each: timing-unsafe secret compares
  (`crypto.timingSafeEqual` is cheap), door secret printed to terminal scrollback (already
  a named follow-up), `probeDoor` retries a hanging foreign occupant forever, late spawn
  failure after the 150ms timer reports "Launching…".

## Token accuracy (#11) — a realistic path

Calibration (ADR 0025) is good at the aggregate level and #102 is genuinely fixed. Residual
inaccuracy, in impact order: (1) k is a single scalar — the protect boundary is sized with
the global mix even when the tail's content differs; (2) uncovered blocks are raw — a
just-landed giant tool_result (doorman's exact target) is always past the frontier;
(3) receipts snap k with no smoothing — readouts jump between turns; (4) tool-schema
overhead is smeared into k (the honest model is affine: `real = base + k·est`);
(5) rebuilds reset to cold. "100%" needs a real per-model tokenizer — `estTokens` is
already the one-line swap point; calibration then retires to the overhead term.

## Docs, issues, and process hygiene

- **Close**: #90 (fixed at `5ffc2b2`, tests prove it), #106 (shipped in v22), #102
  (calibration frontier landed). **Rescope**: #57 (two residuals above). **Confirmed
  valid**: #100, #109, #114.
- README: "Four ship today" — there are five (triptych missing); the conductor count and
  the what-works list lag the tree. The SlopCodeBench table is honestly caveated; a
  repeatable eval harness is the single best thing for the "proof" section (and for
  choosing among conductors — #17).
- Two ADRs share number 0024 (`0024-bear2-hybrid-conductor.md`,
  `0024-single-controller-and-stable-door.md`).
- The release workflow builds Windows only, while README Path A documents macOS/Linux
  paths that the extension doesn't scan (#100) — the platform story should be made true
  end-to-end or explicitly narrowed.

## Product observations (opinionated, yours to overrule)

1. **#83 (activity log / audit trail) is the highest-leverage open feature.** The product's
   trust story is "you can always see it" — but conductor moves inside a 150ms hold, agent
   unfolds, and freeze-on-detach are precisely the moves nobody can watch live. The
   architecture already funnels every mutation through `Truth.apply` with actor provenance
   and rev-stamped events; the log is a derivation, not new machinery. It also unlocks
   "show me what the doorman did" as a demo, and undo-with-context later.
2. **Headless mode (#101) is adjacent to the npm/door work** — a default-conductor config
   plus the stable door URL covers most of it; the reporter's protocol-mismatch pain is
   the P0.1 staleness problem wearing a different hat.
3. **The vision gap is mostly in the "folding the folds" and replay sections** — nested
   groups and the timeline scrub are the two VISION.md promises with no code behind them.
   Neither blocks the current value; replay would fall out of the event log (#83) almost
   for free.
4. **Issue #116 (foldable tool_call/result pairs) deserves its design spike** — P0.3 shows
   the pair machinery is already the subtlest seam in the engine; designing pair-aware
   folding properly would both unlock the feature and force the accounting model to get
   simpler.

## A suggested 30-day sequence

1. **Week 1 — ship + gate**: publish npm (with version/protocol assertion), add the CI
   workflow, close/rescope the stale issues, fix #100's path scan (patch exists), fix
   `ws.onerror`, guard `message_end`/`agent_end`.
2. **Week 2 — honesty**: extract `groupAccounting.ts`, fix the split-pair and zero-block
   divergences with parity property tests; fix group-op human precedence; thermocline
   injection hardening; `runCompletion` stopReason handling.
3. **Weeks 3–4 — the frontier**: #114 (content-aware code discovery + `cmd` fix + language
   alignment + diagnostics), #109 (probe-health status), triptych spawn e2e, then start
   #83 (event-log-derived audit trail).
