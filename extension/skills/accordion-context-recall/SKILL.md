---
name: accordion-context-recall
description: "Read this skill when you need to read the full content of a folded context block RIGHT NOW as a tool result — without opening it in your standing context. Use recall(codes) when you only need a value once and do not want to permanently restore the block. Accordion may fold older parts of your context to keep token usage within a budget; folded blocks appear as {#<code> FOLDED} markers."
---

Accordion, an external desktop app, may be folding parts of your context to save tokens. A folded block appears as:

```
{#3f9a2c FOLDED} Assistant analyzed the test failures: three imports were missing…
```

The `3f9a2c` is a **fold code** — the short summary after `FOLDED}` is a digest. The original content is preserved and always retrievable.

## recall — read folded content this turn

Call `recall` with one or more codes copied verbatim from the markers:

```
recall({codes: ["3f9a2c"]})
recall({codes: ["3f9a2c", "00a2cd"]})
```

The full original content of each block comes back **as this tool's result, immediately** — like reading a file. Your standing context is **not changed**: the block stays folded, costs no extra tokens, and the human's view is untouched.

This is the right choice when:
- You need a specific value, piece of code, or detail **for the current step only**
- You don't want the block to permanently reopen (it stays folded for future turns)
- You're under a tight token budget and opening it permanently would trigger more folding

## When to use unfold instead

`unfold({codes: [...]})` forces the block **open in your standing context** — the full content appears on your **next turn** and stays open until the human re-folds it. Use `unfold` when you will keep referencing the block over several turns, not just once.

Summary:
- **recall** — read once, now. No context change. Content in the tool result this turn.
- **unfold** — keep it open. Content in your context next turn, stays open.

Prefer `recall` for one-off reads; use `unfold` only when repeated access justifies the token cost of keeping it open.
