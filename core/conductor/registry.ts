/*
 * registry.ts — the catalog of conductors the live host (`./liveHost`) can attach (Phase C).
 *
 * This is the SINGLE place that enumerates the shipped conductors and the metadata the host needs
 * to attach one: its involvement locks (ADR 0011), its protected-tail target, its wire-departing
 * hold window, and HOW it runs — `in-process` (instantiated inside the extension via `create()`) or
 * `spawn` (an out-of-process runner the extension launches, mirroring the live Truth over the wire).
 *
 * Framework-free and — deliberately — FILESYSTEM-free: `catalogMeta` takes a readiness callback so
 * the extension (which CAN touch disk) resolves each spawn runner and its declared required modules;
 * the registry never reaches for `fs` itself.
 *
 * The lock/tail/hold metadata for the in-process conductors is SOURCED FROM THE CONDUCTOR
 * DEFINITIONS THEMSELVES — each is instantiated once at module load and its declared `locks` /
 * `tailTokens` / `holdWireUpToMs` read off the instance — so the catalog can never drift from what
 * the conductor actually claims. The spawn conductors are the exception: they run out of process,
 * and their classes cannot be imported here without pulling process-only baggage into the
 * extension bundle (thermocline's `child_process` attention-probe; triptych's wasm tree-sitter
 * engine), so their metadata is mirrored verbatim from their class definitions (kept in lockstep
 * by the comments on `THERMOCLINE` / `TRIPTYCH`).
 */
import type { LockName } from "../locks";
import type { Conductor } from "./contract";
import type { ActiveConductorMeta, ConductorReadiness } from "../protocol";
import { NaiveCompactionConductor } from "../../conductors/in-process/compaction-naive/compaction-naive";
import { HandoffConductor } from "../../conductors/in-process/handoff/handoff";
import { DoormanConductor } from "../../conductors/in-process/doorman/doorman";

/** One catalog entry: everything the host needs to attach (or detach to) this conductor. */
export interface RegistryEntry {
	id: string;
	label: string;
	description?: string;
	/** Involvement locks acquired eagerly on attach (ADR 0011). Empty ⇒ collaborative. */
	locks: readonly LockName[];
	/** Tail target while holding `tail-size` (0 ⇒ own the whole context / not held). */
	tailTokens: number;
	/** Max ms the host holds the departing wire for a last-moment proposal (0 ⇒ no hold). */
	holdWireUpToMs: number;
	/** How this conductor runs. `none` is the sentinel detach entry. */
	kind: "none" | "in-process" | "spawn";
	/** In-process factory — a FRESH conductor per attach. */
	create?: () => Conductor;
	/** Spawn descriptor — the runner file the extension launches out of process. `entryFile` is
	 *  relative to `conductors/ws/` (e.g. `"thermocline/runner.mjs"`) so one resolver serves every
	 *  spawn conductor; the extension sanitizes it (no absolute paths, no `..`). */
	spawn?: {
		entryFile: string;
		/** Node module specifiers that must resolve relative to the runner before it is selectable. */
		requiredModules?: readonly string[];
		/** Human explanation used when any required module cannot resolve. */
		unavailableReason?: string;
		/** Safe, explicit setup instruction. The host never performs it automatically. */
		remediation?: string;
	};
}

/** Build an in-process entry, sourcing its metadata from a sample instance of the conductor. */
function inProcess(create: () => Conductor): RegistryEntry {
	const sample = create();
	return {
		id: sample.id,
		label: sample.label,
		description: sample.description,
		locks: (sample.locks ?? []).slice(),
		tailTokens: sample.tailTokens ?? 0,
		holdWireUpToMs: sample.holdWireUpToMs ?? 0,
		kind: "in-process",
		create,
	};
}

/** The sentinel "detach" entry. `select(null)` and `select("none")` both resolve here. */
const NONE: RegistryEntry = {
	id: "none",
	label: "None (raw context)",
	description: "Detach any conductor — context is raw, human-operated.",
	locks: [],
	tailTokens: 0,
	holdWireUpToMs: 0,
	kind: "none",
};

/*
 * Thermocline (spawn). Metadata MIRRORED from `conductors/ws/thermocline/thermocline.ts`:
 *   readonly locks = ["human-steering"];  readonly holdWireUpToMs = 200;  (no tailTokens ⇒ 0)
 * Keep in lockstep with that class — it cannot be imported here (its scorer spawns a probe).
 */
const THERMOCLINE: RegistryEntry = {
	id: "thermocline",
	label: "Thermocline",
	description: "Attention-gated LLM compression in deliberate epochs, under a hard budget invariant.",
	locks: ["human-steering"],
	tailTokens: 0,
	holdWireUpToMs: 200,
	kind: "spawn",
	spawn: { entryFile: "thermocline/runner.mjs" },
};

/*
 * Triptych (spawn). Metadata MIRRORED from `conductors/ws/triptych/triptych.ts`:
 *   readonly locks = ["human-steering", "agent-unfold"];  (no holdWireUpToMs ⇒ 0; no tailTokens ⇒ 0)
 * Keep in lockstep with that class — like thermocline it cannot be imported here (its runner
 * injects a wasm tree-sitter engine that must never enter the extension bundle).
 */
const TRIPTYCH: RegistryEntry = {
	id: "triptych",
	label: "Triptych",
	description: "Pressure-gated thirds: raw recent band, code-skeleton middle band, lossy compaction summary top band.",
	locks: ["human-steering", "agent-unfold"],
	tailTokens: 0,
	holdWireUpToMs: 0,
	kind: "spawn",
	spawn: {
		entryFile: "triptych/runner.mjs",
		requiredModules: ["web-tree-sitter", "tree-sitter-wasms/package.json"],
		unavailableReason: "Tree-sitter dependencies required for code skeletonization are not installed.",
		remediation: "Run `npm install` in `conductors/ws/triptych/`, then reconnect Accordion.",
	},
};

/** The full catalog, in picker order: detach first, then the shipped conductors. */
export const ENTRIES: readonly RegistryEntry[] = [
	NONE,
	inProcess(() => new NaiveCompactionConductor()),
	inProcess(() => new HandoffConductor()),
	inProcess(() => new DoormanConductor()),
	THERMOCLINE,
	TRIPTYCH,
];

/** Look up an entry by id. `null` ⇒ the detach sentinel (`NONE`). Unknown id ⇒ undefined. */
export function entryById(id: string | null): RegistryEntry | undefined {
	if (id === null) return NONE;
	return ENTRIES.find((e) => e.id === id);
}

/**
 * The conductor catalog for the `hello` message. Every entry remains visible. The extension
 * computes spawn readiness because it owns filesystem/module resolution; this registry stays
 * framework- and filesystem-free. In-process entries and the detach sentinel are always ready.
 */
export function catalogMeta(readinessOf?: (entry: RegistryEntry) => ConductorReadiness): ActiveConductorMeta[] {
	const out: ActiveConductorMeta[] = [];
	for (const e of ENTRIES) {
		const readiness: ConductorReadiness =
			e.kind === "spawn"
				? (readinessOf?.(e) ?? { state: "unavailable", reason: "This host did not verify the conductor runner." })
				: { state: "ready" };
		out.push({
			id: e.id,
			label: e.label,
			description: e.description,
			locks: e.locks.slice(),
			tailTokens: e.tailTokens,
			holdWireUpToMs: e.holdWireUpToMs,
			remote: e.kind === "spawn",
			readiness,
		});
	}
	return out;
}
