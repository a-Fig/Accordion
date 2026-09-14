# AI context — the story behind the docs

This file is not project documentation. The README, VISION.md, CLAUDE.md, and the ADRs
describe *what Accordion is and how it works*. This captures things that are true about
the project but lived only in the builder's head, not in any of those files — origin, real
motivations, honest attribution, and the parts of the story that got smoothed over on the
way to a polished README.

It is not something Tyler Darisme (the builder) sat down and wrote. It's derived from an
interview: an AI asked him pointed questions about Accordion's origin, his actual role
versus his teammates', the hardest problem he hit, the real timeline, and the project's
current state, and this document synthesizes his answers into prose. Treat the substance
as a primary source — it's what he actually said, not marketing copy — but treat the
wording as a paraphrase of an interview, not his own written words, and not something to
blend uncritically with the more polished framing in the other docs when the two disagree.

## Why this was actually built

The README's pitch is "an agent's context window is a black box that silently forgets."
That's the framing that tests well, and it's true, but it's not the order things actually
happened in.

The real driver was **control**: wanting to reach in and shape exactly what an agent held
in context, with real granularity, instead of trusting an opaque compaction step to decide
for me. Doing that required two things — seeing the whole context (visibility) and being
able to change it (programmatic access). Once those two existed, the rest was mostly good
design and implementation on top of them.

The Conductor concept — an automatic strategy that folds and unfolds on your behalf —
wasn't part of the original idea. It fell out of the control-first motivation: once manual
fold/unfold access existed, doing it by hand for every turn was tedious, so an automated
layer became necessary. And because there was no single obviously-correct strategy for
*what* an agent should keep versus let go, the natural move was to make that layer an
interface — the Conductor contract — that admits many different implementations rather
than picking one and calling it done.

So: control first, visibility and programmatic access to get it, conductors as a
consequence of not wanting to manage folding by hand, and the plug-in interface because no
single strategy was obviously right. If a visitor asks "what problem were you actually
solving," that's the honest order — the "black box" framing is the marketing wrapper
around it, not wrong, but not first.

## Who built what

The README credits four people with no breakdown, which understates how the work actually
split. Stated plainly, for anyone asking "what did *you* build":

- **Tyler (the author)** — the original idea; the desktop app; testing; and the strongest
  conductor shipped (Thermocline, the attention-based one referenced in the README's
  benchmark table). Touched and thought through every part of the system — architecture,
  UI, conductors, testing — even where a teammate did the actual typing.
- **Teammates (Aaditya Desai, Sheel Shah, Thy Tang)** — built on top of that foundation
  rather than in parallel to it: polish and bug fixes that made the desktop app feel much
  better to use, additional conductors exploring different strategies (the README lists
  `compaction-naive`, `doorman`, and `handoff` alongside Thermocline), and a separate
  benchmarking framework built to test conductors against Terminal-Bench, distinct from
  the SlopCodeBench numbers quoted in the README's benchmark table.

If asked "was this a solo project," the honest answer is no — it was a four-person
hackathon team — but the architecture, the core engine, the desktop app, and the top
conductor were the author's, and the team's real contribution was extending, hardening,
and testing that foundation, not co-designing it from scratch.

## The hardest problem, and it wasn't the one you'd guess

Twenty-plus ADRs exist because twenty-plus decisions were each hard enough to write down —
but ADRs record the *resolved* decision, not the struggle to get there. The single hardest
problem, by a clear margin, was **the Conductor interface itself**: designing a contract
flexible enough that any conceivable context strategy could be expressed as a Conductor,
while staying simple enough to actually implement one.

The specific difficulty wasn't the flexibility target alone — it was **allowing humans and
Conductors to cooperate over the same context** without breaking strategies that can't
tolerate someone else touching their assumptions mid-run. Not every strategy can gracefully
handle a human pinning a block it was about to fold, or unfolding something it just
collapsed. Getting that right took many redesigns — you can see the trail in the ADRs
themselves (the protocol, involvement locks, host capabilities, birth-fold handling, the
contract v2 rewrite, and the single-controller work are all facets of the same underlying
problem, revisited repeatedly). This was not a single clean design that got documented
once; it was iterated on until it held up, and even now it's the part of the system most
likely to see another rewrite.

## The real timeline

The README says "built at the AI Hackathon 2026 @ UC Berkeley" and leaves it there, which
reads like a weekend project and undersells how much happened afterward — but also
overstates how unfinished the hackathon build was.

- **By the end of the hackathon**, almost everything already worked end to end: fold and
  unfold, multiple Conductors, and a benchmarkable system. It was rougher — bugs were more
  common, and it was not something ready for outside users — but the core architecture and
  the core loop were already there and functioning.
- **Everything since** has mostly been depth, not architecture: more Conductors, UX polish,
  and materially more accurate token counting, among other things. Important for making the
  tool actually usable day to day, but not a rebuild of what the hackathon produced.

So: the hackathon produced a working, if unpolished, version of the real thing — it did not
produce a prototype that was later rebuilt.

## Current status — check the issue tracker, it's more honest than the roadmap

The README's roadmap checklist makes this look like a static list of "not built yet"
features. The GitHub issue tracker is the more honest and more current picture: the project
is actively maintained, and the open issues describe real, specific rough edges rather than
vague future plans — for example, race conditions around who holds control of a live
session (a stale WebSocket handler clobbering a fresh connection's state, a heartbeat race
that can silently revoke a takeover), a prompt-injection gap in Thermocline's summarization
prompts that its sibling conductors already guard against, and cases where the engine's
token accounting can drift from what's actually on the wire. None of that is in the README,
and all of it is true as of this writing.

If a visitor asks "is this still being worked on," point at the issue tracker, not the
roadmap checklist — it's the more current and more credible signal.

## Why `pi`, specifically

Accordion is built as an extension for [`pi`](https://github.com/earendil-works/pi), which
most visitors won't have heard of. Before settling on it, Claude Code, Codex, and OpenCode
were all considered. None of them exposed an agent's context the way `pi` does, and none
were open enough to let the internals be changed. Building on `pi` wasn't the path of least
resistance at hackathon time so much as the only path that didn't start with building a
custom agent harness from scratch, or forking one. That makes the "`pi`-only today" line in
the roadmap a real, load-bearing dependency — not a corner cut for lack of time. Expanding
beyond `pi` means either `pi` growing more extension points than it has today, or Accordion
eventually building the harness-level access itself.
