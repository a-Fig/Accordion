# conductors/

Every shipped conductor lives here, split only by **transport** — how it runs relative to the pi
extension process. The conductor *contract* itself (the interface these implement, the in-extension
host that attaches them, the shipped-conductor catalog, and the out-of-process remote SDK) is not a
conductor and lives in [`core/conductor/`](../core/conductor/) instead — see that directory and
[ADR 0022](../docs/adr/0022-conductor-contract-v2.md) for the contract.

## `in-process/`

Conductors instantiated directly inside `LiveConductorHost` (`core/conductor/liveHost.ts`) — no
socket, no child process. Bundled straight into the pi extension.

- [`compaction-naive/`](in-process/compaction-naive/) — a deliberately-lossy LLM-summarization foil (ADR 0014).
- [`handoff/`](in-process/handoff/) — simulates a manual handoff to a fresh session (ADR 0017).
- [`doorman/`](in-process/doorman/) — the birth-fold demonstration conductor (ADR 0018 / 0023).
- `agedSummaryConductor.ts` — shared base class factored out of `compaction-naive` and `handoff`
  (PR #82); not a conductor on its own, not in the shipped catalog.

## `ws/`

Conductors spawned as their own Node process, dialing back into the live session as an ordinary
WebSocket client (`?role=conductor&token=<single-use>`).

- [`thermocline/`](ws/thermocline/) — attention-gated, LLM-quality compression under a hard budget
  invariant. The extension spawns `node conductors/ws/thermocline/runner.mjs`, which imports the
  committed `remote-sdk.mjs` bundle (generated from `core/conductor/remote.ts` + `thermocline.ts` by
  `extension/build-remote-sdk.mjs`).
- [`triptych/`](ws/triptych/) — pressure-gated thirds: raw recent band, tree-sitter-L2 code-skeleton
  middle band (recoverable, tagged), lossy compaction-summary top band (compaction-naive's prompt
  verbatim). Same spawn pattern (`runner.mjs` + the committed `triptych-sdk.mjs` bundle, emitted by the
  same build script); its tree-sitter wasm engine needs a one-time `npm install` in `ws/triptych/`.

Each conductor's own README covers its design in detail — start there for anything beyond a
one-line orientation.

## Readiness versus degradation

The extension advertises every conductor with host-computed readiness for its **required** startup
capabilities. Unavailable entries stay visible but disabled in the picker, with a reason and a safe
manual remediation; selection rechecks the same readiness host-side before disturbing the current
conductor.

Thermocline is the reference boundary: its Node runner is dependency-free, and a missing Python
attention probe still leaves its tested age-based policy fallback operational. Probe failure is
therefore runtime degradation reported through conductor status, not catalog unavailability.
Triptych's tree-sitter packages enable its defining skeletonization behavior, so failure to resolve
either package makes Triptych unavailable until its nested `npm install` has been run. Resolution is
the generic catalog gate; Triptych adds a runner-side preflight that initializes its parser and every
grammar before connecting, catching corrupt or incompatible installs without weakening the generic
registry contract.
