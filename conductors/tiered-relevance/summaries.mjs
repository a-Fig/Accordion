// summaries.mjs — async LLM digests + task summary, with a deterministic floor.
//
// Two async LLM roles, both OFF the critical path and both with an instant fallback so a
// conduct pass never blocks:
//   1. L2 block digests — higher-fidelity summaries that replace the deterministic digest.
//   2. The relevance task summary — a compact "current objective" used to enrich the goal.
//
// Provider chain: local Ollama first (DEFAULT_OLLAMA_*), then Gemini if configured,
// then Anthropic if configured, then nothing (deterministic-only). Block summaries are cached by
// content hash; when one lands it is picked up on the next re-tier (digest upgrades in place).

import { textHash } from "./salience.mjs";

export const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_SUMMARY_MODEL || "llama3.2:3b";
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || "claude-haiku-4-5";
export const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
export const GEMINI_MODEL = process.env.GEMINI_SUMMARY_MODEL || "gemini-2.0-flash";
const SUMMARY_TIMEOUT_MS = Number(process.env.ACCORDION_SUMMARY_TIMEOUT_MS || 30_000);
const MAX_INPUT_CHARS = 4_000;
const MAX_CONCURRENCY = Number(process.env.TIERS_SUMMARY_CONCURRENCY || 2);

function withTimeout(ms) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(new Error(`timed out after ${ms}ms`)), ms);
	return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** OpenAI-compatible chat (Ollama exposes /v1/chat/completions). Returns text or null. */
function ollamaChat(baseUrl, model) {
	const root = baseUrl.replace(/\/$/, "");
	const url = /\/v\d+(?:\/|$)/.test(root) ? `${root}/chat/completions` : `${root}/v1/chat/completions`;
	return async ({ system, user }) => {
		const { signal, done } = withTimeout(SUMMARY_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				method: "POST",
				signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model, temperature: 0.1, max_tokens: 200, stream: false,
					messages: [{ role: "system", content: system }, { role: "user", content: user }],
				}),
			});
			if (!res.ok) throw new Error(`ollama ${res.status}`);
			const json = await res.json();
			const out = json?.choices?.[0]?.message?.content;
			return typeof out === "string" && out.trim() ? out.trim() : null;
		} finally { done(); }
	};
}

/** Gemini via its OpenAI-compatible endpoint (Bearer auth). Returns text or null. */
function geminiChat(apiKey, model) {
	const url = `${GEMINI_BASE_URL.replace(/\/$/, "")}/chat/completions`;
	return async ({ system, user }) => {
		const { signal, done } = withTimeout(SUMMARY_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				method: "POST",
				signal,
				headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({
					model, temperature: 0.1, max_tokens: 200, stream: false,
					messages: [{ role: "system", content: system }, { role: "user", content: user }],
				}),
			});
			if (!res.ok) throw new Error(`gemini ${res.status}`);
			const json = await res.json();
			const out = json?.choices?.[0]?.message?.content;
			return typeof out === "string" && out.trim() ? out.trim() : null;
		} finally { done(); }
	};
}

/** Anthropic Messages API. Returns text or null. */
function anthropicChat(apiKey, model) {
	return async ({ system, user }) => {
		const { signal, done } = withTimeout(SUMMARY_TIMEOUT_MS);
		try {
			const res = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				signal,
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model, max_tokens: 200, system,
					messages: [{ role: "user", content: user }],
				}),
			});
			if (!res.ok) throw new Error(`anthropic ${res.status}`);
			const json = await res.json();
			const out = json?.content?.[0]?.text;
			return typeof out === "string" && out.trim() ? out.trim() : null;
		} finally { done(); }
	};
}

/** Probe Ollama once; fall back to Anthropic; else null. Async — call at startup. */
export async function detectChatProvider({ log = () => {} } = {}) {
	// Default: local Ollama. Gemini/Anthropic are fallbacks used only if Ollama isn't up.
	try {
		const { signal, done } = withTimeout(1500);
		const res = await fetch(`${DEFAULT_OLLAMA_BASE_URL.replace(/\/$/, "")}/api/tags`, { signal });
		done();
		if (res.ok) {
			log(`summaries: using Ollama ${DEFAULT_OLLAMA_MODEL}`);
			return { name: `ollama:${DEFAULT_OLLAMA_MODEL}`, chat: ollamaChat(DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL) };
		}
	} catch { /* ollama not up */ }
	const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
	if (geminiKey) {
		log(`summaries: using Gemini ${GEMINI_MODEL}`);
		return { name: `gemini:${GEMINI_MODEL}`, chat: geminiChat(geminiKey, GEMINI_MODEL) };
	}
	if (process.env.ANTHROPIC_API_KEY) {
		log(`summaries: using Anthropic ${ANTHROPIC_MODEL}`);
		return { name: `anthropic:${ANTHROPIC_MODEL}`, chat: anthropicChat(process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL) };
	}
	log("summaries: no LLM provider — deterministic digests only");
	return null;
}

function blockSummaryPrompt(block, digest) {
	const text = (block.text || "").length > MAX_INPUT_CHARS
		? `${block.text.slice(0, MAX_INPUT_CHARS)}\n[... truncated]`
		: (block.text || "");
	return `Summarize this ${block.kind} block for future agent context. Keep durable facts, ` +
		`decisions, filenames, errors, and outcomes. Be concise (1-3 lines).\n\n` +
		`Fallback digest:\n${digest}\n\nFull block:\n${text}`;
}

/** Manages async block-digest summaries + the task summary behind one provider. */
export class Summarizer {
	constructor(provider, { log = () => {}, onSummaryReady = () => {} } = {}) {
		this.provider = provider; // { name, chat } or null
		this.log = log;
		this.onSummaryReady = onSummaryReady;
		this.cache = new Map(); // content hash → summary string
		this.pending = new Set(); // content hashes in flight
		this.queue = [];
		this.active = 0;
	}

	get enabled() { return !!this.provider; }

	/** Synchronous read for the tiering/command build. undefined ⇒ use deterministic digest. */
	summaryFor(block) {
		return this.cache.get(textHash(block.text));
	}

	/** Schedule summaries for blocks heading to Digest that lack one. Off the critical path. */
	enqueueBlocks(blocks, deterministicDigestFn) {
		if (!this.provider) return;
		for (const b of blocks) {
			const h = textHash(b.text);
			if (this.cache.has(h) || this.pending.has(h)) continue;
			this.pending.add(h);
			this.queue.push({ block: b, hash: h, digest: deterministicDigestFn(b) });
		}
		this.#drain();
	}

	#drain() {
		while (this.active < MAX_CONCURRENCY && this.queue.length) {
			const job = this.queue.shift();
			this.active++;
			Promise.resolve(this.provider.chat({
				system: "You summarize folded context blocks. Return only the summary, no preamble.",
				user: blockSummaryPrompt(job.block, job.digest),
			}))
				.then((s) => {
					if (s) {
						this.cache.set(job.hash, s);
						this.onSummaryReady(job.hash);
					}
				})
				.catch((e) => this.log(`block summary failed: ${e.message}`))
				.finally(() => { this.pending.delete(job.hash); this.active--; this.#drain(); });
		}
	}

	/** The task-summary provider passed to RelevanceEngine ({prompt, context} => string). */
	taskSummaryProvider() {
		if (!this.provider) return null;
		return async ({ prompt, context }) => {
			return this.provider.chat({
				system: "Extract the user's current objective in 1-2 sentences. Be specific; keep identifiers and goals. Return only the objective.",
				user: `Recent context:\n${context}\n\nLatest prompt:\n${prompt}`,
			});
		};
	}
}
