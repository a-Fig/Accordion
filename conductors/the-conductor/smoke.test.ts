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
const PORT = 7790; // isolated from the default 7703

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

		const commands: any[] = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for commands")), 8000);
			let gotHello = false;
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
					assert.equal(msg.id, "the-conductor");
					assert.equal(msg.wants?.content, "full");
					assert.ok(!msg.locks || msg.locks.length === 0, "collaborative: no locks");
					ws.send(JSON.stringify(view));
				} else if (msg.type === "conductor/commands") {
					assert.ok(gotHello, "hello precedes commands");
					clearTimeout(timer);
					resolve(msg.commands);
				}
			});
			ws.on("error", reject);
		});

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
