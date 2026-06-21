/*
 * smoke.test.ts — a real WebSocket round-trip against the conductor process, playing the role
 * of the Accordion host: connect, receive `conductor/hello`, send `host/hello` + a
 * `context/update`, and assert a well-formed `conductor/commands` reply that respects the
 * contract (only foldable kinds folded; protected/held never touched). `node --test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws"; // default export = the WebSocket class (works whether ws resolves as CJS or ESM)

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = 7791; // isolated from the default 7704
const ERROR_PORT = 7792;

function makeView() {
	const blocks: any[] = [];
	let order = 0;
	const fat = "alpha beta gamma delta epsilon ".repeat(80);
	for (let t = 1; t <= 14; t++) {
		const mk = (kind: string, text: string, extra: any = {}) => {
			const tokens = Math.max(1, Math.ceil(text.length / 4));
			return {
				id: `m${t}:${kind}:${order}`, kind, turn: t, order: order++, tokens, foldedTokens: tokens,
				held: false, folded: false, protected: false, grouped: false, text, ...extra,
			};
		};
		blocks.push(mk("user", `investigate issue ${t} in the deploy pipeline`));
		blocks.push(mk("text", `Working on turn ${t}; inspecting files.`));
		const callId = `call-${t}`;
		blocks.push(mk("tool_call", `readFile {"path":"src/deploy${t}.ts"}`, { toolName: "readFile", callId }));
		blocks.push(mk("tool_result", `deploy${t}: ${fat}`, { toolName: "readFile", callId }));
	}
	for (let i = blocks.length - 4; i < blocks.length; i++) blocks[i].protected = true;
	const liveTokens = blocks.reduce((s, b) => s + b.tokens, 0);
	return {
		type: "context/update", rev: 1, budget: Math.floor(liveTokens * 0.5), contextWindow: 200_000,
		liveTokens, protectedFromIndex: blocks.length - 4, protectTokens: 20_000, blocks,
	};
}

test("WS round-trip: hello → context/update → valid commands", async () => {
	const env = { ...process.env, CONDUCTOR_PORT: String(PORT), ACCORDION_HOME: mkdtempSync(join(tmpdir(), "acc-")) };
	const child = spawn("node", [join(HERE, "the-conductor.ts")], { env, stdio: ["ignore", "ignore", "inherit"] });

	try {
		await new Promise((r) => setTimeout(r, 600)); // let the server bind
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
		const view = makeView();
		const foldable = new Set(["text", "thinking", "tool_result"]);
		const byId = new Map(view.blocks.map((b: any) => [b.id, b]));

		const result: { commands: any[]; status: any } = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for commands")), 8000);
			let gotHello = false;
			let gotHostComplete = false;
			let status: any = null;
			ws.on("open", () => {
				ws.send(JSON.stringify({
					type: "host/hello", conductorProtocol: 3,
					session: { title: "smoke", model: "test", cwd: "/tmp" }, budget: view.budget, contextWindow: 200_000,
				}));
			});
			ws.on("message", (raw) => {
				const msg = JSON.parse(raw.toString());
				if (msg.type === "conductor/hello") {
					gotHello = true;
					assert.equal(msg.id, "the-conductor-v2");
					assert.equal(msg.wants?.content, "full");
					assert.ok(!msg.locks || msg.locks.length === 0, "collaborative: no locks");
					ws.send(JSON.stringify(view));
				} else if (msg.type === "cap/request") {
					assert.equal(msg.capability, "complete");
					assert.ok(msg.reqId.startsWith("summary-"));
					gotHostComplete = true;
				} else if (msg.type === "conductor/status") {
					status = msg;
				} else if (msg.type === "conductor/commands") {
					assert.ok(gotHello, "hello precedes commands");
					assert.ok(gotHostComplete, "v2 asks the host for summaries by default");
					assert.ok(status, "status telemetry precedes commands");
					assert.ok(status.details?.health, "status includes health details");
					assert.ok(Array.isArray(status.details?.unitTrace), "status includes unit trace");
					assert.ok(status.details?.caches?.summary, "status includes cache diagnostics");
					clearTimeout(timer);
					resolve({ commands: msg.commands, status });
				}
			});
			ws.on("error", reject);
		});

		const commands = result.commands;
		assert.ok(commands.length > 0, "expected folds under pressure");
		for (const c of commands) {
			assert.ok(["fold", "replace", "group"].includes(c.kind), `known command kind: ${c.kind}`);
			const ids = c.kind === "replace" ? [c.id] : c.ids;
			for (const id of ids) {
				const b = byId.get(id);
				assert.ok(b, `targets known block ${id}`);
				if (c.kind !== "group") {
					assert.ok(foldable.has(b.kind), `only foldable kinds: ${b.kind}`);
					assert.ok(!b.protected && !b.held, "never protected/held");
				}
			}
		}
		ws.close();
	} finally {
		child.kill("SIGTERM");
	}
});

test("clears provider error after a later successful host completion", async () => {
	const env = { ...process.env, CONDUCTOR_PORT: String(ERROR_PORT), ACCORDION_HOME: mkdtempSync(join(tmpdir(), "acc-")) };
	const child = spawn("node", [join(HERE, "the-conductor.ts")], { env, stdio: ["ignore", "ignore", "inherit"] });

	try {
		await new Promise((r) => setTimeout(r, 600));
		const ws = new WebSocket(`ws://127.0.0.1:${ERROR_PORT}`);
		const baseView = makeView();

		await new Promise<void>((resolve, reject) => {
			let failed = false;
			let succeeded = false;
			let recoveryRev = 2;
			let retry: ReturnType<typeof setInterval> | null = null;
			const timer = setTimeout(() => {
				if (retry) clearInterval(retry);
				reject(new Error("timed out waiting for provider error to clear"));
			}, 10_000);

			const sendView = (rev: number) => {
				ws.send(JSON.stringify({ ...baseView, rev }));
			};

			ws.on("open", () => {
				ws.send(JSON.stringify({
					type: "host/hello", conductorProtocol: 3,
					session: { title: "smoke", model: "test", cwd: "/tmp" }, budget: baseView.budget, contextWindow: 200_000,
				}));
			});
			ws.on("message", (raw) => {
				const msg = JSON.parse(raw.toString());
				if (msg.type === "conductor/hello") {
					sendView(1);
					return;
				}
				if (msg.type === "cap/request") {
					if (!failed) {
						ws.send(JSON.stringify({ type: "cap/result", reqId: msg.reqId, ok: false, error: "host completion failed in test" }));
						failed = true;
						retry = setInterval(() => sendView(recoveryRev++), 100);
					} else {
						ws.send(JSON.stringify({ type: "cap/result", reqId: msg.reqId, ok: true, value: "host summary recovered" }));
						succeeded = true;
						if (retry) {
							clearInterval(retry);
							retry = null;
						}
					}
					return;
				}
				if (msg.type !== "conductor/status") return;
				const latestError = msg.details?.caches?.latestProviderError || msg.details?.caches?.summary?.latestError;
				if (failed && succeeded && !latestError) {
					clearTimeout(timer);
					if (retry) clearInterval(retry);
					resolve();
				}
			});
			ws.on("error", (error) => {
				clearTimeout(timer);
				if (retry) clearInterval(retry);
				reject(error);
			});
		});
		ws.close();
	} finally {
		child.kill("SIGTERM");
	}
});
