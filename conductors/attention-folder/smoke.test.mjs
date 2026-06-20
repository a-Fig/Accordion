// smoke.test.mjs — GPU-FREE wire test of attention-folder.mjs via a real WS client.
//
// The Python probe is disabled by pointing ATTN_PROBE_PYTHON to a non-existent path so
// scoreCandidates rejects immediately and scores stay empty. The policy's unscored-fallback
// still folds (by FOLD_RANK), which is what we assert.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ViewBlock factory (identical to policy.test.mjs) */
function blk(o) {
	return {
		id: o.id,
		kind: o.kind ?? "tool_result",
		turn: o.turn ?? 0,
		order: o.order ?? 0,
		tokens: o.tokens ?? 1000,
		foldedTokens: o.foldedTokens ?? 50,
		held: !!o.held,
		folded: !!o.folded,
		protected: !!o.protected,
		grouped: !!o.grouped,
		text: o.text ?? o.id,
	};
}

// ── Shared child-process + WS client state ──
let child;
let ws;
const PORT = 7799;
const URL = `ws://127.0.0.1:${PORT}`;

/** Wait for the server to log "listening" on stderr (or fall back to a fixed delay). */
function waitForListening(proc, timeoutMs = 3_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// Timeout is not necessarily fatal — the server may have started already.
			resolve();
		}, timeoutMs);

		const onData = (chunk) => {
			if (chunk.toString().includes("listening")) {
				clearTimeout(timer);
				proc.stderr.off("data", onData);
				resolve();
			}
		};
		proc.stderr.on("data", onData);

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		proc.on("exit", (code) => {
			if (code !== null && code !== 0) {
				clearTimeout(timer);
				reject(new Error(`server exited prematurely with code ${code}`));
			}
		});
	});
}

/** Open a WebSocket and wait until it's connected. */
function connect(url, timeoutMs = 3_000) {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timer = setTimeout(() => reject(new Error("WS connect timeout")), timeoutMs);
		socket.once("open", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** Wait for the next message on the socket (returns parsed JSON). */
function nextMessage(socket, timeoutMs = 2_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("WS message timeout")), timeoutMs);
		socket.once("message", (raw) => {
			clearTimeout(timer);
			resolve(JSON.parse(raw.toString()));
		});
	});
}

/** Wait for a message satisfying a predicate, discarding non-matching ones, up to timeoutMs. */
function waitForMessage(socket, predicate, timeoutMs = 2_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("WS wait-for-message timeout")), timeoutMs);
		const handler = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (predicate(msg)) {
				clearTimeout(timer);
				socket.off("message", handler);
				resolve(msg);
			}
		};
		socket.on("message", handler);
	});
}

/** Assert that NO message satisfying predicate arrives within timeoutMs. */
function assertNoMessage(socket, predicate, timeoutMs = 400) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off("message", handler);
			resolve(); // timeout = good, nothing arrived
		}, timeoutMs);
		const handler = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (predicate(msg)) {
				clearTimeout(timer);
				socket.off("message", handler);
				reject(new Error(`Unexpected message arrived: ${JSON.stringify(msg)}`));
			}
		};
		socket.on("message", handler);
	});
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

before(async () => {
	child = spawn("node", ["attention-folder.mjs"], {
		cwd: __dirname,
		env: {
			...process.env,
			ATTN_PORT: String(PORT),
			ATTN_PROBE_PYTHON: "/no/such/python",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});

	// Prevent the child from keeping our process alive if we forget to kill it.
	child.unref();

	await waitForListening(child, 4_000);

	// Give the event loop a moment after "listening" is logged before we dial in.
	await new Promise((r) => setTimeout(r, 100));

	ws = await connect(URL, 4_000);
});

after(() => {
	// Best-effort cleanup — always kill the child so heartbeat file stops.
	try {
		ws?.close();
	} catch {
		/* ignore */
	}
	try {
		child?.kill("SIGTERM");
	} catch {
		/* ignore */
	}
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: server sends conductor/hello immediately on connect
// ──────────────────────────────────────────────────────────────────────────────
test("server sends conductor/hello with wants.content==='full'", async () => {
	const msg = await nextMessage(ws, 2_000);
	assert.equal(msg.type, "conductor/hello");
	assert.equal(msg.wants?.content, "full");
	assert.equal(msg.conductorProtocol, 3);
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 2: send host/hello (no reply expected)
// ──────────────────────────────────────────────────────────────────────────────
test("send host/hello (ignored gracefully, no crash)", async () => {
	ws.send(JSON.stringify({ type: "host/hello", hostProtocol: 2 }));
	// Give the server 200ms to process — if it crashed the next test will fail
	await new Promise((r) => setTimeout(r, 200));
	// Assert the connection is still open
	assert.equal(ws.readyState, WebSocket.OPEN, "WebSocket should still be open after host/hello");
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 3: hold — context/update well under 90% → no conductor/commands
// ──────────────────────────────────────────────────────────────────────────────
test("hold: context/update under 90% contextWindow → no conductor/commands arrives", async () => {
	// contextWindow = 100_000; blocks sum to 20k < 90k → hold
	const blocks = Array.from({ length: 4 }, (_, i) =>
		blk({ id: `hold_blk_${i}`, tokens: 5_000, foldedTokens: 50, order: i })
	);

	ws.send(
		JSON.stringify({
			type: "context/update",
			rev: 1,
			contextWindow: 100_000,
			budget: 100_000,
			liveTokens: 20_000,
			protectedFromIndex: 0,
			protectTokens: 20_000,
			blocks,
		})
	);

	await assertNoMessage(
		ws,
		(m) => m.type === "conductor/commands",
		400
	);
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 4: epoch — context/update over 90% → conductor/commands with fold ids
// ──────────────────────────────────────────────────────────────────────────────
test("epoch: context/update over 90% contextWindow → conductor/commands with fold kind and ids", async () => {
	// contextWindow = 100_000; 10 blocks × 10k each = 100k > 90k → epoch.
	// Probe will fail (no python), so unscored fallback folds by FOLD_RANK.
	const blocks = Array.from({ length: 10 }, (_, i) =>
		blk({
			id: `epoch_blk_${i}`,
			kind: "tool_result",
			tokens: 10_000,
			foldedTokens: 50,
			order: i,
			text: `block ${i} content`,
		})
	);

	ws.send(
		JSON.stringify({
			type: "context/update",
			rev: 2,
			contextWindow: 100_000,
			budget: 100_000,
			liveTokens: 100_000,
			protectedFromIndex: 0,
			protectTokens: 0,
			blocks,
		})
	);

	const msg = await waitForMessage(
		ws,
		(m) => m.type === "conductor/commands",
		2_000
	);

	assert.equal(msg.type, "conductor/commands");
	assert.equal(msg.rev, 2, "rev should echo the request rev");
	assert.ok(Array.isArray(msg.commands), "commands must be an array");
	assert.ok(msg.commands.length > 0, "commands must be non-empty");
	assert.equal(msg.commands[0].kind, "fold", "first command kind must be 'fold'");
	assert.ok(Array.isArray(msg.commands[0].ids), "fold command must have ids array");
	assert.ok(msg.commands[0].ids.length > 0, "fold ids must be non-empty");
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 5: telemetry — a context/update yields a display-only conductor/status
// ──────────────────────────────────────────────────────────────────────────────
test("status: context/update → conductor/status with one-line text + metrics", async () => {
	// 4 blocks × 12k = 48k / 100k → 48% (a hold; under the 80% warm mark so no scoring).
	// A fullness not used by prior tests, so the deduped status is guaranteed to emit.
	const blocks = Array.from({ length: 4 }, (_, i) =>
		blk({ id: `status_blk_${i}`, tokens: 12_000, foldedTokens: 50, order: i })
	);

	ws.send(
		JSON.stringify({
			type: "context/update",
			rev: 3,
			contextWindow: 100_000,
			budget: 100_000,
			liveTokens: 48_000,
			protectedFromIndex: 0,
			protectTokens: 0,
			blocks,
		})
	);

	// Match OUR update specifically (48% full) — a prior test's epoch may have left an
	// unconsumed conductor/status in the buffer; waitForMessage discards non-matching ones.
	const msg = await waitForMessage(
		ws,
		(m) => m.type === "conductor/status" && /48% full/.test(m.text ?? ""),
		2_000
	);

	assert.equal(msg.type, "conductor/status");
	assert.equal(typeof msg.text, "string", "status text must be a string");
	assert.match(msg.text, /48% full/, "status text should report this update's fullness");
	assert.match(msg.text, /holding/, "a sub-band update should read as holding");
	assert.ok(msg.metrics && typeof msg.metrics === "object", "metrics must be an object");
	assert.equal(msg.metrics.action, "hold", "metrics.action should be 'hold' under the band");
	assert.equal(msg.metrics.fullness, 48, "metrics.fullness must reflect the update");
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 6: status refresh on confirmation — host/commandResult updates the folded
// count so the readout never sticks at the pre-epoch count (regression for the
// "0 folded · last epoch: folded N" self-contradiction).
// ──────────────────────────────────────────────────────────────────────────────
test("status: host/commandResult refreshes the folded count after an epoch", async () => {
	// Force an epoch (10 × 10k = 100k > 90k). Probe disabled → unscored fallback folds.
	const blocks = Array.from({ length: 10 }, (_, i) =>
		blk({ id: `confirm_blk_${i}`, kind: "tool_result", tokens: 10_000, foldedTokens: 50, order: i, text: `c ${i}` })
	);

	ws.send(
		JSON.stringify({
			type: "context/update",
			rev: 11,
			contextWindow: 100_000,
			budget: 100_000,
			liveTokens: 100_000,
			protectedFromIndex: 0,
			protectTokens: 0,
			blocks,
		})
	);

	// Capture how many blocks the epoch actually folded.
	const cmd = await waitForMessage(ws, (m) => m.type === "conductor/commands" && m.rev === 11, 2_000);
	const foldedN = cmd.commands[0].ids.length;
	assert.ok(foldedN > 0, "epoch should fold at least one block");

	// Confirm the batch. The conductor must now emit a status reporting the REAL count —
	// before this it reported 0 folded (the host suppresses the post-fold context/update).
	ws.send(JSON.stringify({ type: "host/commandResult", rev: 11, reports: [] }));

	const status = await waitForMessage(
		ws,
		(m) => m.type === "conductor/status" && m.metrics?.folded === foldedN,
		2_000
	);
	assert.equal(status.metrics.folded, foldedN, "folded count must match the confirmed fold set");
	assert.match(status.text, new RegExp(`\\b${foldedN} folded`), "text must report the confirmed fold count");
});

// ──────────────────────────────────────────────────────────────────────────────
// Test 7: degenerate cap (no contextWindow + budget 0) must never serialize
// NaN/Infinity — fullness is guarded to a finite 0.
// ──────────────────────────────────────────────────────────────────────────────
test("status: degenerate cap (contextWindow null, budget 0) emits finite fullness, never NaN", async () => {
	// tokens 0 → rendered 0; cap 0 → fullness 0/0 = NaN. The guard must coerce it to 0.
	const blocks = Array.from({ length: 2 }, (_, i) =>
		blk({ id: `nan_blk_${i}`, kind: "text", tokens: 0, foldedTokens: 0, order: i, text: `n ${i}` })
	);

	ws.send(
		JSON.stringify({
			type: "context/update",
			rev: 12,
			contextWindow: null,
			budget: 0,
			liveTokens: 0,
			protectedFromIndex: 0,
			protectTokens: 0,
			blocks,
		})
	);

	const msg = await waitForMessage(
		ws,
		(m) => m.type === "conductor/status" && m.metrics?.action === "hold" && /0% full/.test(m.text ?? ""),
		2_000
	);

	assert.doesNotMatch(msg.text, /NaN|Infinity/, "text must not contain NaN/Infinity");
	assert.equal(Number.isFinite(msg.metrics.fullness), true, "metrics.fullness must be finite");
	assert.equal(msg.metrics.fullness, 0, "degenerate cap → 0% fullness");
});
