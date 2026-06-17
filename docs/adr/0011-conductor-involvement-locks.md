# ADR 0011 — Conductor involvement locks: from "the human always wins" to "the human can always leave"

**Status:** accepted (product-level alignment session)
**Date:** 2026-06-17
**Amends a founding invariant — read this first:** ADR 0007's **"Human GUI overrides
always win"** and VISION's **"This protection is absolute"** both become **conditional**
on a conductor's declared lock-set. This is a deliberate fork in what Accordion *is*, not
a tweak; the product docs (VISION.md, README.md, CLAUDE.md) are rewritten to own it.
**Builds on:** [ADR 0007](0007-conductor-protocol.md) (the conductor contract —
`conduct → Command[]`, clamp reports, the override rule this ADR makes conditional),
[ADR 0008](0008-conductor-first-party-one-view.md) (first-party conductors; one public
view), [ADR 0005](0005-agent-unfold.md) (the agent `unfold` tool + `{#code FOLDED}` tags —
`recall` sits beside it), [ADR 0006](0006-multiblock-folds.md) (groups).

## Context

A conductor is a context-management strategy ([ADR 0007](0007-conductor-protocol.md)). Today
every conductor is **collaborative** by force: a human can yank a pin, hand-fold, or
hand-unfold at any moment, and the live agent can `unfold` whatever it wants — and all of
that overrides the conductor mid-run. "Human overrides always win" was the founding trust
anchor: automation is safe *because* you can always reach in and overrule it surgically.

That anchor makes conductors hard to author and hard to test. A strategy that has reasoned
its way to a particular folded state cannot rely on that state surviving to the next turn —
a stray human pin or an agent self-unfold can fight it, and the author has no deterministic
world to reason about. The owner wants conductors to be able to **declare that they take
uncontested control** of specific controls, so their authors get determinism, and so users
can *choose* between a **co-pilot** conductor they steer alongside and an **autopilot**
conductor they hand the keys to.

That is the change here: a conductor may **declare** that it locks certain context controls;
the user **approves** the lockout when attaching it; and the human's remaining recourse
becomes the **kill switch (detach)** — not surgical override. **Trust moves from *override*
to *revocability*.** Some conductors are collaborative (you can reach in); some are exclusive
(you hand over the keys, and can always take them back by leaving).

This ships in the final product. It is a per-conductor property the developer sets and that
**users shop on** when choosing who manages their context. It is **not** a dev/test flag.

## Decision

### 1. Two postures: collaborative (default) and exclusive (opt-in)

A conductor is **collaborative** if it locks nothing — today's behavior, and the default.
A conductor is **exclusive** to the extent it declares a non-empty **lock-set**. This is a
per-conductor, user-selectable, first-class product property. Nothing in a user's world
changes until they pick a locking conductor and approve the handover (see §6).

### 2. The lock vocabulary — a free lock-list over three steering controls

Only **steering** — actions that change the agent's context — can be locked. A conductor
declares any **subset** of three named locks (a free lock-list, fully exclusive = all three):

| Lock | What it claims | Who normally holds it |
|---|---|---|
| `human-steering` | hand fold / unfold / pin / unpin / group / reset | the human |
| `agent-unfold` | the agent's `unfold` tool (forcing a block standing-open) | the agent |
| `tail-size` | the protected-tail dial (`setProtect`) **and** the tail's no-fold floor (see §7) | the human (size) + the host (floor) |

**The sacred tier — never lockable, in any way, by any conductor:**

- **Observation** — peek, the live map, the activity log, the budget readout. *You can
  always see; you just can't always touch.* (§3)
- **Budget** — the budget dial (`setBudget`) stays the human's, always. (§3)
- **The agent's `recall`** — an unblockable read of folded content. (§4)
- **Detach** — the kill switch, host-enforced, needs zero conductor cooperation. (§6)

**Guiding principle:** *tail-size is a conductor-domain dial (lockable); budget is a
user-domain dial (sacred).* The tail is a strategy's working assumption about what must
stay verbatim; the budget is the user's statement of how big the window is allowed to get.

### 3. Observation is sacred — never lockable

Even under a **fully exclusive** conductor the user still peeks at any folded block, watches
the live map update, reads the activity log (every fold / unfold / group, attributed), and
reads the budget. No lock touches any of this. Locking is about *touching*, never *seeing*.
Visibility is what keeps handing the keys to an autopilot honest: you can watch it the whole
time, and the moment you don't like what you see, you detach (§6).

**Budget is never lockable, ever.** We considered a weaker "budget is fixed once set" variant
and dropped it: pi can switch models and move the real context window regardless, so a frozen
budget buys a conductor no determinism it can rely on. Budget stays in the sacred tier with
observation.

### 4. The agent is a separate lock axis — plus a new `recall` tool

The agent is **not** folded into the human's lock. `human-steering` and `agent-unfold` are
**separate axes**: a conductor can lock the human and leave the agent free, or the reverse,
or both. And we add a new agent tool that makes locking the agent **on-mission rather than
blinding**:

**`recall` — an unblockable read of folded content.**

- `recall({codes})` returns a folded block's full content **as a tool result** — exactly
  like `read_file`. It does **not** mutate the standing view: no override is created, the
  block stays folded in context. The conductor then manages that tool-result block like any
  other (it can fold it again when it goes cold).
- `recall` is **never lockable**. It is the agent's counterpart to the human's **peek**.
- Unlike `unfold` (whose content returns *next* turn as a state change), `recall` returns
  content **in the same turn** — it is an ordinary tool call with an ordinary tool result.

**The distinction that makes one lockable and the other not:**

- `unfold` **overrides the conductor's decision on an existing block** (forces it
  standing-open, sticky) → interference → **lockable** (`agent-unfold`).
- `recall` **creates a new block via a normal tool call** (the tool result) → no override →
  **unblockable**.

**Payoff:** with `recall` unblockable, locking `agent-unfold` can never actually make the
agent *lose access* to its history — it only stops the agent from *forcing* a block to stand
open against the strategy. **"No silent forgetting" survives maximum lockdown.** An autopilot
conductor can take total control of the standing view and the agent can still always reach
back and read anything it needs.

**Symmetry the docs lean on:** **Peek : Human :: Recall : Agent** — both are unblockable
"look at folded content without changing the standing view." And **unfold : human-steering**
— both are "change the standing view," both lockable.

**Keep BOTH `recall` and `unfold` for now.** `recall` may eventually replace `unfold` for
agents; treat `unfold` as potentially transitional. Both ship this cut. (Settled; not reopened.)

### 5. Declaration shape and how the user sees it

The `Conductor` interface gains a **lock declaration** — a list naming the subset it claims;
additive, defaulting to **locks-nothing**. For an out-of-process conductor the declaration
travels in the `conductor/hello` handshake, which bumps `CONDUCTOR_PROTOCOL_VERSION` 2 → 3.

The lock-set is surfaced to the user as a **short checks-and-x's table** (which controls this
conductor takes over). The exact presentation can change later; the data is the lock-list.

### 6. Consent and transitions

- **Attaching an exclusive conductor** → an **explicit one-time confirm** showing the lock
  table — *"this conductor will take over: human steering ✗, agent unfold ✗, tail size ✗ —
  continue?"* Attaching a **collaborative** conductor needs no gate; it changes nothing in
  the user's world.
- **On consent**, existing human holds in a now-locked domain are **released to the
  conductor's baseline** — the human has handed over the keys, so the conductor authors from
  a clean baseline (the same way `conduct()` already works).
- **Detach (the kill switch)** → **inherit the conductor's tail, freeze the current folded
  view in place, and unlock all controls.** It is **not** reset-to-raw: dumping every block
  back to full content could blow the budget the instant you leave. Concretely:
  1. **Tail inheritance.** If the conductor held `tail-size`, the host reads the conductor's
     declared `tailTokens` (see §7) and writes that value into `protectTokens` before nulling
     the conductor. Because `protectedFromIndex` uses the same walk-back algorithm for the
     locked and the unlocked path, the protected-tail boundary is **identical before and after
     detach** — no block newly enters the protected tail, `healProtected` never fires on the
     post-detach refold, and the budget is not re-blown. The human's prior `protectTokens`
     is overwritten; a subsequently attached collaborative conductor (e.g. the built-in) runs
     with the inherited value until the human re-drags the slider. If the conductor did not
     hold `tail-size`, `protectTokens` is left untouched.
  2. **Fold freeze.** Each block the conductor was folding individually (not in a group) is
     converted to a sticky human-owned fold (`override:"folded"`, `by:"you"`, `subst`
     cleared) — individually reversible, folds to the engine digest. Members of a
     conductor-owned folded group are NOT individually stamped (that would put illegal
     `override:"folded"` on non-foldable kinds like `user` / `tool_call`); instead the
     group itself is reassigned to `by:"you"` so the subsequent conductor-less refold keeps
     it. The on-screen view therefore persists, now human-owned.
  3. **From then on, the normal heal-and-prune invariant governs.** If the HUMAN later grows
     the protected tail over a detach-frozen fold or group (e.g. via the slider),
     `healProtected` / `pruneProtectedGroups` handle it as ordinary human overrides —
     "position one." Re-folding or re-grouping protected blocks after tail growth is refused
     by the standard tail guard in `fold()` / `createGroup()`.
  - Every control returns to the human. Detach is **host-enforced and unconditional** — no
    lock can touch it and no conductor can refuse it.
- **Switching conductor → conductor** → the new conductor **authors from baseline** (already
  how `conduct()` works); its own lock-set and the §6 consent gate apply.

### 7. Approved = full control; the conductor declares its own tail

If a conductor declares the `tail-size` lock and the user approves, it gets **full control of
the tail — including driving it to zero.** Concretely the lock does three things:

1. The human can no longer **resize** the tail (`setProtect` is locked).
2. The host **stops treating the protected tail as an absolute no-fold floor.** The conductor
   may fold any block, recent reasoning included.
3. The conductor may declare how much tail **it** wants via the optional `tailTokens` property
   on the `Conductor` interface. `tailTokens = 0` (or omitted, the default) = "own the whole
   context, no protected tail" — every block arrives with `protected: false`, identical to the
   previous behaviour under the lock. `tailTokens = N > 0` = "protect the newest ~N tokens of
   tail" — the host's walk-back algorithm (same 25% overflow cap as the human's tail) marks
   the newest blocks summing to N tokens as `protected: true`; the conductor sees them in the
   `ConductorView` and the `substOne` guard refuses folding them. This lets a conductor
   declare "I want full control over everything **except** the last 8 k tokens" — e.g.
   `tailTokens = 8000`. Remote conductors (WebSocket) always read `tailTokens = 0`; remote-wire
   tailTokens support is a scoped follow-up (not in this PR).

**Absent the `tail-size` lock, the protected tail stays host-absolute exactly as today** —
the auto-folder, manual folds, and groups all stop before it, and a fold the tail grows over
heals back to live. So the tail's absoluteness is now a property of the *collaborative*
default, not of the host unconditionally. (This is also where ADR 0007's intent finally
lands: 0007 framed the tail as conductor *policy*, not a host floor, but the engine never
implemented that — today `substOne` rejects any fold of a protected block for **every**
conductor, emitting a `protected` clamp. That absolute enforcement is exactly what the
`tail-size` lock makes conditional.)

The host keeps **no hard floor** on the tail (the owner overruled a proposed two-layer
host-floor; not reopened). The host's **only** remaining unconditional floor is
**provider-validity** — the outgoing message must stay sendable. The only things **never**
lockable are the four sacred items (§2): **observation**, **budget**, the agent's **`recall`**,
and **detach**.

**Live-wire position backstop — removed (this change).** Earlier drafts kept an independent
`PROTECT_RECENT_MSGS = 2` constant on the live-WS path (`app/src/lib/live/mapping.ts`):
`applyPlan` refused to fold the newest ~2 messages regardless of the plan, as a coarse
defence-in-depth guard. The `tail-size` lock turned that into a real **view↔wire divergence**:
a `tailTokens = 0` conductor (e.g. the shipped Autopilot) folds recent content in the engine
and `computeFoldOps`/`computeGroupOps` emit those ops, but the position backstop silently kept
the newest two messages whole on the wire — so the GUI counted a saving the agent never
received. That is "a stricter rule on the wire than in the view", which this repo forbids, and
the `foldAlarm` could not catch it (the discard happened downstream of the emitted plan). The
backstop was therefore **removed**: the engine is the single foldability gate (it never folds a
`protected` block, so its plan already excludes protected content), and `applyPlan`'s
durable-id + kind + balanced-tool-pair **structural** guards remain the safety floor.
**Provider-validity is now the only unconditional floor on both the engine and the live wire.**
A conductor that wants to spare the newest turn declares `tailTokens > 0` — the floor belongs
in the conductor's tail policy, not a position hack on the wire the GUI cannot see or audit.

### 8. Host enforcement — the load-bearing change

**"Human overrides always win" becomes "human overrides win for every control the conductor
did NOT lock."** Concretely:

- `ClampReason: "human-override"` fires **only in unlocked domains.** Under the
  `human-steering` lock there are no human overrides to win — the UI refuses the action and
  the engine refuses it, so none are ever created.
- `ClampReason: "protected"` fires for blocks inside the **currently active** protected tail.
  Without `tail-size`, that tail is the human's `protectTokens`. With `tail-size`, that tail is
  the conductor's declared `tailTokens`. So a `tail-size` conductor with `tailTokens = 0` has no
  protected tail and may fold recent blocks; a conductor with `tailTokens > 0` **still** gets
  `protected` clamps inside its own declared tail. The lock transfers ownership of the tail floor
  to the conductor; it does not remove the floor except when the conductor chooses `tailTokens = 0`.
- The **foldability gate stays in ONE place** (the engine) and remains the single predicate
  shared by `fold()` / `isFolded` / `computeFoldOps`. It simply gains the active conductor's
  lock-set as an input. There is **never a stricter rule on the wire than in the view, and
  never a looser one in preview** — preview/read-only obeys the lock-set exactly as the
  steering path does (the [CLAUDE.md](../../CLAUDE.md) preview rule is unchanged; locks are
  just one more rule it inherits).
- `host/event: humanOverride` (and the in-process `onHumanOverride` callback) simply does not
  fire for an action the human is locked out of — there is no override to report.
- The **kill switch (detach)** is the one capability no lock can touch and no conductor can
  refuse.

### 9. Additivity — nothing changes until you opt in

The default is **collaborative**. Every conductor that ships in `conductors/` today — the
built-in, `cold-score`, `cold-epoch`, `sliding-window`, `attention-folder`, and
`recency-folder` — declares **no locks** and keeps today's behavior. The
built-in's `conduct()` is **byte-identical**, so the golden test
(`conductor.builtin.test.ts`) is **untouched**. That untouched golden is the proof this ships
**additively**: a user who never picks a locking conductor never sees a single behavioral
change.

## The capability picture

The collaborative (default) capability picture — VISION's "Who controls it" matrix plus the
new `recall` row (as in VISION, agent `pin` is a north-star entry, not yet built):

| Action | You | The agent | The Conductor |
|---|:---:|:---:|:---:|
| Fold | ✅ | — | ✅ |
| Unfold | ✅ | ✅ | ✅ |
| Pin | ✅ | ✅ | — |
| Peek | ✅ | — | — |
| Recall | — | ✅ | — |

What an **exclusive** conductor can and cannot lock:

| Control | Collaborative | Exclusive |
|---|:---:|:---:|
| Your steering (fold / unfold / pin) | yours | **can be locked** |
| The agent's `unfold` | agent's | **can be locked** |
| The tail size + tail floor | yours / host | **can be locked** |
| Peek · live map · activity log | always yours | always yours |
| The agent's `recall` | always the agent's | always the agent's |
| The budget | always yours | always yours |
| Detach (the kill switch) | always yours | always yours |

## Implementation scope (shipped in PR #46)

This ADR was the **spec**; the implementation shipped in PR #46. Delivered scope:

- **`Conductor` interface** — add the lock declaration (names the claimed subset). Additive;
  defaults to locks-nothing. Lives in `conductors/contract/conductor.ts`.
- **Wire protocol** — bump `CONDUCTOR_PROTOCOL_VERSION` to 3; the lock declaration rides the
  `conductor/hello` handshake (`conductors/contract/protocol.ts`).
- **Host enforcement** (the load-bearing change, §8) — make `"human-override"` and
  `"protected"` clamps conditional on the lock-set; make the protected tail a conductor-policy
  concern under the `tail-size` lock; gate the human's manual actions on `human-steering`;
  gate `setProtect` on `tail-size`. All in `app/src/lib/engine/store.svelte.ts` (+ the wire
  mirror in `mapping.ts`/`plan.ts`). The `ConductorView` read surface needs little/no change —
  conductors already see `held` / `protected` / `grouped` / `protectedFromIndex`; the change
  is in how the host *responds*, not what the conductor is *shown*. Three precisions the build
  must honor: (a) `human-steering` gates **every** human entry point —
  `fold`/`unfold`/`pin`/`unpin`/`auto`/`createGroup`/`deleteGroup`/`foldGroup`/`unfoldGroup`/`resetAll`
  — not just fold/unfold/pin, or the lock leaks; (b) the protection/foldability check is today
  **duplicated** across `substOne`, `fold()`, `createGroup`, and `plan.ts`, so threading the
  lock-set means updating each (or unifying them first — the "one place" in §8 is the target
  state, not today's code); (c) gate strictly on the conductor's **actively declared** lock-set,
  so with no lock declared every path stays byte-for-byte today's — **including** the
  `protected`/`human-override` clamp emission the golden test pins (this is what keeps it additive).
- **Command vocabulary** (`fold/replace/group/restore/pin`) — **unchanged.**
- **`recall` agent tool** — register beside `unfold` in `extension/accordion.ts`; resolve
  codes to folded content GUI-side and return it in the tool result (engine support, like
  `unfold`). It must return the block's **original** full content (`Block.text`), never the
  conductor's substitution or the digest — returning the lossy replacement would defeat the
  unblockable-read guarantee. Caveat: under a `tail-size`-locked conductor the recall result is
  itself an ordinary tail block the conductor may fold on its next pass, so the guarantee is the
  agent's **same-turn read**, not lasting availability. Outside the conductor contract.
- **Kill-switch freeze-on-detach** — change `detach()` to freeze the current folded view +
  unlock, instead of reset-to-raw (`store.svelte.ts`). Mechanism: today `detach()` →
  `attach(null)` → `clearConductorState()` returns every non-human-held block to raw, so the
  freeze must first **convert each currently-folded block into a sticky, human-owned fold**
  (`override:"folded"`, `by:"you"`) so the subsequent raw pass leaves it folded and individually
  reversible.
- **Consent gate + lock-table UI** — the one-time confirm on exclusive attach, and the
  checks-and-x's lock table in the conductor switcher. On consent, *releasing existing human
  holds* (§6) clears the human override kinds (`pinned`/`folded`/`unfolded`, `by:"you"`) in the
  **locked** domain only; the agent's sticky `unfolded` overrides belong to the separate
  `agent-unfold` axis, not `human-steering`.

## Consequences

- **Conductor authors get a deterministic world** when they want one: an exclusive conductor
  knows its standing view will not be fought mid-run, which is what makes a real autopilot
  strategy testable.
- **The trust story is now revocability, not override.** "You can always overrule it" becomes
  "you can always *leave* it" — a single, host-enforced guarantee that holds no matter what a
  conductor declares. This is simpler to reason about than per-control override and harder for
  a conductor to subvert (it can't; detach needs no cooperation).
- **The agent can never be blinded.** `recall` being unblockable means even total lockdown
  preserves "no silent forgetting" — the agent's history is always reachable.
- **A founding line in the docs flips.** VISION ("This protection is absolute"; the
  capability matrix; "overrule it with a pin"), README ("Three hands on the same controls"),
  and CLAUDE.md ("human overrides always win") are rewritten to make the conditionality
  first-class, not a footnote.
- **Ships additively.** The golden test is untouched; every existing conductor is
  unchanged; a user who never opts in never notices.

## Rejected alternatives

- **Lockout WITHOUT a kill switch.** Rejected: revocability is the *replacement* trust
  anchor. Without an unconditional detach, an exclusive conductor could trap a user in a
  context state they can't leave — unacceptable. The kill switch is non-negotiable and
  host-enforced.
- **Detach resets to raw.** Rejected: unfolding everything on the way out could blow the
  budget the instant the user leaves. Detach **freezes** the current view and unlocks; the
  user can then unfold deliberately.
- **One blunt human+agent lockout switch.** Rejected in favor of two separate axes plus
  `recall`. A single switch couldn't express "lock the human, leave the agent free," and
  without `recall` locking the agent would mean blinding it.
- **Budget "fixed once set."** Dropped: pi can move the real context window by switching
  models, so a frozen budget buys no determinism. Budget stays sacred and fully the human's.
- **A two-layer host floor on the protected tail** (host keeps a small absolute floor under
  an exclusive conductor). Overruled by the owner: approved = full control, including the tail
  to zero. The host keeps no tail floor; provider-validity is its only unconditional floor.
- **Making observation lockable for a "clean room" autopilot.** Rejected outright:
  observation is the sacred tier. A source of truth you can't watch is not one you can trust
  to revoke; seeing is what makes the kill switch meaningful.

## Deferred

- **Granular `human-steering` sub-locks.** The current `human-steering` lock is all-or-nothing:
  a conductor either owns fold/unfold/pin/unpin/group/reset as a unit, or none of it. There is
  no way to express "lock grouping but leave pinning free" or "lock fold/unfold but leave the
  reset button to the human." A future split could decompose `human-steering` into separate
  named locks (e.g. `human-fold`, `human-pin`, `human-group`) giving conductors finer-grained
  control — an autopilot that wants to own grouping but still lets the human pin blocks for
  emphasis is currently forced to take the whole steering wheel or none of it. Deferred because
  the current three-lock vocabulary covers every shipped conductor's needs; add sub-locks only
  when a real conductor author needs them.
