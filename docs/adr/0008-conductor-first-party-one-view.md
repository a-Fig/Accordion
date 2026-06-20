# ADR 0008 — Conductors are first-party; one public view for all of them

**Status:** accepted
**Date:** 2026-06-13
**Builds on / supersedes parts of:** [ADR 0007](0007-conductor-protocol.md) (the conductor
seam — the `conduct → Command[]` idea, the wire topology, the clamp/override rules all
stand; this ADR corrects 0007's *framing* and *layout*, not its contract).

## Context

ADR 0007 shipped the conductor seam, but two of its assumptions aged badly the moment the
first non-built-in conductor was written.

1. **It framed conductors as untrusted third parties** — "a stranger on the internet
   writes their own and slots it in," with the host language oriented around protecting the
   session *from* the conductor. That is the wrong mental model. Every conductor that runs
   against Accordion ships in this repo (or a fork of it); a conductor is a strategy a
   developer authors, not arbitrary code arriving over the network. The interface's job is
   to make conductors **easy to build**, with the built-in folder as the worked example —
   not to sandbox a hostile peer.

2. **It left the built-in privileged.** 0007 said "the built-in is just the default
   conductor," but in practice the built-in still read engine-internal state and was
   special-cased by `id === "builtin"` in the host's actor attribution, and the public
   view (`ContextSnapshot`/`BlockView`) was a thinner projection than what the built-in
   actually consumed. So "conductors all the way down" was aspirational: the reference
   implementation was not, in fact, programmed against the surface everyone else got.

We also wanted the WebSocket form — primary in 0007's prose — demoted to what it actually
is: an escape hatch for a separate process or another language. The overwhelmingly common
case is a TypeScript class dropped into the repo, and the docs/layout should lead with
that.

## Decision

### 1. Conductors are first-party — drop the "untrusted" framing

A conductor is a strategy authored in (or forked from) this repo. There is no sandbox, no
trust boundary, no "protect against" posture. The clamp reports, the "human overrides
always win" rule, and the provider-validity floor all remain — but they are **bug/UX
guardrails** (a conductor mistake shouldn't corrupt the session or fight the human), not
defenses against an adversary. The contract's purpose is restated as: make a conductor
cheap to write, with the built-in as the reference.

### 2. One public `ConductorView`, consumed by every conductor including the built-in

There is exactly one input surface: `ConductorView` (in `conductors/contract/conductor.ts`)
— pure, serializable data: `budget`, `contextWindow`, `liveTokens`, `protectedFromIndex`,
`protectTokens`, and `blocks: ViewBlock[]`. A `ViewBlock` folds the host's policy into plain
booleans (`held`, `folded`, `protected`, `grouped`) and pre-computes `foldedTokens`, so a
conductor never calls an engine helper. The built-in (`buildView` → `conduct`) reads this
**identical** structure; there is no privileged richer in-process snapshot. The old
`ContextSnapshot` / `BlockView` names and the `isInFoldedGroup()` method are gone, replaced
by `ConductorView` / `ViewBlock` and the `grouped` boolean. New fields over 0007:
`foldedTokens`, `held`, `grouped` per block, and top-level `liveTokens` / `protectTokens`.

### 3. The built-in is relocated and de-privileged

The built-in folder moves from `app/src/lib/engine/conductor.builtin.ts` to
`conductors/builtin/builtin.ts`, alongside every other conductor. The host's
`id === "builtin"` special-case is removed: **every** conductor's folds are attributed
uniformly (`by: "auto"`), so the built-in is a peer, not an insider. Its ~15-line `conduct`
is the worked example a newcomer copies. Its byte-identical output is pinned by a golden
test.

### 4. Contract relocated; in-process is the primary path, WebSocket the escape hatch

The contract moves out of the app and into `conductors/contract/` (`conductor.ts` +
`protocol.ts`, re-exported by `conductors/contract/index.ts`), imported by app code and
conductors alike via the `$conductors` alias. The **primary** way to write a conductor is
an in-process TypeScript class implementing `conduct(view)`, dropped in `conductors/<name>/`
and registered with one line in the `IN_PROCESS_CONDUCTORS` array in `conductors/index.ts`
— it then appears in the header switcher automatically. The **WebSocket** form
(`protocol.ts`, `CONDUCTOR_PROTOCOL_VERSION = 2`, `context/update` now carrying the full
`ConductorView`) is demoted to a clearly-marked escape hatch for "I need a separate process
or another language"; `conductors/recency-folder/` is the runnable wire example.

## Consequences

- **Authoring a conductor is one file + one line.** The friction of standing up a WS server
  and a heartbeat file is gone for the common case; it is reserved for genuinely
  out-of-process strategies.
- **The reference is honest.** Because the built-in reads the exact public view, "read the
  built-in to learn the interface" is now literally true — there is no hidden surface it
  enjoys.
- **The wire is a strict superset story.** `context/update` ships the same `ConductorView`
  the in-process path builds, so an out-of-process conductor sees byte-for-byte what an
  in-process one sees. Bumping to `CONDUCTOR_PROTOCOL_VERSION = 2` reflects the richer
  `ViewBlock` / top-level token fields.
- **Docs realigned.** `conductors/README.md` and `docs/conductor-protocol.md` lead with the
  in-process contract and demote the wire; the "stranger/untrusted" language is removed
  throughout.

This supersedes the framing, layout, and primary-surface choices in ADR 0007 §2–§4 (the
contract's *file location*, the WebSocket-first emphasis, the third-party trust posture,
and the built-in's privileged position). ADR 0007's core contract — `conduct → Command[]`,
content-substitution-only commands, the imperative full-state model, clamp reports, human
overrides winning, and the conductor-hosts/Accordion-dials topology — stands unchanged.
