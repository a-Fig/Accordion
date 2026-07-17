/*
 * registry.ts — the catalog of conductors the live host (`./liveHost`) can attach (Phase C).
 *
 * This is the SINGLE place that enumerates the shipped conductors and the metadata the host needs
 * to attach one: its involvement locks (ADR 0011), its protected-tail target, its wire-departing
 * hold window, and HOW it runs — `in-process` (instantiated inside the extension via `create()`) or
 * `spawn` (an out-of-process runner the extension launches, mirroring the live Truth over the wire).
 *
 * Framework-free and — deliberately — FILESYSTEM-free: `catalogMeta` takes a `runnerResolver`
 * callback so the extension (which CAN touch disk) decides whether a spawn conductor's runner file
 * actually exists on this install; the registry never reaches for `fs` itself.
 *
 * The lock/tail/hold metadata for the in-process conductors is SOURCED FROM THE CONDUCTOR
 * DEFINITIONS THEMSELVES — each is instantiated once at module load and its declared `locks` /
 * `tailTokens` / `holdWireUpToMs` read off the instance — so the catalog can never drift from what
 * the conductor actually claims. Thermocline is the exception: it runs out of process, and its
 * class cannot be imported here without pulling its `child_process` attention-probe into the
 * extension bundle, so its metadata is mirrored verbatim from `conductors/thermocline/thermocline.ts`
 * (kept in lockstep by the comment on `THERMOCLINE`).
 */
import type { LockName } from "../locks";
import type { Conductor } from "./contract";
import type { ActiveConductorMeta } from "../protocol";
import { NaiveCompactionConductor } from "../conductors/compaction-naive/compaction-naive";
import { HandoffConductor } from "../conductors/handoff/handoff";
import { DoormanConductor } from "../conductors/doorman/doorman";

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
	/** Spawn descriptor — the runner file the extension launches out of process. */
	spawn?: { entryFile: string };
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
 * Thermocline (spawn). Metadata MIRRORED from `conductors/thermocline/thermocline.ts`:
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
	spawn: { entryFile: "runner.mjs" },
};

/** The full catalog, in picker order: detach first, then the shipped conductors. */
export const ENTRIES: readonly RegistryEntry[] = [
	NONE,
	inProcess(() => new NaiveCompactionConductor()),
	inProcess(() => new HandoffConductor()),
	inProcess(() => new DoormanConductor()),
	THERMOCLINE,
];

/** Look up an entry by id. `null` ⇒ the detach sentinel (`NONE`). Unknown id ⇒ undefined. */
export function entryById(id: string | null): RegistryEntry | undefined {
	if (id === null) return NONE;
	return ENTRIES.find((e) => e.id === id);
}

/**
 * The available-conductor catalog for the `hello` message. A `spawn` entry is included ONLY if
 * `runnerResolver(entryFile)` reports its runner file resolves on this install (repo checkout vs.
 * npm package differ) — the extension supplies that check so the registry stays fs-free. In-process
 * and the `none` sentinel are always present.
 */
export function catalogMeta(runnerResolver?: (entryFile: string) => boolean): ActiveConductorMeta[] {
	const out: ActiveConductorMeta[] = [];
	for (const e of ENTRIES) {
		if (e.kind === "spawn") {
			if (!runnerResolver || !e.spawn || !runnerResolver(e.spawn.entryFile)) continue;
		}
		out.push({
			id: e.id,
			label: e.label,
			description: e.description,
			locks: e.locks.slice(),
			tailTokens: e.tailTokens,
			holdWireUpToMs: e.holdWireUpToMs,
			remote: e.kind === "spawn",
		});
	}
	return out;
}
