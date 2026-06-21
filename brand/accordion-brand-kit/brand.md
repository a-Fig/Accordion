# Accordion — Brand Spec

> Machine-readable brand specification. Paste this file into Claude/GPT (or hand it to a
> designer/developer) to produce on-brand work. Identity: **Spectrum**.

---

## Quick reference

| | |
|---|---|
| **Name** | Accordion |
| **Tagline** | Your session, intact. |
| **One-liner** | Accordion makes long AI sessions durable — context is folded, not deleted, and every fold is reversible. |
| **Primary color** | Ink `#0A0A0A` (everything else is the monochrome ramp + the 4-color spectrum) |
| **Display + body font** | IBM Plex Sans |
| **Data font** | IBM Plex Mono |
| **Voice** | Grounded, direct, calm, confident, practical |
| **Logo** | Accordion-bellows "A" mark + ACCORDION wordmark |

---

## Positioning

Accordion exists because long AI sessions break. Hours into a debugging, research, or agent
session, a critical piece of context falls out of the window — the agent forgets a requirement
from the first message, and progress stalls. The common fix (silently summarize and discard old
turns) trades one kind of loss for another.

Accordion takes a different path: older context is **folded**, not deleted. It leaves the model's
active view without leaving the session. Every fold is reversible; every block is recoverable. The
wedge competitors can't claim: **nothing is lost.**

### Audience segments
- **Primary:** Programmers and heavy AI-chat users running hours-long coding, agent, and research sessions who need to manage a finite context window.
- **Secondary:** AI and agent engineers building products who need explicit, inspectable control over what the model can and can't see.
- **Anchor persona — "Three hours in":** a developer deep in a Claude Code / Cursor session who can't afford to lose the constraint they set in message one.

### Reference brands (borrow this)
- **Linear** — keyboard-first restraint; product-as-hero.
- **Vercel / Geist** — mono-meets-sans engineering rigor.
- **Raycast** — dark UI with a confident accent.
- **xAI** — stark, technical, near-monochrome calm.

---

## Foundation

**Mission:** Keep work alive across the length of a session — so progress never stalls because the agent forgot.

**Values**
1. **Durability** — Work should survive. Sessions are persistent, not disposable.
2. **Clarity** — No hidden behavior. You can always see what is folded, what is visible, and what the model currently holds.
3. **Trust** — Folding changes visibility, not ownership. The information remains available.

**Story.** You were three hours into a debugging session. The agent forgot the constraint from the
first message, and the work slowed to a crawl. That shouldn't happen. Accordion folds older context
instead of deleting it — recessed, reversible, never gone — and the colors of the context window fold
together into one continuous spectrum. The session continues.

---

## Voice & tone

**Adjectives:** Grounded · Direct · Calm · Confident · Practical.
We speak like an experienced engineer explaining a system to another engineer. We understand the
frustration of context loss but never dramatize it. We earn trust through clarity, not hype.

**Copy examples**
- Headline — "Fold context. Keep momentum."
- Body — "The fold is reversible. The information is still there — it just isn't in the model's active view."
- Button — "Fold older context" / "Unfold"
- Error — "Couldn't reach the session. Your folds are saved — nothing was lost. Retry when ready."

**Forbidden words:** powerful, seamless, leverage, AI-powered, intelligent, streamlined.
Replace marketing language with observable facts. If a claim can't be seen in the interface, cut it.

---

## Color

Monochrome base carries everything; the four **spectrum** colors are semantic — each names a block
kind in the product (and together they form the brand gradient). Never set body text in a spectrum
hue, and never pair two spectrum hues as foreground/background. Maintain 4.5:1 contrast for body copy.

| Token | Hex | RGB | CMYK (approx) | Role |
|---|---|---|---|---|
| Ink | `#0A0A0A` | 10, 10, 10 | 0,0,0,96 | Primary text, logo |
| Charcoal | `#1C1C1C` | 28, 28, 28 | 0,0,0,89 | Dark surfaces, hero |
| Slate | `#4A4A4A` | 74, 74, 74 | 0,0,0,71 | Secondary text |
| Smoke | `#9A9A9A` | 154, 154, 154 | 0,0,0,40 | Labels, metadata, fold states |
| Cloud | `#E8E8E8` | 232, 232, 232 | 0,0,0,9 | Borders, dividers |
| Paper | `#F6F6F6` | 246, 246, 246 | 0,0,0,4 | Background surfaces |
| White | `#FFFFFF` | 255, 255, 255 | 0,0,0,0 | Base canvas |
| User | `#044EFF` | 4, 78, 255 | 98,69,0,0 | Block kind: user message |
| Thinking | `#B480DF` | 180, 128, 223 | 19,43,0,13 | Block kind: thinking |
| Tool call | `#21D4C1` | 33, 212, 193 | 84,0,9,17 | Block kind: tool call |
| Tool result | `#E19C7D` | 225, 156, 125 | 0,31,44,12 | Block kind: tool result |

**Spectrum gradient:** `linear-gradient(90deg,#21D4C1 0%,#1AA6E8 30%,#044EFF 48%,#7D6EE6 64%,#B480DF 78%,#E19C7D 100%)`
Used as a soft, blended field over Ink (the "folded context" made visible). Keep it smoky, never a hard rainbow bar.

---

## Typography

- **IBM Plex Sans** — display + body. H1 46px/600/-2% tracking · H2 26px/600 · H3 22px/600 · Body 15px/400/1.6 (min 13px) · Caption 11px.
- **IBM Plex Mono** — data only: token counts, fold identifiers, context metrics, labels. Use sparingly; it signals data, not decoration.
- Google Fonts: `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap`

---

## Logo

- **Symbol** — an accordion-bellows that doubles as the letter **A**: the instrument that folds, then reopens. Monochrome. Works 16px → 512px. Master art is **raster PNG** (transparent).
- **Wordmark** — "Accordion" set in **IBM Plex Sans Bold**.
- **Primary lockup** — symbol + ACCORDION, horizontal, balanced (neither element dominates).
- **App-icon / sticker tile** — the spectrum gradient on Ink with the white symbol centered, generous corner radius. The wordmark never appears inside the tile.
- **Clear space** — one full bellows-width around the lockup. **Never** stretch, rotate, recolor, shadow, or place on a low-contrast ground.

**Files** (`logo/`)
- `symbol/symbol-black.png` · `symbol/symbol-white.png` · `symbol/symbol-spectrum.png` (+ `.pdf` wrappers)
- `wordmark/wordmark-black.png` · `wordmark/wordmark-white.png`
- `lockup/horizontal/lockup-h-black.png` · `lockup/horizontal/lockup-h-white.png` (+ `.pdf` wrappers)

> Note: the symbol/lockup masters are PNG (the brand's existing art), not vector. The wordmark is type-set in IBM Plex Sans Bold and can be regenerated at any size.

---

## Photography

Real work, not productivity theater.
- **Subject:** late-night terminals, real desks, hands on keyboards, research in progress.
- **Light:** practical only — monitor glow, desk lamps, window light; natural shadows.
- **Color:** near-monochrome rooms; let the screen's spectrum glow be the only color.
- **Cast:** racially diverse, varied body types; subjects looking at the work, not the camera.
- **Texture:** film grain always; slight imperfection; found, not staged.
- **Never:** stock smiles, teams pointing at monitors, handshakes, neon cyberpunk, AI-smooth surfaces.

## Visual world
The unglamorous craft of long sessions — documentary, low-key, the screen the only source of color.

## Touchpoints
Desktop app on a real desk; the app on a phone; the developer's desk flat-lay; the mark as a die-cut sticker. On-screen UI shows the colored-block context grid.

---

## Do & Don't

**Do**
- Say what the interface does — "folded, not deleted," "reversible," "recoverable."
- Let the screen's spectrum be the only color; keep everything else Ink and Paper.
- Reserve each hue for its block kind — blue is the user, never a button.
- Show real product screenshots before any illustration.
- Give the wordmark a full bellows-width of clear space.

**Don't**
- Use hype ("powerful," "seamless," "intelligent," "streamlined").
- Recolor, rotate, stretch, or shadow the mark.
- Set body text in a spectrum hue or pair two hues as fg/bg.
- Dramatize context loss or imply anything was deleted.
- Crop the tagline mid-word or split "Your session, intact."

---

## How to use this spec
- **With AI tools:** paste `prompts/system-prompt.md` at the top of a thread, then a task starter from `prompts/`.
- **Developers:** import `tokens/tokens.css` (or `.json` / the Tailwind snippet) and the SVGs in `icons/`.
- **Designers:** fonts in `fonts/`, logos in `logo/`, full visual reference in `brand-guidelines.pdf`.
- **Favicon →** `logo/symbol/symbol-black.png` (light) / `symbol-white.png` (dark). **App icon →** `symbol-spectrum.png`. **Web header →** a lockup PNG. **Print →** the `.pdf` wrappers.
