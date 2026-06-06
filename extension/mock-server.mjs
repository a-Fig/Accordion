/*
 * mock-server.mjs — a standalone protocol emulator for exercising the GUI side.
 *
 * Speaks the Accordion wire protocol (hello + one full sync) so the app's live
 * client can be driven without running pi. Logs the plan the GUI sends back.
 *
 * Run: node mock-server.mjs   (then open the app and "Connect to live pi session")
 */
import { WebSocketServer } from "ws";

const PORT = 4317;
const est = (s) => Math.ceil(s.length / 4) + 4;

function blk(id, kind, turn, order, text, extra = {}) {
	return { id, kind, turn, order, text, tokens: est(text), ...extra };
}

// A small, mixed sample: two turns, thinking/text/tool_call/tool_result.
const blocks = [
	blk("m0:u", "user", 1, 0, "refactor the auth module and add tests"),
	blk("m1:p0", "thinking", 1, 1, "I should read the module first, then plan the refactor carefully across the touched files."),
	blk("m1:p1", "text", 1, 2, "I'll start by reading the auth module."),
	blk("m1:p2", "tool_call", 1, 3, 'read {"path":"src/auth.ts"}', { toolName: "read", callId: "c1" }),
	blk("m2:r", "tool_result", 1, 4, "export function login() { /* ...120 lines... */ }\n".repeat(20), { toolName: "read", callId: "c1" }),
	blk("m3:u", "user", 2, 5, "looks good, now write the tests"),
	blk("m4:p0", "thinking", 2, 6, "Tests should cover login success, failure, and token refresh."),
	blk("m4:p1", "text", 2, 7, "Writing auth.test.ts with three cases."),
	blk("m4:p2", "tool_call", 2, 8, 'write {"path":"src/auth.test.ts"}', { toolName: "write", callId: "c2" }),
	blk("m5:r", "tool_result", 2, 9, "wrote 64 lines", { toolName: "write", callId: "c2" }),
];

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
let reqId = 0;
wss.on("connection", (ws) => {
	console.log("GUI connected");
	ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, sessionId: "mock", meta: { title: "mock pi session", cwd: "C:/demo/project", model: "kimi", format: "pi" } }));
	ws.send(JSON.stringify({ type: "sync", reqId: ++reqId, full: true, blocks }));
	ws.on("message", (d) => {
		let m;
		try {
			m = JSON.parse(d.toString());
		} catch {
			return;
		}
		if (m.type === "plan") console.log(`PLAN received: reqId=${m.reqId} ops=${m.ops.length}`);
	});
	ws.on("close", () => console.log("GUI disconnected"));
});
console.log(`mock server listening on ws://127.0.0.1:${PORT} (${blocks.length} blocks ready)`);
