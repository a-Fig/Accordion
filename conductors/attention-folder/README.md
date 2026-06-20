# attention-folder

An attention-based, periodic conductor for Accordion. A small LM probe
(Qwen2.5-0.5B-Instruct in `probe/`) scores how much the current work tail attends back
to each earlier block ("structural gravity"); the conductor folds the least-attended
blocks when the context fills up. Unlike per-turn folders, it holds a **stable fold set**
inside a hysteresis band and changes it only at deliberate "epochs" — so the model's
inference prompt cache stays warm between folds and you avoid the ~10x cache-miss cost of
rewriting the prefix on every turn.

See [docs/adr/0010-attention-conductor.md](../../docs/adr/0010-attention-conductor.md)
for the full design rationale. The wire topology mirrors
[`recency-folder/`](../recency-folder/) — this process hosts the WebSocket server and
Accordion dials in as a client.

## Setup

**Prerequisites:** Node.js (the WS server), Python 3.10+, and an NVIDIA GPU. CPU
fallback works but scoring will be slow (~1–3 min/session versus 8–18 s on GPU).

**Install Python deps.** The probe requires a local venv under `probe/.venv/`:

```bash
cd conductors/attention-folder

# 1. Create the venv
python -m venv probe/.venv

# 2. Install the cu121 PyTorch wheel FIRST (see probe/requirements.txt header)
probe/.venv/Scripts/python.exe -m pip install torch==2.5.1+cu121 \
  --index-url https://download.pytorch.org/whl/cu121
# (Linux/macOS: probe/.venv/bin/python -m pip install ...)

# 3. Install the remaining deps from PyPI
probe/.venv/Scripts/python.exe -m pip install -r probe/requirements.txt
```

The probe downloads `Qwen/Qwen2.5-0.5B-Instruct` from Hugging Face on first run
(~1 GB). Set `HF_HOME` if you want to control the cache location.

**Install Node deps:**

```bash
npm install
```

## Running

```bash
npm start
# or: node attention-folder.mjs
```

The conductor listens on `ws://127.0.0.1:7701` and writes a heartbeat file at
`~/.accordion/conductors/attention-folder.json`. Open the Accordion **desktop app**
(not the browser dev server — live discovery requires the native layer), load a session,
and pick **Attention folder** from the conductor dropdown in the map header. Selection is
global; it applies to whatever session is currently active.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `ATTN_PORT` | `7701` | WebSocket port (recency-folder uses 7700) |
| `ATTN_HIGH_WATER` | `0.9` | Fold epoch triggers above this fraction of the context window |
| `ATTN_LOW_WATER` | `0.7` | Epoch folds down to roughly this fraction |
| `ATTN_WARM_WATER` | `0.8` | Background scoring starts pre-warming at this fraction |
| `ATTN_PROBE_PYTHON` | *(auto)* | Path to the Python interpreter; overrides venv auto-detect |
| `ATTN_PROBE_SCRIPT` | `probe/probe.py` | Path to the probe script |

The auto-detect order for Python: `$ATTN_PROBE_PYTHON` → `probe/.venv/Scripts/python.exe`
(Windows) → `probe/.venv/bin/python` (Linux/macOS) → bare `python` on PATH.

## Tests

Unit tests for the pure fold policy and a GPU-free wire smoke test both run with Node's
built-in test runner — no GPU, no Python, no extra deps:

```bash
node --test
```

The smoke test stubs the probe by pointing `ATTN_PROBE_PYTHON` to a non-existent path,
so `scoreCandidates` rejects immediately and the policy's FOLD_RANK fallback folds
instead. Both test files (`policy.test.mjs` and `smoke.test.mjs`) are discovered
automatically by `node --test`.

## How the periodic band works

The conductor tracks rendered context fullness as a fraction of the model's context
window. While fullness stays **below 90 %**, the conductor sends **nothing** — the host
keeps the last applied fold set untouched and new blocks append live at the tail without
disturbing the folded prefix. When fullness **crosses 90 %**, the conductor runs one
epoch: it expands the fold set by folding the lowest-attention blocks (or, if scores
aren't ready yet, the lowest-priority kinds by FOLD_RANK: `tool_result → thinking →
text`) until fullness drops back to roughly 70 %. After the epoch, the prefix is stable
again until the context refills. The fold set only ever grows (monotonic); a block once
folded stays folded unless a human or the agent explicitly restores it.

Background scoring fires when fullness crosses 80 % (the warm threshold), so fresh
attention scores are typically ready before the 90 % epoch triggers. The probe runs as an
async child process and never stalls the hold/epoch reply path.

For the full design — including the probe's attention readout recipe, the anchor
calibration, the graceful-degradation fallback, and the honest list of limitations —
see [ADR 0010](../../docs/adr/0010-attention-conductor.md).
