import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "accordion-mcp-"));
const marker = path.join(root, "opened");
const fakeApp = path.join(root, "accordion-app");
fs.writeFileSync(fakeApp, `#!/bin/sh\ntouch '${marker}'\n`);
fs.chmodSync(fakeApp, 0o755);

const child = spawn(process.execPath, [path.resolve("accordion-mcp.js")], {
	env: { ...process.env, ACCORDION_APP_PATH: fakeApp },
	stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
	const message = JSON.parse(line);
	pending.get(message.id)?.(message);
	pending.delete(message.id);
});
let id = 0;
const request = (method, params = {}) => new Promise((resolve) => {
	id += 1;
	pending.set(id, resolve);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});

try {
	const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "accordion-smoke", version: "1.0.0" } });
	if (initialized.result?.serverInfo?.name !== "accordion") throw new Error("MCP initialization failed");
	const listed = await request("tools/list");
	if (listed.result?.tools?.length !== 1 || listed.result.tools[0]?.name !== "open_accordion") throw new Error("open_accordion was not the sole advertised tool");
	const called = await request("tools/call", { name: "open_accordion", arguments: {} });
	if (called.result?.isError) throw new Error(`open_accordion failed: ${JSON.stringify(called.result.content)}`);
	const deadline = Date.now() + 2000;
	while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	if (!fs.existsSync(marker)) throw new Error("open_accordion did not launch the configured executable");
	console.log("accordion MCP smoke passed");
} finally {
	child.kill();
	fs.rmSync(root, { recursive: true, force: true });
}
