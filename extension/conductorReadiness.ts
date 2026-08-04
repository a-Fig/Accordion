/*
 * Spawn-conductor readiness lives in the extension because the shared registry is deliberately
 * filesystem-free. This check is used both for hello catalog metadata and immediately before a
 * selection, so the UI and host enforce the same answer.
 *
 * Readiness covers REQUIRED startup capabilities only. Thermocline is the reference boundary:
 * its runner is dependency-free and its optional attention probe has an age-based fallback, so a
 * missing probe is runtime degradation (conductorStatus), not catalog unavailability. Triptych's
 * tree-sitter modules enable its defining skeletonization behavior and therefore are required.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ConductorReadiness } from "../core/protocol";
import type { RegistryEntry } from "../core/conductor/registry";

export function resolveRunnerPath(conductorsWsDir: string, entryFile: string): string | null {
	try {
		if (typeof entryFile !== "string" || entryFile.length === 0) return null;
		if (path.isAbsolute(entryFile) || entryFile.split(/[\\/]/).includes("..")) return null;
		const runnerPath = path.resolve(conductorsWsDir, entryFile);
		return fs.existsSync(runnerPath) ? runnerPath : null;
	} catch {
		return null;
	}
}

export function conductorReadiness(entry: RegistryEntry, conductorsWsDir: string): ConductorReadiness {
	if (entry.kind !== "spawn") return { state: "ready" };
	if (!entry.spawn) return { state: "unavailable", reason: `${entry.label} has no runner configured.` };

	const runnerPath = resolveRunnerPath(conductorsWsDir, entry.spawn.entryFile);
	if (!runnerPath) {
		return { state: "unavailable", reason: `${entry.label} runner is not included in this installation.` };
	}

	const missing: string[] = [];
	const requireFromRunner = createRequire(runnerPath);
	for (const specifier of entry.spawn.requiredModules ?? []) {
		try {
			requireFromRunner.resolve(specifier);
		} catch {
			missing.push(specifier);
		}
	}
	if (missing.length === 0) return { state: "ready" };

	return {
		state: "unavailable",
		reason: entry.spawn.unavailableReason ?? `Required modules could not be resolved: ${missing.join(", ")}.`,
		remediation: entry.spawn.remediation,
	};
}
