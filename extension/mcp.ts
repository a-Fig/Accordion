#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ACCORDION_APP_ENV, launchAccordionApp } from "./launcher";
import packageJson from "./package.json" with { type: "json" };

const tools = [{
	name: "open_accordion",
	description: "Open or focus the native Accordion context-map GUI. Live context steering is currently available for pi sessions; Claude Code transcripts are browsable read-only.",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function openAccordion() {
	const result = await launchAccordionApp();
	if (result.ok) {
		return { content: [{ type: "text", text: `Accordion opened from ${result.path}. Live steering remains pi-only; use the Claude Code tab for read-only transcript browsing.` }] };
	}
	if (result.reason === "explicit-invalid") {
		return { isError: true, content: [{ type: "text", text: `${ACCORDION_APP_ENV} does not point to an executable: ${result.path}` }] };
	}
	if (result.reason === "spawn-failed") {
		return { isError: true, content: [{ type: "text", text: `Accordion was found at ${result.path}, but launching it failed.` }] };
	}
	return { isError: true, content: [{ type: "text", text: `Accordion was not found. Build or install the desktop app, or set ${ACCORDION_APP_ENV}.` }] };
}

for await (const line of createInterface({ input: process.stdin })) {
	let request: any;
	try {
		request = JSON.parse(line);
	} catch {
		write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
		continue;
	}
	if (request.id === undefined) continue;
	if (request.method === "initialize") {
		write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "accordion", version: packageJson.version } } });
	} else if (request.method === "ping") {
		write({ jsonrpc: "2.0", id: request.id, result: {} });
	} else if (request.method === "tools/list") {
		write({ jsonrpc: "2.0", id: request.id, result: { tools } });
	} else if (request.method === "tools/call" && request.params?.name === "open_accordion") {
		write({ jsonrpc: "2.0", id: request.id, result: await openAccordion() });
	} else {
		write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
	}
}
