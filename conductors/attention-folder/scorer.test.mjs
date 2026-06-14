// scorer.test.mjs — GPU-free unit tests for the probe bridge's lifecycle guards.
// These never run the real probe; they exercise the early-out and abort paths only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidates } from "./scorer.mjs";

test("empty candidates resolves to an empty Map without spawning a probe", async () => {
	const scores = await scoreCandidates({ tailText: "work", candidates: [] });
	assert.ok(scores instanceof Map);
	assert.equal(scores.size, 0);
});

test("a pre-aborted signal rejects before spawning the probe", async () => {
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(
		() => scoreCandidates({ tailText: "work", candidates: [{ id: "a", text: "x" }], signal: ac.signal }),
		/aborted before start/,
	);
});

test("aborting mid-flight kills the child and rejects (connection-closed path)", async () => {
	const ac = new AbortController();
	// Run `node` against the probe args: it can't execute probe.py as JS, so it would exit on its
	// own — but we abort synchronously right after the call (the Promise executor wires the abort
	// listener synchronously), so the onAbort path settles first and deterministically.
	const p = scoreCandidates({
		tailText: "work",
		candidates: [{ id: "a", text: "x" }],
		python: process.execPath,
		signal: ac.signal,
		timeoutMs: 5_000,
	});
	ac.abort();
	await assert.rejects(p, /aborted/);
});
