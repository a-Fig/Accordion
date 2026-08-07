# doorman

The birth-fold demonstration conductor. Doorman stands at the door: it intercepts **giant
fresh** `tool_result` blocks on their way *out* to the model, before they ever ride the wire.
Code files get skeletonized in place (signatures kept, bodies elided); other giant dumps get
folded to the engine's own digest. Everything it does is reversible by the agent
(`unfold`/`recall`) and overridable by the human. It exists so the owner can watch
[ADR 0018's birth-fold exemption](../../../docs/adr/0018-conductor-birth-fold.md) actually fire.

Wired into `core/conductor/registry.ts`'s shipped catalog (`ENTRIES`) — `LiveConductorHost`
(`core/conductor/liveHost.ts`) can attach it to a live session like any other in-process
conductor. It declares no locks, so attaching it is fully collaborative — no consent gate.

## Files

- `doorman.ts` — the conductor itself (`DoormanConductor`, id `"doorman"`). Raw evented
  (`Conductor`, not `ViewConductor`): birth-fold is a wire-departing-time decision, so it
  subscribes directly to the `wire-departing` `HostEvent` and declares `holdWireUpToMs: 150`.
- `skeletonize.ts` — ported **verbatim** (only the banner comment changed) from the deleted
  `conductors/code-skeleton/skeletonize.ts` (ADR 0016, git rev `dc037bc`). Deterministic,
  dependency-free structural compression: brace-language mask-based elision for ts/js/rust/
  go/java/c, indentation-based elision for Python, plus svelte/css/json/generic fallbacks.
- `classify.ts` — ported **verbatim** (only the banner comment and the `ViewBlock` import
  path changed) from the deleted `conductors/code-skeleton/classify.ts` (same rev). The
  reject-biased classifier: a block must clear every gate (kind/error, tool-family, path
  extension, cleaned content shape) to be accepted as a code-file read.
- `doorman.test.ts` / `skeletonize.test.ts` / `classify.test.ts` — tests (see below).

## What doorman decides, on every `wire-departing`

1. **Candidates**: fresh `tool_result` blocks (`payload.freshIds`) that are not `isError`, not
   `held` (no pin / prior manual fold-unfold), not inside a folded group, and `tokens >= 1500`
   (`MIN_SKELETON_TOKENS`, ported from the code-skeleton reference). Freshness — `!sent`, i.e.
   the block has never crossed the wire whole — is the ONLY age gate. Doorman acts **regardless
   of turn**: in a real live loop the `wire-departing` hold fires at the *continuation hook*,
   where a just-arrived giant `tool_result` is always still in the current (newest) turn AND
   still unsent. That continuation hook **is** the birth-fold moment; a "leave the newest turn
   alone" guard would mean doorman never fires in a live session at all (the block is marked
   sent the instant the wire departs, so it is never both old-enough and still-fresh). Doorman
   therefore intercepts on first appearance, before the sent cursor advances.
2. **Classify**: `classifyCodeRead(block, callById)` (verbatim) decides code vs. not-code.
   - **Code AND worth it** → `skeletonize(source, lang)` (verbatim). "Worth it" is ported
     exactly from the reference: the skeleton must actually elide something
     (`elidedLines > 0`), cost no more than 60% of the full block's tokens
     (`MAX_SKELETON_RATIO`), and genuinely save tokens. Emits
     `{ kind: "replace", id, content: header + skeleton, recoverable: true }` — `recoverable`
     is always set explicitly.
   - **Code but NOT worth it** (e.g. an all-signatures file with nothing to elide) → **left
     alone entirely** this pass. Doorman has no budget-driven fallback pass (unlike the old
     code-skeleton conductor's 3-pass budget loop) — it is a birth-fold demo, not a full
     context-management strategy.
   - **Not code** (grep dumps, JSON blobs, directory listings, …) → `{ kind: "fold", ids: [id] }`
     with no custom digest. The engine's own per-kind digest applies — still tagged
     (`{#code FOLDED}`), still recallable/unfoldable, exactly like a human fold.
3. **One transaction**: every decision for this pass is proposed together
   (`await host.propose({ baseRev: <rev at pass start>, ops })`), and clamps are treated as final —
   no retry loop inside the hold. Every decision here is synchronous CPU and the ops are *invoked*
   synchronously (so the fold lands before the sent cursor advances); the handler is `async` only
   to `await` the async-by-contract propose result for its `handled`/status bookkeeping, which
   settles on a microtask, far inside the hold window.
4. **`setStatus`**: a concise summary + metrics, e.g. `"skeletonized 1 (−12.4k), folded 2
   (−9.1k)"`. Silent (no call) when nothing was acted on this pass.
5. **Never nags**: doorman tracks every id it has successfully replaced/folded in an in-memory
   `handled` set and never re-considers it, even if the host later reports it as fresh again.
   This is belt-and-braces alongside `Truth`'s own clamp — once a block carries a non-null
   `override` (a human pin, or an agent/human unfold), `canFold` refuses every future strategy
   attempt on it regardless — but doorman's own bookkeeping means it does not even *try* and
   get clamped.

## Why this proves birth-fold, not an ordinary fold

A freshly-appended giant `tool_result` is, by construction, inside the protected working tail
the instant it arrives (the tail always includes at least the newest block). Every
non-`tail-size`-holding conductor is refused by the ordinary "protected" clamp on such a
block — **except** a block that has never yet been sent whole, which is exactly what
`Truth.canFold`'s `by:"auto"` branch exempts (`if (this.isProtected(b)) return
!this.sent(b);`). Doorman's candidates are drawn straight from `HostEvent`'s `freshIds`
(`wire-departing`'s definition of "never sent"), so every fold/replace it proposes is, by
construction, exercising that exemption. `doorman.test.ts`'s first two cases assert the target
block is `protected` both before and after the fold to make this observable, and — because the
protected-tail walk-back deliberately keeps using each block's *full* token count regardless of
folding (ADR 0018's documented invariant) — a birth-folded block also does not get healed back
open the moment the tail's boundary math re-runs.

## What an observer sees in the UI (for the demo)

With doorman attached and a giant fresh code-file read or grep dump arriving one turn back:
the tile for that block **recesses** (folded — dim + faint hatch, "live = solid / folded =
recessed" per the visual grammar) on the very next `context` hook call, without ever having
rendered live at full size first. In **Transcript** view the block's card shows the exact
`{#code FOLDED}`-tagged digest text the agent receives — for a skeletonized file that is the
`⟨code skeleton · <path> · <N>L → <M>L · <K> elided · call unfold for full source⟩` header
followed by the kept signatures; for a non-code dump it is the engine's ordinary one-line
digest. A double-click (manual fold/unfold) or the agent's own `unfold`/`recall` tool restores
the original in place, same as any other fold — doorman never creates a visual state the
steering path couldn't also produce.

## Tests

- `doorman.test.ts` — driven through `TestHost` on the REAL live sequence (append
  user+tool_call+tool_result in the current turn → `departWire()` in that same turn): skeletonize
  a big fresh current-turn Python read while it is provably still `protected` (birth-fold proof);
  fold a non-code current-turn dump the same way; "leaves untouched" gates (too small / error /
  held); the agent-unfold-then-never-refold guarantee (both an integration test through
  `TestHost` and a surgical test against a hand-rolled `ConductorHost` that pins down doorman's
  own `handled`-set bookkeeping specifically); a bulk/history session (nothing ever fresh, so
  doorman never touches it); and a worth-it rejection (an all-signatures file left alone).
- `skeletonize.test.ts` / `classify.test.ts` — a pinning subset (not the full matrix) of the
  deleted `app/src/lib/engine/{skeletonize,classify}.test.ts` at `dc037bc`: a TS file and a
  Python file each keep their interface while eliding bodies and skeletonize deterministically;
  the classifier accepts both and rejects a data-extension (JSON) read and a grep dump.
