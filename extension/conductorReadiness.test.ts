import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { conductorReadiness, resolveRunnerPath } from "./conductorReadiness";
import { entryById, type RegistryEntry } from "../core/conductor/registry";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(requiredModules: string[] = []): { root: string; entry: RegistryEntry } {
	const root = mkdtempSync(path.join(tmpdir(), "accordion-readiness-"));
	roots.push(root);
	mkdirSync(path.join(root, "triptych"), { recursive: true });
	writeFileSync(path.join(root, "triptych", "runner.mjs"), "// fixture\n");
	return {
		root,
		entry: {
			id: "fixture",
			label: "Fixture",
			locks: [],
			tailTokens: 0,
			holdWireUpToMs: 0,
			kind: "spawn",
			spawn: {
				entryFile: "triptych/runner.mjs",
				requiredModules,
				unavailableReason: "Fixture dependencies are missing.",
				remediation: "Install the fixture dependencies.",
			},
		},
	};
}

describe("spawn conductor readiness", () => {
	it("rejects unsafe or absent runner paths", () => {
		const { root, entry } = fixture();
		expect(resolveRunnerPath(root, "../outside.mjs")).toBeNull();
		expect(conductorReadiness({ ...entry, spawn: { entryFile: "missing/runner.mjs" } }, root)).toEqual({
			state: "unavailable",
			reason: "Fixture runner is not included in this installation.",
		});
	});

	it("reports a required module failure with the declared remediation", () => {
		const { root, entry } = fixture(["definitely-not-installed-for-accordion-test"]);
		expect(conductorReadiness(entry, root)).toEqual({
			state: "unavailable",
			reason: "Fixture dependencies are missing.",
			remediation: "Install the fixture dependencies.",
		});
	});

	it("is ready when every required module resolves relative to the runner", () => {
		const { root, entry } = fixture(["fixture-module"]);
		const moduleDir = path.join(root, "triptych", "node_modules", "fixture-module");
		mkdirSync(moduleDir, { recursive: true });
		writeFileSync(path.join(moduleDir, "package.json"), JSON.stringify({ name: "fixture-module", main: "index.js" }));
		writeFileSync(path.join(moduleDir, "index.js"), "module.exports = {};\n");
		expect(conductorReadiness(entry, root)).toEqual({ state: "ready" });
	});

	it("keeps a dependency-free spawn conductor ready", () => {
		const { root, entry } = fixture();
		expect(conductorReadiness(entry, root)).toEqual({ state: "ready" });
	});

	it("distinguishes Triptych's defining modules from Thermocline's optional probe", () => {
		const root = mkdtempSync(path.join(tmpdir(), "accordion-readiness-shipped-"));
		roots.push(root);
		for (const id of ["triptych", "thermocline"]) {
			mkdirSync(path.join(root, id), { recursive: true });
			writeFileSync(path.join(root, id, "runner.mjs"), "// fixture\n");
		}
		const triptych = entryById("triptych")!;
		const thermocline = entryById("thermocline")!;
		expect(conductorReadiness(triptych, root)).toEqual({
			state: "unavailable",
			reason: "Tree-sitter dependencies required for code skeletonization are not installed.",
			remediation: "Run `npm install` in `conductors/ws/triptych/`, then reconnect Accordion.",
		});
		expect(conductorReadiness(thermocline, root)).toEqual({ state: "ready" });
	});
});
