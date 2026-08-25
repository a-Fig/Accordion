import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ACCORDION_APP_ENV = "ACCORDION_APP_PATH";

export type LaunchSource = "explicit" | "env" | "default";
export type LaunchResult =
	| { ok: true; path: string; source: LaunchSource }
	| { ok: false; reason: "explicit-invalid"; path: string; source: Extract<LaunchSource, "explicit" | "env"> }
	| { ok: false; reason: "not-found" }
	| { ok: false; reason: "spawn-failed"; path: string; source: LaunchSource; error: unknown };

function cleanExplicitPath(value: unknown): string | null {
	if (typeof value !== "string") return null;
	let s = value.trim();
	if (!s) return null;
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1).trim();
	if (s === "~") return os.homedir();
	if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
	return s;
}

function isLaunchableFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

function installedCandidates(): string[] {
	if (process.platform === "darwin") {
		return [
			"/Applications/Accordion.app/Contents/MacOS/Accordion",
			path.join(os.homedir(), "Applications", "Accordion.app", "Contents", "MacOS", "Accordion"),
		];
	}
	if (process.platform === "linux") return [path.join(os.homedir(), ".local", "share", "Accordion", "accordion")];
	if (process.platform !== "win32") return [];
	const roots = [
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Accordion"),
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Accordion"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Accordion"),
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Accordion"),
	].filter((candidate): candidate is string => !!candidate);
	return roots.flatMap((root) => [path.join(root, "Accordion.exe"), path.join(root, "app.exe")]);
}

function repoCandidates(): string[] {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repo = path.resolve(here, "..");
	const ext = process.platform === "win32" ? ".exe" : "";
	return [
		path.join(repo, "app", "src-tauri", "target", "release", `app${ext}`),
		path.join(repo, "app", "src-tauri", "target", "debug", `app${ext}`),
	];
}

export function resolveAccordionApp(explicitPath?: unknown): LaunchResult {
	const explicit = cleanExplicitPath(explicitPath);
	if (explicit) {
		if (isLaunchableFile(explicit)) return { ok: true, path: explicit, source: "explicit" };
		return { ok: false, reason: "explicit-invalid", path: explicit, source: "explicit" };
	}
	const envPath = cleanExplicitPath(process.env[ACCORDION_APP_ENV]);
	if (envPath) {
		if (isLaunchableFile(envPath)) return { ok: true, path: envPath, source: "env" };
		return { ok: false, reason: "explicit-invalid", path: envPath, source: "env" };
	}
	for (const candidate of [...installedCandidates(), ...repoCandidates()]) {
		if (isLaunchableFile(candidate)) return { ok: true, path: candidate, source: "default" };
	}
	return { ok: false, reason: "not-found" };
}

export async function launchAccordionApp(explicitPath?: unknown): Promise<LaunchResult> {
	const resolved = resolveAccordionApp(explicitPath);
	if (!resolved.ok) return resolved;
	try {
		const child = spawn(resolved.path, [], { detached: true, stdio: "ignore", shell: false });
		return await new Promise<LaunchResult>((resolve) => {
			let settled = false;
			const ok: LaunchResult = { ok: true, path: resolved.path, source: resolved.source };
			const timer = setTimeout(() => finish(ok), 150);
			const finish = (result: LaunchResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("spawn", onSpawn);
				child.unref();
				resolve(result);
			};
			const onSpawn = () => finish(ok);
			const onError = (error: unknown) => finish({ ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error });
			child.once("spawn", onSpawn);
			child.once("error", onError);
		});
	} catch (error) {
		return { ok: false, reason: "spawn-failed", path: resolved.path, source: resolved.source, error };
	}
}
