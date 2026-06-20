// relevance.mjs — embeddings, unified relevance, and task-summary upkeep.
//
// Unified relevance is the single score the tiering runs on:
//
//   r(block) = max( cos(emb(block), emb(goal)), cos(emb(block), emb(trajectory)) )
//
//   • goal       = the incoming prompt + a maintained task summary (the stable objective).
//                  Folding ranks against this.
//   • trajectory = the protected working tail (recent thinking + latest tool activity).
//                  Anticipatory unfold (float-up) ranks against this — "where the agent is heading".
//
// Embeddings run through Ollama by default (POST /api/embed) — no native onnx stack, GPU on
// Apple Silicon, same runtime as summaries. Model defaults to EmbeddingGemma (2048 ctx, 768d).
// Because 2048 < a big tool_result, large blocks are CHUNKED to ~EMBED_CHUNK_CHARS and the
// per-chunk vectors are MAX-POOLED in relevanceOf, so the back of a long result still counts.
// Set ACCORDION_EMBED_BACKEND=transformers to use the in-process @huggingface/transformers path.
// Warm() is async; relevanceOf() is synchronous (cache-only), falling back to keyword overlap.

import { textHash, keywordOverlap, categorizeSalienceMarkers, clip } from "./salience.mjs";
import { segmentForTrim, TRIM_MIN_TOKENS } from "./trim.mjs";

export const EMBED_BACKEND = process.env.ACCORDION_EMBED_BACKEND || "ollama"; // "ollama" | "transformers"
export const EMBEDDING_MODEL =
	process.env.ACCORDION_EMBEDDING_MODEL || (EMBED_BACKEND === "ollama" ? "embeddinggemma" : "nomic-ai/nomic-embed-text-v1.5");
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
// EmbeddingGemma caps at 2048 tokens; chunk big blocks to ~this many CHARS (≈1500 tokens, safe
// under the cap) and max-pool. Also bounds the trajectory query so it isn't itself truncated.
const EMBED_CHUNK_CHARS = Number(process.env.TIERS_EMBED_CHUNK_CHARS || 6_000);
const TAIL_TEXT_CAP = Number(process.env.TIERS_TAIL_CAP || EMBED_CHUNK_CHARS);
const MAX_RECENT_PROMPTS = 5;

/** Model-specific instruction prefix. EmbeddingGemma and nomic need different ones; others none. */
export function applyEmbedPrefix(model, text, isQuery) {
	if (/embeddinggemma|gemma/i.test(model)) {
		return isQuery ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
	}
	if (/nomic-embed-text/i.test(model)) {
		return `${isQuery ? "search_query" : "search_document"}: ${text}`;
	}
	return text;
}

function l2normalize(v) {
	let s = 0;
	for (const x of v) s += x * x;
	s = Math.sqrt(s) || 1;
	return v.map((x) => x / s);
}

/** Split text into ≤maxChars contiguous chunks on line boundaries (hard-splitting any single
 *  over-long line); one chunk for small texts. Deterministic so warm() and relevanceOf() derive
 *  the same cache keys. */
export function chunkText(text, maxChars = EMBED_CHUNK_CHARS) {
	const t = text || "";
	if (t.length <= maxChars) return t.trim() ? [t] : [];
	const chunks = [];
	let buf = "";
	const flush = () => { if (buf.trim()) chunks.push(buf); buf = ""; };
	for (const line of t.split("\n")) {
		if (line.length > maxChars) {
			flush();
			for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
			continue;
		}
		if (buf && buf.length + line.length + 1 > maxChars) flush();
		buf = buf ? buf + "\n" + line : line;
	}
	flush();
	return chunks;
}

/** Build an embed(texts, isQuery) => Promise<number[][]> provider for the configured backend. */
export async function createEmbeddingProvider(model = EMBEDDING_MODEL, backend = EMBED_BACKEND) {
	return backend === "transformers"
		? createTransformersEmbeddingProvider(model)
		: createOllamaEmbeddingProvider(model);
}

/** Ollama embeddings via POST /api/embed. Probes once at creation so a missing model /
 *  unreachable server fails clearly (→ server logs DISABLED) instead of erroring every warm. */
async function createOllamaEmbeddingProvider(model) {
	const url = `${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/embed`;
	const embed = async (texts, isQuery = false) => {
		const input = texts.map((t) => applyEmbedPrefix(model, t, isQuery));
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, input }),
		});
		if (!res.ok) throw new Error(`ollama embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
		const json = await res.json();
		const arr = json.embeddings || (json.embedding ? [json.embedding] : []);
		if (!arr.length) throw new Error("empty response");
		return arr.map(l2normalize); // normalize so dot() == cosine
	};
	try {
		await embed(["ok"], true); // reachability + model-present probe
	} catch (e) {
		throw new Error(`ollama embeddings unavailable (model "${model}"): ${e.message} — try \`ollama pull ${model}\``);
	}
	return embed;
}

/** Optional in-process backend via @huggingface/transformers (onnxruntime). */
async function createTransformersEmbeddingProvider(model) {
	let pipelineFactory;
	try {
		({ pipeline: pipelineFactory } = await import("@huggingface/transformers"));
	} catch (err) {
		if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find package")) {
			throw new Error("install @huggingface/transformers to use the transformers backend");
		}
		throw err;
	}
	let pipePromise = null;
	return async (texts, isQuery = false) => {
		pipePromise ??= pipelineFactory("feature-extraction", model);
		const pipe = await pipePromise;
		const out = [];
		for (const text of texts) {
			const res = await pipe(applyEmbedPrefix(model, text, isQuery), { pooling: "mean", normalize: true });
			out.push(Array.from(res.data));
		}
		return out;
	};
}

function dot(a, b) {
	let s = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) s += a[i] * b[i];
	return s;
}

/** Concatenate the protected working tail newest-first, capped — the trajectory source. */
export function tailText(blocks, cap = TAIL_TEXT_CAP) {
	let text = "";
	for (let i = blocks.length - 1; i >= 0 && text.length < cap; i--) {
		const b = blocks[i];
		if (!b.protected) break;
		if (b.text) text = b.text + "\n" + text;
	}
	return text.slice(0, cap);
}

export class RelevanceEngine {
	constructor({ embeddingProvider = null, summaryProvider = null, log = () => {}, embeddingModel = EMBEDDING_MODEL, onSemantic = null } = {}) {
		this.embed = embeddingProvider; // async (texts, isQuery) => vectors, or null
		this.summaryProvider = summaryProvider; // async ({prompt, context}) => string, or null
		this.log = log;
		this.embeddingModel = embeddingModel; // label only — which model relevance WOULD use
		this.onSemantic = onSemantic; // called once when embeddings first activate (forces L1 trim re-emit)
		this.everEmbedded = false; // flips true after the first successful embed (model is live)
		this.embedDim = 0; // vector dimension observed from the first embed
		this._loggedActive = false;
		this.cache = new Map(); // textHash → vector (docs); "q:"+hash → vector (queries)
		this.recentPrompts = []; // rolling user prompts (deterministic task summary)
		this.taskSummaryLLM = ""; // LLM-refreshed summary (preferred when present)
		this.lastSummarizedPrompt = "";
		this.summaryInFlight = false;
		this.goalText = "";
		this.trajText = "";
		this.embedInFlight = false;
	}

	/** Relevance mode for status/logging:
	 *  "keyword"  — no embedding provider (transformers missing/failed) → literal word overlap.
	 *  "loading"  — provider present but the model hasn't produced a vector yet (downloading/warming).
	 *  "semantic" — embeddings live; relevance is cosine over the embedding model. */
	get mode() {
		if (!this.embed) return "keyword";
		return this.everEmbedded ? "semantic" : "loading";
	}

	/** Record a newly-seen user prompt and (optionally) refresh the LLM task summary. */
	noteUserPrompt(prompt, blocks) {
		const p = (prompt || "").trim();
		if (!p) return;
		if (this.recentPrompts[this.recentPrompts.length - 1] !== p) {
			this.recentPrompts.push(p);
			if (this.recentPrompts.length > MAX_RECENT_PROMPTS) this.recentPrompts.shift();
		}
		// Set goal/traj synchronously so keyword relevance is prompt-aware on the FIRST re-tier
		// (before warm() runs). warm() overwrites with the same values + any LLM task-summary.
		this.goalText = `${p}\n${this.taskSummary(blocks)}`.trim();
		this.trajText = tailText(blocks);
		if (this.summaryProvider && p !== this.lastSummarizedPrompt && !this.summaryInFlight) {
			this.lastSummarizedPrompt = p;
			this.summaryInFlight = true;
			const context = tailText(blocks, 4000);
			Promise.resolve(this.summaryProvider({ prompt: p, context }))
				.then((s) => { if (s && s.trim()) this.taskSummaryLLM = s.trim(); })
				.catch((e) => this.log(`task-summary failed: ${e.message}`))
				.finally(() => { this.summaryInFlight = false; });
		}
	}

	/** Deterministic task summary: recent prompts + harvested decisions/exact-values. The
	 *  always-available floor; the LLM summary (when present) is preferred. */
	taskSummary(blocks) {
		if (this.taskSummaryLLM) return this.taskSummaryLLM;
		const decisions = [];
		const values = [];
		for (const b of blocks) {
			const c = categorizeSalienceMarkers(b.text || "");
			for (const d of c.decisions) if (decisions.length < 4 && !decisions.includes(d)) decisions.push(d);
			for (const v of c.exact_values) if (values.length < 6 && !values.includes(v)) values.push(v);
		}
		return [this.recentPrompts.join(" "), decisions.join("; "), values.join(" ")]
			.filter(Boolean).join("\n");
	}

	/** Async: embed the goal, the trajectory, and any not-yet-cached block texts (+ trim
	 *  segments for big blocks). Bounded; never throws. Sets goalText/trajText for fallback. */
	async warm(blocks, prompt, { timeoutMs = 20_000 } = {}) {
		this.goalText = `${(prompt || "").trim()}\n${this.taskSummary(blocks)}`.trim();
		this.trajText = tailText(blocks);
		if (!this.embed) return; // keyword-only mode

		const queryTexts = [];
		const queryKeys = [];
		for (const t of [this.goalText, this.trajText]) {
			if (!t.trim()) continue;
			const k = "q:" + textHash(t);
			if (!this.cache.has(k)) { queryTexts.push(t); queryKeys.push(k); }
		}
		const docTexts = [];
		const docKeys = [];
		const addDoc = (t) => {
			if (!t || !t.trim()) return;
			const k = textHash(t);
			if (!this.cache.has(k) && !docKeys.includes(k)) { docTexts.push(t); docKeys.push(k); }
		};
		for (const b of blocks) for (const ch of chunkText(b.text)) addDoc(ch); // chunk → max-pool
		for (const b of blocks) if (b.tokens >= TRIM_MIN_TOKENS) for (const seg of segmentForTrim(b.text)) addDoc(seg);

		if (!queryTexts.length && !docTexts.length) return;
		this.embedInFlight = true;
		const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error("embed timeout")), timeoutMs));
		try {
			if (queryTexts.length) {
				const qv = await Promise.race([this.embed(queryTexts, true), deadline]);
				queryKeys.forEach((k, i) => this.cache.set(k, qv[i]));
				if (qv[0]?.length) this.embedDim = qv[0].length;
			}
			if (docTexts.length) {
				const dv = await Promise.race([this.embed(docTexts, false), deadline]);
				docKeys.forEach((k, i) => this.cache.set(k, dv[i]));
				if (dv[0]?.length) this.embedDim = dv[0].length;
			}
			// First successful embed → the semantic path is now live. Log it once, loudly.
			// onSemantic() nulls lastSentSig so L1 trim excerpts (now query-aware rather than
			// keyword-quality) are re-sent on the post-warm recomputeAndSend.
			if (!this._loggedActive && this.embedDim > 0) {
				this._loggedActive = true;
				this.everEmbedded = true;
				this.log(`embeddings ACTIVE: ${this.embeddingModel} (${this.embedDim}d) — relevance is now SEMANTIC`);
				this.onSemantic?.();
			}
		} catch (e) {
			this.log(`embed warm incomplete: ${e.message}`);
		} finally {
			this.embedInFlight = false;
		}
	}

	/** True once we have vectors for both the block and at least one query — i.e. the
	 *  semantic path is live for this block (else relevanceOf falls back to keyword). */
	hasVectors(block) {
		const gv = this.cache.get("q:" + textHash(this.goalText));
		const tv = this.cache.get("q:" + textHash(this.trajText));
		if (!gv && !tv) return false;
		return chunkText(block.text).some((ch) => this.cache.has(textHash(ch)));
	}

	/** Whether the prompt+trajectory queries are embedded yet (gates "are we warm enough"). */
	queriesReady() {
		const gv = this.cache.get("q:" + textHash(this.goalText));
		const tv = this.cache.get("q:" + textHash(this.trajText));
		return !!gv || !!tv;
	}

	relevanceOf(block) {
		const gv = this.cache.get("q:" + textHash(this.goalText));
		const tv = this.cache.get("q:" + textHash(this.trajText));
		if (gv || tv) {
			// max-pool over the block's chunk vectors × {goal, trajectory}
			let best = -Infinity;
			let any = false;
			for (const ch of chunkText(block.text)) {
				const cv = this.cache.get(textHash(ch));
				if (!cv) continue;
				any = true;
				if (gv) best = Math.max(best, dot(cv, gv));
				if (tv) best = Math.max(best, dot(cv, tv));
			}
			if (any) return best;
		}
		// keyword fallback against goal + trajectory text
		return Math.max(
			keywordOverlap(block.text, this.goalText),
			keywordOverlap(block.text, this.trajText),
		);
	}

	/** Segment-level relevance for query-aware trim (cosine when cached, else keyword). */
	segmentRelevanceFn() {
		const gv = this.cache.get("q:" + textHash(this.goalText));
		return (segText) => {
			const sv = this.cache.get(textHash(segText));
			if (sv && gv) return dot(sv, gv);
			return keywordOverlap(segText, this.goalText);
		};
	}

	/** Drop cached vectors for texts no longer present (bounded memory over long sessions). */
	prune(blocks, max = 2000) {
		if (this.cache.size <= max) return;
		const keep = new Set(["q:" + textHash(this.goalText), "q:" + textHash(this.trajText)]);
		for (const b of blocks) {
			for (const ch of chunkText(b.text)) keep.add(textHash(ch));
			if (b.tokens >= TRIM_MIN_TOKENS) for (const seg of segmentForTrim(b.text)) keep.add(textHash(seg));
		}
		for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
	}
}
