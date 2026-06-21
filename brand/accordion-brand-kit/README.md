# Accordion Brand Kit

Everything you need to produce on-brand Accordion work — in Claude/GPT, Figma, or code.

## What's in here

```
brand.md                  # the full machine-readable spec — start here
brand-guidelines.pdf      # the 15-page visual brand book
logo/                     # symbol, wordmark, lockup (PNG + PDF; color variants)
icons/                    # 12 UI icons as SVG (stroke="currentColor")
fonts/                    # IBM Plex Sans + IBM Plex Mono (OFL) + install guide
tokens/                   # design tokens: tokens.css, tokens.json, tailwind snippet
prompts/                  # paste-ready AI prompts for copy + imagery
```

## How to use it

**Generate on-brand copy or images with AI**
1. Paste `prompts/system-prompt.md` at the top of a new Claude/GPT thread.
2. Add a task starter — `tweet.md`, `landing-hero.md`, `email.md`, `error-message.md`, or `photography.md`.
3. Fill in the `Task:` line.

**Build a website / app**
- Import `tokens/tokens.css` and reference `var(--color-ink)`, `var(--font-sans)`, `var(--gradient-spectrum)`, etc.
- Tailwind users: paste `tokens/tailwind.config.snippet.js` into `theme.extend`.
- Drop the SVGs from `icons/` inline; they inherit text color via `stroke="currentColor"`.

**Which logo file?**
- Favicon → `logo/symbol/symbol-black.png` (on light) or `symbol-white.png` (on dark)
- App icon → `logo/symbol/symbol-spectrum.png`
- Web header / docs → `logo/lockup/horizontal/lockup-h-*.png`
- Print / vector workflows → the `.pdf` wrappers in each logo folder

**Fonts**
- Install the `.ttf` files in `fonts/`, or load from Google Fonts (URL in `fonts/README.md`). Both are OFL — free to embed and redistribute.

## The one rule to remember
The four spectrum colors are **semantic** — each names a block kind (blue = user, purple = thinking,
teal = tool call, orange = tool result). Use them for that, and for the brand gradient. Everything
else stays in the Ink→Paper grayscale. **Nothing is ever "deleted" — only folded.**
