#!/usr/bin/env python
"""
probe.py — the Sentinel-style attention relevance probe (scorer id "attn", v1).

A small instruction model (Qwen2.5-0.5B-Instruct) reads a window of
[earlier blocks] + [current work tail] and we read out how much attention the
final readout token pays to each earlier block's token span. VATP-corrected
(attention weight x value L1 norm), attention-sinks zeroed, anchor-calibrated.

CLI:
    python probe.py --in <input.json> --out <output.json>
                    [--device cuda|cpu] [--window 2048]
                    [--batch N] [--attn-impl eager|sdpa]

Input  JSON: { "tail": "<query text>",
               "blocks": [{"id": "...", "text": "..."}, ...] }
Output JSON: { "scores": {"<blockId>": <float>},
               "meta": {"model","device","wallMs","windows","params"} }

The recipe is documented inline; deviations are recorded in meta.params.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time

import torch

# --------------------------------------------------------------------------
# Constants from the research memo / Qwen2.5-0.5B-Instruct architecture.
# --------------------------------------------------------------------------
MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
NUM_LAYERS = 24
PROBE_LAYERS = list(range(18, 24))   # decoder layers 18..23 (last quarter)
NUM_Q_HEADS = 14
NUM_KV_HEADS = 2
GQA_GROUP = NUM_Q_HEADS // NUM_KV_HEADS  # 7: heads 0..6 -> KV0, 7..13 -> KV1
HEAD_DIM = 64
SINK_POSITIONS = 2                    # zero attention to positions 0..1

# Token budgets (memo).
DEFAULT_WINDOW = 2048
TAIL_TOK_BUDGET = 700                 # tail truncated KEEPING THE NEWEST text
INSTRUCTION_TOK_EST = 24             # reserve for the trailing instruction
BLOCK_TOK_CAP = 400                  # per-block cap (head 300 + tail 100)
BLOCK_HEAD_TOK = 300
BLOCK_TAIL_TOK = 100
ANCHOR_ID = "__anchor__"
# A neutral, ~25-token calibration anchor present in EVERY window. Same position
# class as a context block; divides out per-window competition differences.
ANCHOR_TEXT = (
    "This is a short neutral placeholder section containing no specific "
    "information of any kind, included only as a fixed reference point."
)

SEP_TAIL = "\n\n=== CURRENT WORK ===\n"
INSTRUCTION = (
    "\nWhich earlier sections are most relevant to the current work? Answer:"
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Tokenization helpers — pieces tokenized separately and concatenated so each
# block's token span [s, e) in the final input_ids is exact.
# --------------------------------------------------------------------------
def encode(tokenizer, text: str) -> list[int]:
    """Encode without special tokens (we assemble the prompt ourselves)."""
    return tokenizer.encode(text, add_special_tokens=False)


def truncate_tail(tokenizer, tail: str, budget: int) -> str:
    """Truncate the tail KEEPING THE NEWEST text (drop from the front)."""
    ids = encode(tokenizer, tail)
    if len(ids) <= budget:
        return tail
    kept = ids[len(ids) - budget:]
    return tokenizer.decode(kept)


def cap_block(tokenizer, text: str, cap: int, head: int, tail: int) -> str:
    """Cap a block's text at `cap` tokens: head N + tail M when longer."""
    ids = encode(tokenizer, text)
    if len(ids) <= cap:
        return text
    head_ids = ids[:head]
    tail_ids = ids[len(ids) - tail:]
    return tokenizer.decode(head_ids) + " … " + tokenizer.decode(tail_ids)


# --------------------------------------------------------------------------
# Window assembly. Each window is a single user chat message:
#   [block_1] … [block_k]   (each prefixed "[id]\n")
#   \n\n=== CURRENT WORK ===\n  + tail
#   \nWhich earlier sections are most relevant to the current work? Answer:
# rendered through the chat template, then we read attention from the FINAL
# token. The anchor is included in every window as one of the blocks.
# --------------------------------------------------------------------------
def chat_prefix_suffix(tokenizer) -> tuple[list[int], list[int]]:
    """
    Token ids that the chat template wraps a single user message in, split into
    the part BEFORE the user content and the part AFTER. We render a sentinel,
    then slice on it, so block spans land inside the user-content region.
    """
    sentinel = "SENTINEL"
    rendered = tokenizer.apply_chat_template(
        [{"role": "user", "content": sentinel}],
        tokenize=False,
        add_generation_prompt=True,
    )
    pre_text, post_text = rendered.split(sentinel)
    pre_ids = encode(tokenizer, pre_text)
    post_ids = encode(tokenizer, post_text)
    return pre_ids, post_ids


def assemble_windows(tokenizer, tail: str, blocks: list[dict], window: int):
    """
    Greedily pack blocks into windows under the token budget. Yields dicts:
        { "input_ids": [int], "spans": {block_id: (s, e)}, "n_blocks": k }
    The anchor block is injected into every window.
    """
    pre_ids, post_ids = chat_prefix_suffix(tokenizer)

    tail_text = truncate_tail(tokenizer, tail, TAIL_TOK_BUDGET)
    tail_segment = SEP_TAIL + tail_text + INSTRUCTION
    tail_ids = encode(tokenizer, tail_segment)

    # Fixed overhead present in every window.
    fixed = len(pre_ids) + len(post_ids) + len(tail_ids)

    # Pre-encode the anchor as a block piece.
    anchor_piece = "[" + ANCHOR_ID + "]\n" + ANCHOR_TEXT + "\n"
    anchor_ids = encode(tokenizer, anchor_piece)

    # Per-window block budget after fixed overhead + anchor.
    block_budget = window - fixed - len(anchor_ids)
    if block_budget < 50:
        # Window too small even for the scaffolding — degrade gracefully.
        block_budget = max(50, window // 4)

    # Pre-cap and pre-encode every block once.
    encoded_blocks = []
    for b in blocks:
        capped = cap_block(
            tokenizer, b["text"], BLOCK_TOK_CAP, BLOCK_HEAD_TOK, BLOCK_TAIL_TOK
        )
        piece = "[" + str(b["id"]) + "]\n" + capped + "\n"
        ids = encode(tokenizer, piece)
        encoded_blocks.append((b["id"], ids))

    i = 0
    n = len(encoded_blocks)
    while i < n:
        used = 0
        members = []  # (block_id, ids)
        while i < n:
            bid, ids = encoded_blocks[i]
            # Hard cap a single oversized block to the whole block budget.
            if len(ids) > block_budget:
                ids = ids[:block_budget]
            if members and used + len(ids) > block_budget:
                break
            members.append((bid, ids))
            used += len(ids)
            i += 1
            if used >= block_budget:
                break

        if not members:
            i += 1
            continue

        # Build the window: pre_ids + [block pieces + anchor] + tail_ids + post_ids
        input_ids: list[int] = []
        input_ids.extend(pre_ids)
        spans: dict[str, tuple[int, int]] = {}

        for bid, ids in members:
            s = len(input_ids)
            input_ids.extend(ids)
            spans[bid] = (s, len(input_ids))

        # CAVEAT(M1): The anchor is placed in a fixed slot adjacent to the tail
        # in every window (always last among the content blocks). A reviewer flagged
        # position bias; we are deliberately NOT changing it this cut because:
        # (a) within a window, dividing by the anchor is a monotone transform —
        #     within-window ranking is unaffected by the anchor's absolute score;
        # (b) the anchor's position is constant across ALL windows, so the positional
        #     component is a constant — exactly what a calibration constant wants;
        # (c) the residual risk is content-competition: windows with many strong blocks
        #     will deflate the anchor score, which in turn inflates calibrated scores
        #     for those windows. Acceptable this cut; revisit if cross-window
        #     score distributions show systematic window-size bias.
        s = len(input_ids)
        input_ids.extend(anchor_ids)
        spans[ANCHOR_ID] = (s, len(input_ids))

        input_ids.extend(tail_ids)
        input_ids.extend(post_ids)

        yield {"input_ids": input_ids, "spans": spans, "n_blocks": len(members)}


# --------------------------------------------------------------------------
# Attention readout via forward hooks on layers 18..23.
#
# We capture each target self_attn module's `hidden_states` and
# `position_embeddings` with a forward_pre_hook, then recompute the LAST query
# row against all keys ourselves — exact, and avoids materializing 24x[1,14,N,N]
# attention tensors. We also recompute the value vectors for the VATP norm.
# --------------------------------------------------------------------------
class LayerCapture:
    def __init__(self):
        self.store: dict[int, dict] = {}

    def make_hook(self, layer_idx: int):
        def pre_hook(module, args, kwargs):
            # forward(self, hidden_states, position_embeddings, attention_mask, ...)
            hs = kwargs.get("hidden_states", args[0] if len(args) > 0 else None)
            pe = kwargs.get(
                "position_embeddings", args[1] if len(args) > 1 else None
            )
            self.store[layer_idx] = {
                "hidden_states": hs,
                "position_embeddings": pe,
                "module": module,
            }
            return None

        return pre_hook


def last_token_block_attention(capture: LayerCapture, scaling: float, n: int):
    """
    For each captured layer, compute the VATP-corrected, sink-zeroed,
    renormalized attention from the FINAL token to every context position,
    averaged over query heads. Returns a [num_layers, n] tensor (one row per
    probed layer) of per-position relevance mass.

    `row` selects which batch element of the captured tensors to read; `n` is
    that element's REAL length (positions [0, n) — padding excluded). For the
    eager single-window path row=0 and n is the full length. For the batched
    path row=b and n=len_b, and the captured tensors are sliced to [1, n, ...]
    BEFORE projection so right-padding never enters the q/k/v/rotary math — the
    recomputed readout is then identical in form to the unbatched case.
    """
    from transformers.models.qwen2.modeling_qwen2 import (
        apply_rotary_pos_emb,
        repeat_kv,
    )

    rows = []
    for layer_idx in PROBE_LAYERS:
        cap = capture.store.get(layer_idx)
        if cap is None:
            continue
        module = cap["module"]
        hs_full = cap["hidden_states"]              # [B, maxlen, hidden]
        cos_full, sin_full = cap["position_embeddings"]

        row = cap.get("row", 0)
        # Slice this window's REAL span out of the (possibly padded, possibly
        # batched) captured tensors → [1, n, ...]. Right-padding is causally
        # safe, so real-token hidden states match the unbatched forward.
        hs = hs_full[row:row + 1, :n, :]            # [1, n, hidden]
        # position_embeddings are computed once for positions 0..maxlen-1 and
        # broadcast over the batch (cos/sin carry batch-dim 1), so they are
        # identical for every right-padded row — index batch 0, not `row`.
        cos = cos_full[0:1, :n, :]                  # [1, n, head_dim]
        sin = sin_full[0:1, :n, :]                  # [1, n, head_dim]

        # Project q/k/v exactly as the layer does.
        hidden_shape = (1, n, -1, HEAD_DIM)
        q = module.q_proj(hs).view(hidden_shape).transpose(1, 2)  # [1,14,n,64]
        k = module.k_proj(hs).view(hidden_shape).transpose(1, 2)  # [1, 2,n,64]
        v = module.v_proj(hs).view(hidden_shape).transpose(1, 2)  # [1, 2,n,64]
        q, k = apply_rotary_pos_emb(q, k, cos, sin)

        # VATP value norms per KV head: L1 norm of each position's value vector.
        # v: [1, 2, n, 64] -> vnorm: [2, n]
        vnorm = v[0].abs().sum(dim=-1)  # [2, n]

        # Expand KV heads to all query heads for the score math.
        k_exp = repeat_kv(k, GQA_GROUP)  # [1,14,n,64]

        # Last-token query row only: [1,14,1,64].
        q_last = q[:, :, -1:, :]
        # scores: [1,14,1,n]
        scores = torch.matmul(q_last, k_exp.transpose(-1, -2)) * scaling
        scores = scores[0, :, 0, :].float()  # [14, n]

        # Causal: the last token attends to all positions (it IS the last), so
        # no future positions exist — no masking needed for the final row.
        attn = torch.softmax(scores, dim=-1)  # [14, n]

        # VATP correction: multiply each position by its value L1 norm, mapping
        # each query head -> its KV head group (0..6 -> KV0, 7..13 -> KV1).
        kv_index = torch.arange(NUM_Q_HEADS, device=attn.device) // GQA_GROUP
        vnorm_per_qhead = vnorm[kv_index].float()  # [14, n]
        attn = attn * vnorm_per_qhead

        # Zero the attention sinks (positions 0..1), then renormalize over the
        # remaining context.
        if n > SINK_POSITIONS:
            attn[:, :SINK_POSITIONS] = 0.0
        denom = attn.sum(dim=-1, keepdim=True)
        denom = torch.clamp(denom, min=1e-12)
        attn = attn / denom

        # Mean over query heads -> [n].
        rows.append(attn.mean(dim=0))

    if not rows:
        return None
    # Mean over layers -> [n].
    stacked = torch.stack(rows, dim=0)          # [num_layers, n]
    return stacked.mean(dim=0)                   # [n]


# --------------------------------------------------------------------------
# Per-window scoring.
# --------------------------------------------------------------------------
def score_window(model, device, win, scaling) -> dict[str, float]:
    input_ids = torch.tensor([win["input_ids"]], device=device)
    n = input_ids.shape[1]

    capture = LayerCapture()
    handles = []
    layers = model.model.layers
    for layer_idx in PROBE_LAYERS:
        h = layers[layer_idx].self_attn.register_forward_pre_hook(
            capture.make_hook(layer_idx), with_kwargs=True
        )
        handles.append(h)

    try:
        with torch.no_grad():
            model(input_ids=input_ids, use_cache=False)
        per_pos = last_token_block_attention(capture, scaling, n)
    finally:
        for h in handles:
            h.remove()

    if per_pos is None:
        return {}

    per_pos_cpu = per_pos.detach().to("cpu")

    # Block score = mean attention mass per token over the block's span.
    raw: dict[str, float] = {}
    for bid, (s, e) in win["spans"].items():
        if e <= s:
            raw[bid] = 0.0
            continue
        raw[bid] = float(per_pos_cpu[s:e].mean().item())

    # Anchor calibration: divide every block score by the anchor's score.
    anchor = raw.get(ANCHOR_ID, 0.0)
    out: dict[str, float] = {}
    if anchor > 1e-12:
        for bid, val in raw.items():
            if bid == ANCHOR_ID:
                continue
            out[bid] = val / anchor
    else:
        # Anchor underflowed — emit raw (still per-window comparable internally).
        for bid, val in raw.items():
            if bid == ANCHOR_ID:
                continue
            out[bid] = val

    # Free transient tensors.
    del input_ids, per_pos, per_pos_cpu, capture
    if device == "cuda":
        torch.cuda.empty_cache()

    return out


# --------------------------------------------------------------------------
# Batched scoring (FAST path).
#
# Same windows as the eager path (assemble_windows is untouched), but we run
# the model on up to N windows at once: right-pad input_ids to the batch max
# length and pass an attention_mask (1 real / 0 pad). Right-padding is causally
# safe — real tokens never attend to future padding — so each window's
# real-token hidden states match the unbatched forward (up to the eager-vs-sdpa
# numeric reduction-order difference, ~1e-3 in bf16).
#
# The readout is then the EXACT same per-window recipe (last_token_block_attention):
# for window b we slice the captured tensors to that row's real span [0, len_b)
# and recompute the last-real-token query against keys [0, len_b). No probe math
# changes — only HOW the forwards are batched/executed.
#
# EARLY-ABORT optimization: the probe only consumes the INPUT hidden_states of
# layers 18..23 (grabbed by the forward_pre_hooks) — never the output of the
# model past layer 23's input. So once the last probed layer's pre-hook has
# captured, we raise _StopForward to abort the rest of the forward (layer 23's
# attn/MLP, the final norm, and crucially the lm_head logits projection over the
# 151,936-token vocab). This is pure dead-compute removal — it changes nothing
# the probe reads — and it slashes both time (~1.25x) and peak VRAM (the
# [B, seq, vocab] logits were the memory hog), which lets us run a much larger
# batch under the VRAM cap. Disable with --no-early-abort to A/B it.
# --------------------------------------------------------------------------
class _StopForward(Exception):
    """Raised from the last probe layer's pre-hook to abort the rest of the
    forward once all probed hidden_states are captured."""


def _block_scores_from_per_pos(per_pos_cpu, spans) -> dict[str, float]:
    """Block-span mean + anchor calibration — identical to score_window."""
    raw: dict[str, float] = {}
    for bid, (s, e) in spans.items():
        if e <= s:
            raw[bid] = 0.0
            continue
        raw[bid] = float(per_pos_cpu[s:e].mean().item())

    anchor = raw.get(ANCHOR_ID, 0.0)
    out: dict[str, float] = {}
    if anchor > 1e-12:
        for bid, val in raw.items():
            if bid == ANCHOR_ID:
                continue
            out[bid] = val / anchor
    else:
        for bid, val in raw.items():
            if bid == ANCHOR_ID:
                continue
            out[bid] = val
    return out


def score_batch(model, device, batch, scaling, early_abort=True) -> dict[str, float]:
    """
    Score a list of windows in a single padded forward. Returns the merged
    per-block scores for all windows in the batch (each block lives in exactly
    one window, so a plain dict update is correct).

    Raises the usual OOM errors so the caller's ladder can halve N and retry.
    """
    lengths = [len(w["input_ids"]) for w in batch]
    maxlen = max(lengths)
    B = len(batch)

    pad_id = 0  # value is irrelevant: masked out + never read (sliced to [0,len))
    ids = torch.full((B, maxlen), pad_id, dtype=torch.long, device=device)
    mask = torch.zeros((B, maxlen), dtype=torch.long, device=device)
    for b, win in enumerate(batch):
        L = lengths[b]
        ids[b, :L] = torch.tensor(win["input_ids"], dtype=torch.long, device=device)
        mask[b, :L] = 1

    capture = LayerCapture()
    handles = []
    layers = model.model.layers
    for layer_idx in PROBE_LAYERS:
        h = layers[layer_idx].self_attn.register_forward_pre_hook(
            capture.make_hook(layer_idx), with_kwargs=True
        )
        handles.append(h)

    # Abort the forward right after the LAST probed layer captures its input.
    # Registered AFTER the capture hook on the same module, so it fires second.
    if early_abort:
        last_layer = max(PROBE_LAYERS)

        def _abort_hook(module, args, kwargs):
            raise _StopForward()

        handles.append(
            layers[last_layer].self_attn.register_forward_pre_hook(
                _abort_hook, with_kwargs=True
            )
        )

    try:
        with torch.no_grad():
            try:
                model(input_ids=ids, attention_mask=mask, use_cache=False)
            except _StopForward:
                pass  # expected: all probed hidden_states are captured

        merged: dict[str, float] = {}
        for b, win in enumerate(batch):
            n = lengths[b]
            # Tell the readout which batch row to slice; n = real length.
            for layer_idx in PROBE_LAYERS:
                if layer_idx in capture.store:
                    capture.store[layer_idx]["row"] = b
            per_pos = last_token_block_attention(capture, scaling, n)
            if per_pos is None:
                continue
            per_pos_cpu = per_pos.detach().to("cpu")
            merged.update(_block_scores_from_per_pos(per_pos_cpu, win["spans"]))
            del per_pos, per_pos_cpu
    finally:
        for h in handles:
            h.remove()

    del ids, mask, capture
    if device == "cuda":
        torch.cuda.empty_cache()

    return merged


# --------------------------------------------------------------------------
# Main.
# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--device", default=None, choices=["cuda", "cpu"])
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    # FAST path knobs. Defaults reproduce the original eager, one-window-at-a-time
    # behavior exactly.
    ap.add_argument(
        "--batch", type=int, default=1,
        help="windows per forward (N>1 enables the batched FAST path)",
    )
    ap.add_argument(
        "--attn-impl", dest="attn_impl", default="eager",
        choices=["eager", "sdpa"],
        help="model's internal attention backend (batched path uses sdpa)",
    )
    ap.add_argument(
        "--no-early-abort", dest="early_abort", action="store_false",
        help="(batched path) run the full forward incl. lm_head instead of "
             "aborting after the last probed layer captures (for A/B only)",
    )
    a = ap.parse_args()

    t_start = time.time()

    with open(a.inp, "r", encoding="utf-8") as f:
        data = json.load(f)
    tail = data.get("tail", "") or ""
    blocks = data.get("blocks", []) or []

    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    if device == "cuda" and not torch.cuda.is_available():
        log("[attn] CUDA requested but unavailable — falling back to CPU.")
        device = "cpu"

    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    log(f"[attn] loading {MODEL_ID} on {device} ({dtype})")

    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        attn_implementation=a.attn_impl,
    )
    model.to(device)
    model.eval()

    # scaling = 1/sqrt(head_dim), as the attention interface uses.
    scaling = getattr(model.model.layers[0].self_attn, "scaling", None)
    if scaling is None:
        scaling = 1.0 / math.sqrt(HEAD_DIM)

    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()

    # ----------------------------------------------------------------------
    # Score windows. Accumulate per-block scores; a block appears in exactly
    # one window, so no cross-window averaging is needed (each emitted once).
    # ----------------------------------------------------------------------
    scores: dict[str, float] = {}
    cur_window = a.window
    windows = list(assemble_windows(tokenizer, tail, blocks, cur_window))
    total = len(windows)
    log(
        f"[attn] {len(blocks)} blocks -> {total} windows (budget {cur_window})"
        + (f"  [FAST batch={a.batch} impl={a.attn_impl}]" if a.batch > 1 else "")
    )

    if a.batch > 1:
        # ------------------------------------------------------------------
        # FAST path: same windows, batched ≤N per forward. OOM ladder halves
        # the batch size and retries the failed batch (spirit of the eager
        # ladder: degrade, don't crash).
        #
        # Windows are sorted by length (descending) before chunking. Windows
        # are independent (each block lives in exactly one window; output is a
        # blockId->score dict, order-free), so this changes nothing the probe
        # computes — it only groups similar-length windows together so each
        # padded batch wastes minimal compute on padding, and puts the longest
        # (worst-case VRAM) batch FIRST so an OOM trips the ladder immediately.
        # ------------------------------------------------------------------
        windows = sorted(windows, key=lambda w: len(w["input_ids"]), reverse=True)
        bi = 0
        i = 0
        cur_batch = a.batch
        while i < len(windows):
            chunk = windows[i:i + cur_batch]
            bi += 1
            t0 = time.time()
            try:
                batch_scores = score_batch(
                    model, device, chunk, scaling, early_abort=a.early_abort
                )
            except torch.cuda.OutOfMemoryError:  # type: ignore[attr-defined]
                oom = True
            except MemoryError:
                oom = True
            except RuntimeError as _re:
                if not any(
                    phrase in str(_re).lower()
                    for phrase in ("out of memory", "not enough memory")
                ):
                    raise
                oom = True
            else:
                oom = False

            if oom:
                if device == "cuda":
                    torch.cuda.empty_cache()
                if cur_batch > 1:
                    cur_batch = max(1, cur_batch // 2)
                    log(
                        f"[attn] batch {bi}: OOM — halving batch to "
                        f"{cur_batch} and retrying"
                    )
                    bi -= 1
                    continue  # retry same i with smaller batch
                # cur_batch already 1 and still OOM — fall back to CPU for it.
                if device == "cuda":
                    log("[attn] OOM at batch=1 — moving model to CPU for remainder")
                    device = "cpu"
                    model.to(device)
                bi -= 1
                continue

            scores.update(batch_scores)
            i += len(chunk)
            dt = int((time.time() - t0) * 1000)
            maxtok = max(len(w["input_ids"]) for w in chunk)
            log(
                f"[attn] batch {bi}  windows={len(chunk)}  maxtok={maxtok}  "
                f"done {i}/{total}  {dt}ms"
            )

        total_windows_meta = total
        peak_vram = None
        if torch.cuda.is_available():
            peak_vram = int(torch.cuda.max_memory_allocated())
        wall_ms = int((time.time() - t_start) * 1000)
        meta = {
            "model": MODEL_ID,
            "device": device,
            "wallMs": wall_ms,
            "windows": total_windows_meta,
            "peakVramBytes": peak_vram,
            "params": {
                "probeLayers": PROBE_LAYERS,
                "window": a.window,
                "tailTokBudget": TAIL_TOK_BUDGET,
                "blockTokCap": BLOCK_TOK_CAP,
                "blockHeadTok": BLOCK_HEAD_TOK,
                "blockTailTok": BLOCK_TAIL_TOK,
                "sinkPositions": SINK_POSITIONS,
                "gqaGroup": GQA_GROUP,
                "vatp": True,
                "anchorCalibrated": True,
                "attnImpl": a.attn_impl,
                "batch": a.batch,
                "earlyAbort": a.early_abort,
                "readout": "last-token-row-recomputed-from-hooked-qkv",
                "dtype": str(dtype),
            },
        }
        with open(a.out, "w", encoding="utf-8") as f:
            json.dump({"scores": scores, "meta": meta}, f)
        log(f"[attn] done: {len(scores)} block scores in {wall_ms}ms")
        return 0

    wi = 0
    pending = list(enumerate(windows))
    while pending:
        idx, win = pending.pop(0)
        wi += 1
        n_tok = len(win["input_ids"])
        t0 = time.time()
        try:
            win_scores = score_window(model, device, win, scaling)
        except torch.cuda.OutOfMemoryError:  # type: ignore[attr-defined]
            oom = True
        except MemoryError:
            oom = True
        except RuntimeError as _re:
            if not any(
                phrase in str(_re).lower()
                for phrase in ("out of memory", "not enough memory")
            ):
                raise
            oom = True
        else:
            oom = False

        if oom:
            torch.cuda.empty_cache()
            cur_window = max(512, cur_window // 2)
            log(
                f"[attn] window {wi}/{total}: OOM — halving budget to "
                f"{cur_window} and re-splitting this block set"
            )
            if cur_window <= 512 and device == "cuda":
                # Persistent OOM at the floor: fall back to CPU for the rest.
                log("[attn] OOM persists at 512 — moving model to CPU for remainder")
                device = "cpu"
                model.to(device)
                scaling = scaling  # unchanged
            # Re-window only the blocks of THIS failed window and prepend them.
            sub_blocks = [
                {"id": bid, "text": next((b["text"] for b in blocks if b["id"] == bid), "")}
                for bid in win["spans"].keys()
                if bid != ANCHOR_ID
            ]
            requeued = list(assemble_windows(tokenizer, tail, sub_blocks, cur_window))
            pending = [(idx, w) for w in requeued] + pending
            total = wi + len(pending)
            continue

        scores.update(win_scores)
        dt = int((time.time() - t0) * 1000)
        log(
            f"[attn] window {wi}/{total}  tokens={n_tok}  blocks={win['n_blocks']}  "
            f"{dt}ms"
        )

    peak_vram = None
    if torch.cuda.is_available():
        peak_vram = int(torch.cuda.max_memory_allocated())

    wall_ms = int((time.time() - t_start) * 1000)

    meta = {
        "model": MODEL_ID,
        "device": device,
        "wallMs": wall_ms,
        "windows": total,
        "peakVramBytes": peak_vram,
        "params": {
            "probeLayers": PROBE_LAYERS,
            "window": a.window,
            "tailTokBudget": TAIL_TOK_BUDGET,
            "blockTokCap": BLOCK_TOK_CAP,
            "blockHeadTok": BLOCK_HEAD_TOK,
            "blockTailTok": BLOCK_TAIL_TOK,
            "sinkPositions": SINK_POSITIONS,
            "gqaGroup": GQA_GROUP,
            "vatp": True,
            "anchorCalibrated": True,
            "attnImpl": a.attn_impl,
            "readout": "last-token-row-recomputed-from-hooked-qkv",
            "dtype": str(dtype),
        },
    }

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"scores": scores, "meta": meta}, f)

    log(f"[attn] done: {len(scores)} block scores in {wall_ms}ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
