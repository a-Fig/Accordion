---
name: accordion-context-folding
description: "Read this skill if you see {#<code> FOLDED} markers in your context (e.g. {#3f9a FOLDED}), or if earlier parts of your context look summarized. Accordion is a desktop tool that may compact older context blocks to keep you under a token budget. The unfold tool lets you restore any folded block by its code."
---

Accordion, an external desktop app, may be folding parts of your context to keep token usage within a budget. This is opt-in and controlled by the human — you cannot disable it, but you can always pull specific blocks back.

## What folding looks like

A folded block appears as:

```
{#3f9a FOLDED} Assistant analyzed the test failures: three imports were missing…
```

The `3f9a` is a short **fold code** — an opaque handle for that block. The part after `FOLDED}` is a short summary. The original content is preserved and retrievable — nothing is lost.

## Restoring folded content

Call the `unfold` tool with one or more codes copied from the markers:

```
unfold({ids: ["3f9a"]})
unfold({ids: ["3f9a", "0a2c"]})
```

(Pass the codes as strings. A purely numeric code like `3133` may be passed as a number.)

The tool returns a confirmation. The restored content appears in your context **on your next turn** — not immediately. If you need the content now, call `unfold` and then take another step (e.g. re-read, continue the task) so the next turn picks it up.

## What to unfold

Only unfold what you genuinely need. Agent unfolds are sticky — the human can see and re-fold them in the GUI, but they will not be auto-refolded while you work. Unfolding costs tokens; if the budget is tight, Accordion may fold other blocks to compensate.

If a block looks irrelevant to your current task, leave it folded. If you need the exact content (code, a specific value, a previous decision), unfold it. If a code matches more than one block (rare), all matching blocks are restored.
