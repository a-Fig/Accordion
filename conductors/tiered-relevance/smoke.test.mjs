// smoke.test.mjs — drives the conductor over a real WebSocket, like Accordion would.
//
// Spawns the server (keyword mode — no models needed), connects, performs the hello
// handshake, pushes an over-budget context/update, and asserts a valid conductor/commands
// batch comes back. Uses a throwaway ACCORDION_HOME so it never touches the real registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Inlined literal (not imported from the .ts contract) so the smoke test runs under plain
// `node` on any version — see the note in tiered-relevance.mjs.
const CONDUCTOR_PROTOCOL_VERSION = 3;

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 7799;

function words(n) { return Array(n).fill("alpha").join(" "); }
function vb(id, kind, wc, extra = {}) {
	const text = words(wc);
	return {
		id, kind, turn: 1, order: 0, text,
		tokens: Math.ceil(text.length / 4) + 4, foldedTokens: 12,
		held: false, folded: false, protected: false, grouped: false, ...extra,
	};
}

test("WS round-trip: hello → context/update → conductor/commands", { timeout: 20_000 }, async () => {
	const home = mkdtempSync(join(tmpdir(), "accordion-smoke-"));
	const child = spawn("node", ["tiered-relevance.mjs"], {
		cwd: here,
		env: { ...process.env, TIERS_PORT: String(PORT), ACCORDION_HOME: home },
		stdio: ["ignore", "ignore", "inherit"],
	});

	try {
		await new Promise((r) => setTimeout(r, 600)); // let the server bind
		const ws = await connect(`ws://127.0.0.1:${PORT}`);

		const hello = await nextMessage(ws, (m) => m.type === "conductor/hello");
		assert.equal(hello.id, "tiered-relevance");
		assert.equal(hello.conductorProtocol, CONDUCTOR_PROTOCOL_VERSION);
		assert.equal(hello.wants.content, "full");

		// 8 text blocks ~300 tok each, budget 900 → ~240% full → must compress.
		const blocks = [];
		for (let i = 0; i < 8; i++) blocks.push({ ...vb(`b${i}`, "text", 220), turn: i + 1, order: i });
		const liveTokens = blocks.reduce((s, b) => s + b.tokens, 0);
		ws.send(JSON.stringify({
			type: "context/update", rev: 1, budget: 900, contextWindow: null,
			liveTokens, protectedFromIndex: blocks.length, protectTokens: 0, blocks,
		}));

		const cmds = await nextMessage(ws, (m) => m.type === "conductor/commands");
		assert.equal(cmds.rev, 1);
		assert.ok(Array.isArray(cmds.commands) && cmds.commands.length > 0, "got a non-empty command batch");
		for (const c of cmds.commands) {
			assert.ok(["fold", "replace", "group", "restore", "pin"].includes(c.kind));
		}
		ws.close();
	} finally {
		child.kill("SIGTERM");
	}
});

function connect(url, tries = 20) {
	return new Promise((resolve, reject) => {
		const attempt = (n) => {
			const ws = new WebSocket(url);
			ws.once("open", () => resolve(ws));
			ws.once("error", (e) => {
				if (n <= 0) return reject(e);
				setTimeout(() => attempt(n - 1), 200);
			});
		};
		attempt(tries);
	});
}

function nextMessage(ws, match, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { ws.off("message", onMsg); reject(new Error("timeout waiting for message")); }, timeoutMs);
		const onMsg = (raw) => {
			let m; try { m = JSON.parse(raw.toString()); } catch { return; }
			if (!match(m)) return;
			clearTimeout(timer);
			ws.off("message", onMsg);
			resolve(m);
		};
		ws.on("message", onMsg);
	});
}
