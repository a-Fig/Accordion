# ADR 0024 — Single controller and the stable door

**Status:** accepted
**Date:** 2026-07-23
**Builds on:** [ADR 0021](0021-truth-in-the-extension.md) (the authoritative per-session `Truth` this
feature gates writes against — the enforcement point this ADR adds sits in front of the exact same
`command` ingress ADR 0021 established), [ADR 0022](0022-conductor-contract-v2.md) (the conductor
`propose` write path, which this feature deliberately does NOT touch), [ADR 0011](0011-conductor-involvement-locks.md)
(involvement locks — a different, per-conductor-attachment coordination mechanism this ADR's global
lease is not a replacement for; see §1 and Rejected alternatives).
**Closes:** the design half of issue #66 (two problems: no write arbitration across simultaneously
connected surfaces, and no stable URL across a session's lifetime). The code half ships in the same
PR this ADR documents.

## Context

Issue #66 named two separate problems with the live link as of protocol v15:

1. **No write arbitration.** Any number of GUI clients could attach to the same live session (or,
   for that matter, to different sessions on the same machine) and each could freely send mutating
   `command`s — fold/unfold/pin, `setBudget`, `setProtect`, `setFolding`, `selectConductor`. Nothing
   distinguished "the surface a human is actively driving" from "a stale tab someone forgot was open
   in another window." Two surfaces steering the same session raced silently; whichever command's
   event landed last simply won, with no notification to the surface that got overwritten.
2. **No stable URL.** Each pi session's extension binds an OS-assigned ephemeral loopback port
   (ADR 0001), advertised only through that session's own registry entry and the `/accordion` output
   at the moment it started. There was nowhere to bookmark, no persistent address that outlived a
   single session's process lifetime.

The Phase B/C redesign (ADR 0021, ADR 0022) had already solved a piece of this by construction,
without anyone setting out to: because the extension is authoritative and every client is a pure
replica fed by the same event stream, **multi-client mirroring already worked** — every attached
surface saw the identical Truth state, kept in lockstep by `rev`-stamped events (ADR 0021 §3). And
because budget/protect/fold-arm state lives in `Truth`, not in any one client, **that state already
survived a disconnect/reconnect** — a reconnecting replica just gets a correct fresh `snapshot`. What
Phase B/C did *not* solve, because it was never about writes, was **arbitration**: nothing stopped
two connected surfaces from both being allowed to mutate at once. And nothing in the wire protocol
touched the second problem, URL stability, at all.

This ADR's job is narrow given that context: add a **write gate** (who is allowed to send a mutating
command right now) and a **stable rendezvous point** (one fixed address for `/accordion` to print),
without re-solving anything Phase B/C already got right.

## Decision

### 1. One controller, globally — not one per session

Exactly one surface controls **machine-wide, across every live pi session**, not one controller per
session. A per-session lease was the more "obvious" scoping and was explicitly rejected: the
Sessions sidebar already gives a single surface reach over every live session on the machine, so a
lease scoped to just the currently-open session would still let the same human open two browser tabs
against two different sessions and drive both simultaneously with no arbitration between them at
all — missing half of what issue #66 was actually complaining about (a surface authoritatively
"driving," full stop, not "driving this one session"). It would also mean tracking N independent
lease states instead of one, for a benefit (letting two *different* people or windows genuinely
co-drive two *different* sessions on the same machine on purpose) that is a real but niche use case
— see Rejected alternatives.

This is a different mechanism from the per-conductor **involvement locks** of ADR 0011
(`human-steering`/`agent-unfold`/`tail-size`): those govern whether a specific *attached conductor*
may exclude the human from a specific *session's* steering controls. The controller lease governs
which *human-facing surface* — of potentially several open at once — is the one whose commands reach
any Truth at all. They compose independently: a non-controller surface's command is refused before
it even reaches a session's Truth (§6); a controller surface's command can still separately be
clamped by a conductor's lock once it gets there.

### 2. Silent claim when uncontested; a popup only when contested

A connecting surface's behavior depends on `hello.controller` (`ControllerInfo | null`,
`core/protocol.ts:186-190`):

- **No lease, or a lease whose `heartbeatAt` has gone stale** (`fresh: false`) → the connecting
  surface claims it **silently** — no dialog, no confirmation. This is the overwhelmingly common
  case: one person, one active surface, reconnecting after a reload or opening the app for the first
  time today.
- **A fresh lease held by a *different* surface** → the connecting surface is offered a one-time
  takeover confirmation (dismissal remembered for the page load; the header's affordance remains the
  standing way to take control afterward).

The principle: friction should scale with actual risk. A reload of your only open tab is not a
conflict and asking about it would just be noise; two surfaces actually contending for the wheel is
exactly the case a confirmation exists to surface.

### 3. Read-only is strict zero-write; TAKE CONTROL is the only escape

A non-controller surface cannot mutate *anything* live-steering-related, with no per-action
exception and no "are you sure, just this once" bypass. This mirrors the standing rule already in
CLAUDE.md for CC transcripts and demo/preview sessions ("preview/read-only is NOT a more permissive
mode") — read-only means read-only, uniformly, everywhere in the surface, not just for the
higher-risk controls. The only way out of read-only is the same door every surface has: claim
control.

### 4. Takeover is never refused — the human is the authority, last write wins

`claimController` is honored unconditionally from any GUI socket that carries a sanitized surface
identity (`extension/accordion.ts`'s `handleClaimController`, ~line 1502) — there is no server-side
veto, no grace period, no requirement that the current holder consent. This is deliberate: the
person at the keyboard is the actual authority in this system, always. The lease exists to make
*accidental* cross-talk between surfaces visible and to give a definite, low-friction default (silent
claim when nothing is contending) — it is not a permission system adjudicating between two humans
who are both trying to drive at once. If that happens, it's a social problem outside what the
software should referee; the system's job is only to make it unambiguous, at every moment, who
currently has it, and to make taking it back a single unconditional action for anyone.

`claimController` is **not** gated by the controller check itself — if it were, a non-controller
surface could never claim, which would make the whole feature a one-way ratchet.

### 5. Mechanics: the `~/.accordion/controller.json` blackboard

`ControllerLease` (`app/src/lib/live/registry.ts:110-124`) — `{ registryProtocol, surfaceId, label,
claimedAt, heartbeatAt }` — is written to `~/.accordion/controller.json` with the same atomic
write-rename pattern every other registry file uses (`writeControllerLease`, `accordion.ts:1386`):
write to a `.tmp` sibling, then rename over the destination, so no reader ever observes a half-written
lease.

- **Surface identity.** Each client surface mints a **per-tab** UUID in **`sessionStorage`** (not
  `localStorage`) plus a human label ("Desktop app" / "Browser tab") and sends both as
  `?surface=`/`?label=` dial params, which the extension sanitizes at connect
  (`sanitizeSurfaceId`/`sanitizeSurfaceLabel`, `core/protocol.ts:673-697` — bounded charset/length; a
  socket with no valid surface id can never hold the lease at all). `sessionStorage`, not
  `localStorage`, is deliberate and load-bearing: the door (§7) collapses every surface onto one
  fixed origin, so a `localStorage` id — shared across all same-origin tabs — would give two door
  tabs the **same** surface id, and both would render steerable and both would pass `isControllerSocket`
  (§6), defeating the whole arbitration. `sessionStorage` is per-tab, so two door tabs get distinct
  ids. It survives a tab's own reloads (so a controller that reloads reclaims its own lease); a
  tab that is closed and reopened is a **new** surface by design. Browsers copy `sessionStorage` on
  tab-**duplicate**, which would recreate the shared-id hole, so at init the module announces its id
  on a `BroadcastChannel` ("accordion-surface-id") and keeps listening: any other live context that
  owns the id answers "in-use", and an **undialed** context that learns its id is taken re-mints a
  fresh one into its own `sessionStorage` — no matter how late the reply lands. A **dialed** context
  never re-mints (it defends its id instead). Ordering is load-bearing: a dial obtains its id
  through `surfaceIdReady()`, which waits out the short (~150ms) dedupe window before freezing and
  handing the id to the wire — freezing in the same synchronous frame as init (exactly what
  browser-served auto-connect would otherwise do via onMount → `connectLive`) would put the copied
  id on the wire before the owner's reply could land, making the whole guard inert. The app primes
  the module at bootstrap (`+layout.svelte`) so the window has usually elapsed by the first dial and
  the wait is zero; the worst case is one ≤150ms hold on the very first dial. The guard is
  failure-open (no `BroadcastChannel` support / any error ⇒ proceed with the `sessionStorage` id,
  no wait). See `app/src/lib/live/surfaceId.ts`. The `label` is
  **display-only** — it names the current controller in the
  READ-ONLY chip and the takeover copy and is **never an authorization input**. A spoofed label is
  therefore purely cosmetic: it cannot grant or deny control (only the `surfaceId` plus the
  fresh-lease check gate anything), and it is sanitized (charset/length + control-char stripping,
  re-validated again on the disk-read path per §S2) solely so a hostile or corrupt value cannot ride
  into a broadcast, not because any trust decision depends on its contents.
- **Heartbeat.** Whichever extension the controlling surface's socket is currently connected to
  refreshes `heartbeatAt` every `CONTROLLER_HEARTBEAT_MS` (2s) — but only while a connected socket's
  `surfaceId` actually matches the lease (`heartbeatController`). It re-reads the lease **fresh from
  disk** at the top of every tick and only ever writes back the surfaceId it just read (never its
  cached one): at a coincident tick the heartbeat can fire *before* the poll, so writing from a stale
  cache would let this extension re-assert an old holder and clobber another extension's just-written
  fresh claim (**C1**). Since the lease is global but each extension is its own OS process, only the
  one process the controller is actually talking to *can* renew it; there is no other process that
  could meaningfully claim to know the controller socket is still alive.
- **Propagation to sibling extensions.** No push channel exists between independent pi sessions'
  extension processes, so every *other* extension observes a lease change via a `~1s`
  (`CONTROLLER_POLL_MS`) poll of `controller.json` (`pollControllerFile`) rather than being told
  directly. The poll compares **file content** (`surfaceId`/`label`/`claimedAt`/`heartbeatAt`), not
  the file's mtime — an mtime-equality early-return could miss a same-mtime foreign rewrite (**C4**);
  the file is tiny, so reading it every tick is cheap. Both timers are best-effort, bare unref'd,
  never on the `context` hook — same posture as every other piece of discovery I/O in this codebase.
  (The cadence for both is overridable via test-only env seams `ACCORDION_CONTROLLER_HEARTBEAT_MS` /
  `ACCORDION_CONTROLLER_POLL_MS`; production never sets them.)
- **Staleness window: 6s** (`CONTROLLER_STALE_AFTER_MS`, `registry.ts:68`) — comfortably above 3× the
  heartbeat interval (so a merely-idle-but-connected controller is never falsely treated as gone),
  tight enough that closing a tab frees control within a handful of seconds rather than requiring a
  manual release.
- **No lease-clearing frame.** There is no wire message for "control was released" — a stale lease
  only surfaces on a fresh connect's `hello.controller.fresh: false`
  (`ControllerMessage`'s doc comment, `core/protocol.ts:343-349`, is explicit that this is
  deliberate: "last write wins," not "last write wins until it's been quiet a while, in which case
  broadcast a clear"). A direct and **accepted** consequence, stated plainly: if the controlling
  surface simply **vanishes** (its tab is closed, its process dies), every OTHER already-connected
  surface stays **READ-ONLY** — still showing the now-gone controller as the steerer — until a human
  clicks **TAKE CONTROL** on one of them. Auto-claim is a *connect-time* decision (§2); an
  already-open surface does not silently re-claim a lease that goes stale under it, precisely because
  no client is ever told the lease went stale (no clearing frame). The escape hatch — TAKE CONTROL is
  always one unconditional click (§4) — is deemed sufficient, and a background "the controller went
  quiet, promote myself" path is deliberately not built.
  - **Micro-edge, accepted:** because the surface id is per-tab `sessionStorage`, closing the
    controller tab and reopening it *within* the 6s staleness window arrives as a **new** surface
    while the old lease is still fresh — so another already-open surface briefly shows the contested
    takeover popup naming a now-dead tab. One click of **TAKE CONTROL** resolves it. We chose this
    over server-side stale-stamping the lease on socket disconnect, which would have to distinguish
    "the controller tab really went away" from "the controller is mid-session-switch, dialing a
    different session's extension" — and getting that wrong risks clobbering a fresh lease the very
    surface just re-established. A one-click resolution of a rare, self-inflicted micro-edge is the
    better trade than a disconnect-time write that can stomp a legitimate hand-off.

### 6. Enforcement lives at the WS command ingress, not inside `Truth`

The refusal is synthesized in `extension/accordion.ts`'s `command`-message handler
(`isControllerSocket` check, ~line 1634) **before** `sanitizeCommand`/`applyCommand` ever runs — it
never reaches `Truth.apply`. `"read-only"` is a new `ClampReason` (`core/ops.ts:88-91`) whose own
doc comment says it plainly: "NEVER produced by `Truth.apply` itself; synthesized only at the
extension's command ingress for a non-controller surface's ops." This is a deliberate seam choice:
`Truth`'s own invariants (a conductor op always clamped by `canFold`/protected-tail/human-override,
ADR 0022) stay exactly as they were, untouched by a concept — "which human-facing surface is
speaking" — that has no meaning to a conductor or to the agent's own tools.

Concretely, the only two client messages exempt from the gate are `claimController` (must work *for*
a non-controller surface, or it could never be used to become one — §4) and `resnapshot` (a pure
read, never a mutation). Every kind in `WireCommand` — `ops`/`setBudget`/`setProtect`/`setFolding`/
`selectConductor` — is gated uniformly, because `sanitizeCommand`'s dispatch is the one place all of
them funnel through. Conductor-role sockets never pass through this code path at all — `propose`,
`completeRequest`, `setConductorStatus`, `holdRelease`, and `cancelComplete` are routed to
`liveHost.handleConductorMessage` before the controller check is ever reached (`accordion.ts:1603`),
and the agent's own `unfold`/`recall` pi tools resolve in-process against the Truth directly (ADR
0021 §4) — neither rides the client→server wire at all, so neither has anything to gate.

A stale or absent lease is treated as **uncontrolled**, not permissive: `isControllerSocket` returns
`false` unless a lease exists *and* is fresh *and* names this socket's surface (`accordion.ts:1480`),
so a mutating command still gets refused even with no lease on file — the connecting client is
expected to claim first, and auto-claim (§2) makes that invisible in the overwhelmingly common case.

### 7. The door: a fixed loopback port, one extension at a time

`DOOR_PORT = 24317` (`core/protocol.ts:96`) is deliberately **not** 4317, the standard OTLP/gRPC
collector port — a dev machine that also runs an observability stack has a real chance of already
holding that port, and colliding with it would be a confusing failure mode for something with nothing
to do with telemetry collection.

One extension at a time binds the door as an **additional** listener serving the identical handlers
(static UI, `/__accordion/*`, WS upgrade) its own per-session ephemeral server already serves
(`tryBindDoor`) — a client dialing the door is, from the server's point of view, indistinguishable
from one dialing that session's ephemeral port; the door is just also reachable at a fixed address.

Claim protocol on `EADDRINUSE`: probe + **classify** the incumbent's `/__accordion/meta` (reusing the
existing bounded sibling-origin probe machinery, `DOOR_PROBE_MS` = 750ms) into one of three outcomes
(`probeDoor`), rather than the earlier binary served-true / everything-else split:

- **ACCORDION** (trust — stand down this cycle, and `/accordion` may print the secret door URL): a
  completed HTTP 200 from a loopback peer that is `served: true` **AND** `protocolVersion ===
  PROTOCOL_VERSION` **AND** whose `sessionId` appears in the live session registry. Retry on a slow
  timer (`DOOR_RETRY_MS` = 4s, unref'd, never on the `context` hook, `scheduleDoorRetry`).
- **FOREIGN** (permanent stand-down for this run, `doorForeign`): a **completed** HTTP response that
  fails the served/shape check — a non-200, an unparseable body, or `served !== true`. This is
  definitive evidence of non-Accordion software, and only this earns the permanent stand-down.
- **TRANSIENT / ambiguous** (schedule a retry, **never** permanent): a probe timeout, a connection
  error/refused (a busy peer, or one that exited mid-probe), a `served: true` peer of a **different**
  protocol version, or a matching peer whose `sessionId` we could not confirm in the registry (a
  startup race). This is the correction to a real earlier defect: collapsing a timeout, a mid-probe
  exit, or an other-version Accordion to "foreign" would **permanently disable the door for this
  process** against a peer that was merely busy, momentarily gone, or a different build — a peer that
  will often be back a second later.

The trust bar is deliberately stricter than `served: true` alone (which was weaker than the
sibling-origin probe): foreign software that answers `{"served":true}`, or an Accordion of a
mismatched version, never gets the secret-bearing door URL aimed at it. When the door holder's process
exits, the OS frees the port and a standing-by extension's retry timer rebinds it within a few seconds
— automatic takeover with no coordination beyond "keep trying."

The fixed-port `listen(DOOR_PORT, "127.0.0.1")` was empirically verified on Windows 11 (2026-07-23):
two separate processes racing the identical bind do **not** both succeed — the loser cleanly receives
`EADDRINUSE` (no `SO_REUSEADDR` socket-hijack), so the `EADDRINUSE` probe above is the sole arbitration
and no additional lockfile is required.

`/accordion`'s output prefers the door: if a live door is up (this extension holds it, or a probe
returns the **ACCORDION** verdict for a sibling), it prints `http://127.0.0.1:24317/?token=<door-secret>`;
otherwise (foreign-occupied, or a merely-ambiguous probe) it falls back to this session's own ephemeral
URL exactly as before.

### 8. The door-secret: atomic create-with-content, a deliberate deviation from write-rename

`~/.accordion/door-secret` (32 random bytes, hex-encoded, `0600` best-effort) is created by writing
the full secret to a same-directory temp file and then **`fs.linkSync(tmp, path)`** — the destination
appears with its complete bytes or not at all, and the link fails with `EEXIST` if a racer created
the file first (`ensureDoorSecret`/`tryCreateDoorSecret`, `extension/accordion.ts`; the tmp is always
unlinked afterward). This is **not** the write-rename pattern every other file in this ADR (and every
existing registry file) uses.

The reason is a real difference in value-lifecycle semantics, not an inconsistency to clean up.
Write-rename exists to make a value that **changes over time**, where the newest write should win,
observable only in a complete state — a lease, a heartbeat. The door-secret is the opposite kind of
value: it must be written **exactly once** and then stay byte-for-byte identical for as long as *any*
extension process has it cached in memory and is handing it out as a live bearer token to browser
tabs. If secret creation used write-rename, a second extension racing to create it would *replace*
the file's bytes out from under a first extension that already created — and, by then, possibly
already distributed to a connected browser — a different secret: an in-use, already-handed-out
credential clobbered by a peer that merely lost an unrelated timing race, desyncing every extension
that had already cached the old value. link-into-place removes that window entirely: the loser of the
race gets `EEXIST` and adopts the winner's file, and every extension in the process group converges on
the one value that was ever actually created, regardless of who wrote it.

An earlier draft of this section (and an earlier implementation) used a bare exclusive-create —
`fs.openSync(path, "wx", 0o600)` followed by a separate write — and claimed that `EEXIST` implied the
winner's bytes were already present. **That claim was false**: with open-then-write, a racer that hit
`EEXIST` could read the file in the winner's open→write gap and cache an empty/partial secret with no
retry, and a creator crashing between open and write left a permanently invalid file that every later
extension would read, fail to validate, and give up on forever. The shipped mechanism closes both
holes:

- **Appears-complete create**: tmp + `linkSync` as above — `EEXIST` now genuinely implies complete
  bytes, because the destination name never exists without them. Where hard links are unsupported
  (`EPERM`/`ENOSYS`/`EXDEV`/`ENOTSUP` — a non-NTFS edge), creation falls back to the old `"wx"`
  create-then-write; the reader-side retry below covers that fallback's window.
- **Reader validation + bounded retry**: every read is validated against `/^[0-9a-f]{64}$/i`; an
  absent or invalid read schedules a bounded re-read/re-create attempt (up to 10 tries, linear
  backoff on a bare unref'd timer) instead of settling on an empty secret after one shot.
- **Stale-invalid recovery**: a file that exists but is *invalid* and whose mtime is older than 10s
  (no legitimate writer holds it invalid for anywhere near that long) is treated as a crash artifact,
  unlinked, and re-created — two extensions both recovering converge via the link/`EEXIST` primitive
  rather than fighting; a re-stat/re-validate immediately before the unlink shrinks the reap-vs-
  recreate TOCTOU to microseconds (the residual is accepted). The retry budget (~22s) deliberately
  exceeds the staleness threshold, so a young invalid file always ages into reapability within the
  budget. The mtime threshold assumes `~/.accordion` lives on a **local filesystem** (the norm for a
  home directory) — writer/reader clock skew enters only on network mounts, which are outside the
  door's supported layout.
- **The door is gated on a valid secret**: `tryBindDoor` refuses to bind (and `/accordion` never
  prints the door URL) while the secret is unresolved; the retry timer re-kicks the bind the moment
  it resolves. A door with no bearer to serve is never up.

### 9. Security posture: no new local exposure, but new secret-lifecycle properties to own

- The shared secret is accepted as a bearer everywhere the existing per-session `webToken` already
  is (static serving, token-gated endpoints, WS upgrade) — it adds no new endpoint and no new
  capability beyond what a token holder could already reach; it only makes "which token" independent
  of which specific session's URL you happen to have.
- **The correct honest framing** (an earlier draft of this ADR, and an earlier `isBearer` comment,
  mis-stated it as "both secrets already live on disk"): the per-session `webToken` is **memory-only**
  — minted with `crypto.randomBytes` per session and **never written to disk** (a `SessionEntry`
  carries no token field; `buildEntry` writes none). Only the **door secret** is a file
  (`~/.accordion/door-secret`). So the two secrets do NOT share an on-disk footprint, and the argument
  for why sharing one is acceptable must not rest on the false "they were both on disk anyway."
- What actually stops a **hostile web page** is unchanged, and is the boundary that matters: a web
  page can read neither files nor this process's memory, so neither the door secret nor the webToken
  is reachable to it. Its only paths in remain the Origin/token checks at the WS upgrade and the HTTP
  static-serve gate, exactly as strict as before (ADR 0021 §7's "WS auth model is unchanged" carries
  forward verbatim; the door listener reuses the identical `verifyWsUpgrade`/auth logic on its second
  socket, not a relaxed copy of it).
- A **same-user local process** is explicitly outside the threat model. It can already read pi's own
  session data on disk directly (transcripts, tool output), so a same-user process reading
  `door-secret` learns nothing it could not already obtain — the shared secret is not a new boundary
  against it, and never claimed to be.
- What the door secret DOES newly introduce, versus the ephemeral in-memory webToken, and which this
  ADR owns rather than hand-waves: it is **persistent across reboots** (the file survives), **never
  rotated** for the life of the file, **shared machine-wide** (every extension honors it), and **rides
  a bookmarkable URL** — so it can leak via browser history / bookmark sync, or via a link the user
  copies or forwards. The passive address-bar path is closed client-side: the served page captures the
  token once and `history.replaceState`s it out of the visible URL (§S1b, `servedToken.ts`), so it
  no longer accretes in history/bookmarks by merely being open. But a link the user *deliberately*
  shares still carries a live, machine-wide, non-expiring credential. **Secret rotation (and/or a
  shorter-lived door token) is a named follow-up, deliberately not shipped in this PR.**
- A predictable, fixed port (24317, vs. a random ephemeral one) removes nothing that was actually
  load-bearing: the ephemeral port was never itself a secret (the existing sibling-origin probe
  already treats "some local Accordion server is listening" as discoverable) — only the token gated
  real access, and the door reuses that exact gate unchanged.

### 10. Terminology: READ-ONLY stays the one word

A Claude Code transcript keeps its existing plain READ-ONLY badge, unqualified — there is no wire
under a CC session, so no further affordance is possible and none is added. A **live** session
currently steered from another surface shows `READ-ONLY · <WHO> STEERS` plus a `TAKE CONTROL` button
— the same word, with a different affordance riding alongside it to reflect that this read-only state
is escapable in a way a CC transcript's never is. "View-only" was deliberately not introduced as a
second term: the two situations share the exact guarantee the standing CLAUDE.md rule already
states (same foldability predicate, same UI affordances, same token accounting, zero write
capability) — a second word would imply a behavioral difference between them that does not exist.
The only real difference is the affordance next to the badge, not the badge's meaning.

## Consequences

- Exactly one write path exists machine-wide at any moment. Every non-controller connection —
  including, notably, a session's *own* desktop-app window if a browser tab elsewhere has since
  claimed control — degrades to observe-only automatically, with no manual bookkeeping required by
  either surface.
- `/accordion` now prints one stable, bookmarkable URL in the common case, rather than a fresh
  ephemeral link that has to be re-copied out of pi's output every session.
- The conductor write path (`propose`) and the agent's own `unfold`/`recall` tools are completely
  unaffected by this feature — the gate sits only in front of the GUI's human-steering command sink,
  which is exactly the surface issue #66 was about and nothing more.
- `PROTOCOL_VERSION` is 16. `hello` gains `controller`; `CommandResultMessage` gains
  `refused: "read-only"`; a new client→server `claimController {}` and a new server→client
  `controller { surfaceId, label }` are added. A strict version-mismatch check on both peers means a
  pre-v16 peer cannot pair with a v16 host/client that assumes any of this vocabulary exists — the
  same discipline every prior protocol bump in this codebase has followed.
- **Known gap, not yet closed:** cross-extension lease *handoff* — the controller heartbeats through
  extension A, the user then switches which live connection is controlling to a session hosted by
  extension C, and A's stale heartbeat has to actually go quiet while C's mtime poll picks up the new
  holder — is covered by this ADR's reasoning (§5) and by the mechanism as built, but is **not yet
  exercised by an automated end-to-end test**; it has been reasoned through, not proven by a running
  scenario. This is a verification gap, not a design one, and should be closed with a real
  multi-extension test before this is relied on under load.
- As of this writing, the wire protocol, the extension-side enforcement, and the client-side
  `controllerState`/`isController`/`claimController` plumbing (`app/src/lib/live/liveClient.svelte.ts`)
  are in place, but the actual UI treatment described in §2/§3 (auto-claim on connect, the takeover
  confirmation dialog, `MapHeader`'s disabled-controls-plus-badge rendering) is explicitly called out
  in that file's own comments as belonging to a separate layer ("spec Part 3") — see the Delivery
  notes in the accompanying PR for its current status.

## Rejected alternatives

- **Per-session controller lease.** Rejected — §1. Scoping the lease to a single session would leave
  the same human free to drive two different sessions from two different tabs at once with no
  arbitration between them, missing half of what issue #66 raised, in exchange for a capability
  (deliberate simultaneous multi-session co-driving) nobody asked for.
- **Two-monitor / split-control** (multiple simultaneous controllers, each scoped to a disjoint
  session or block range). Rejected for v1 as a real but niche use case: nothing in `ControllerLease`
  or the door's design structurally forecloses building this later — scoping is an additive
  narrowing, not a rewrite — but v1 ships the simplest model that actually solves issue #66's
  complaint (arbitration + a stable URL), not the maximal one nobody has asked for yet.
- **A refusable or negotiated takeover** (the current holder must approve, or a grace period must
  elapse before a takeover is honored). Rejected — §4's reasoning: the human is always the authority
  in this system, and negotiating a takeover just reintroduces the two-surfaces-fighting-with-no-
  defined-winner problem the lease exists to remove, with extra steps and a worse failure mode (what
  happens if the "current holder" to ask is the very tab that's gone stale?).
- **Write-rename for `door-secret`, for consistency with every other registry file.** Rejected —
  §8's reasoning: consistency with the *other* files is the wrong axis to optimize, since the secret
  has fundamentally different value-lifecycle semantics (write-once-and-stay-stable) than a
  lease/heartbeat file (replace-on-every-change). Applying the wrong primitive for the sake of
  uniformity would have reintroduced exactly the clobber window the tmp+link create exists to close.

## Deferred

Nothing new. Conductor-initiated recall (issue #78, ADR 0019) remains out of scope, unchanged from
[ADR 0023](0023-birth-fold-restored.md)'s own Deferred section — this ADR does not touch it.
