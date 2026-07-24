import { describe, it, expect } from "vitest";
import { ViewConductor, type Command, type ConductorView } from "./view";
import { TestHost } from "./testhost";
import type { Block, ParsedSession } from "../types";

const META = { format: "pi" as const, title: "t", cwd: "", model: "" };
function blk(id: string, order: number, tokens = 1000): Block {
	return { id, kind: "text", turn: order + 1, order, text: `${id} ` + "x".repeat(tokens * 4), tokens, override: null, autoFolded: false, by: null };
}
function seq(n: number): Block[] {
	return Array.from({ length: n }, (_, i) => blk(`a:b${i}:p0`, i));
}

/** A conductor whose desired state is settable, so tests drive the diff directly. */
class ScriptedConductor extends ViewConductor {
	readonly id = "scripted";
	readonly label = "Scripted";
	desired: Command[] | null = [];
	lastView: ConductorView | null = null;
	/** Counts every `conduct()` invocation — used to detect a reentrant self-triggered loop. */
	conductCalls = 0;
	conduct(view: ConductorView): Command[] | null {
		this.conductCalls++;
		this.lastView = view;
		return this.desired;
	}
	/** Expose the protected local rerun for direct assertions. */
	runNow(): Promise<void> {
		return this.rerun();
	}
}

/** Flush the microtask queue so a fire-and-forget `rerun()` triggered by a non-awaitable Truth
 *  event (e.g. `setBudget`/`setProtect`, which fire via `TestHost`'s synchronous `fire()`, not
 *  `fireAwaitable()`) has settled before assertions run. */
async function flush(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) await Promise.resolve();
}

function liveHostWith(n: number): TestHost {
	const h = new TestHost();
	h.appendBlocks(seq(n));
	h.setProtect(0);
	return h;
}

describe("ViewConductor — desired-state diffing", () => {
	it("proposes fold ops for the strategy's desired folds", async () => {
		const host = liveHostWith(4);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0", "a:b1:p0"] }];
		await host.commitTurn();
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(true);
		expect(host.truth.isFolded(host.truth.get("a:b1:p0")!)).toBe(true);
		expect(host.truth.get("a:b0:p0")!.by).toBe("auto"); // strategy authorship
	});

	it("undoes a fold the strategy no longer wants (auto op in the delta)", async () => {
		const host = liveHostWith(4);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0", "a:b1:p0"] }];
		await host.commitTurn();
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }]; // drop b1
		await host.commitTurn();
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(true);
		expect(host.truth.isFolded(host.truth.get("a:b1:p0")!)).toBe(false); // undone
	});

	it("null = hold: proposes nothing, current state stands", async () => {
		const host = liveHostWith(3);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }];
		await host.commitTurn();
		const rev = host.truth.rev;
		c.desired = null;
		await host.commitTurn();
		expect(host.truth.rev).toBe(rev); // no new transaction
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(true);
	});

	it("a clamped fold does NOT enter tracked desired-state, so it is retried once unblocked", async () => {
		const parsed: ParsedSession = { meta: META, blocks: seq(3), lineCount: 0, skipped: 0 };
		const host = new TestHost(parsed); // bulk → all sent (no birth-fold exemption)
		host.setProtect(1500); // protect the newest ~2 (indices 1,2)
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b2:p0"] }]; // protected + sent → clamps
		await host.commitTurn();
		expect(host.truth.isFolded(host.truth.get("a:b2:p0")!)).toBe(false); // refused
		host.setProtect(0); // unblock
		await host.commitTurn();
		expect(host.truth.isFolded(host.truth.get("a:b2:p0")!)).toBe(true); // retried and applied
	});

	it("materializes contextWindow onto the view (handoff's output-token math needs it)", async () => {
		const host = liveHostWith(2);
		host.truth.setContextWindow(200_000);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [];
		await host.commitTurn();
		expect(c.lastView?.contextWindow).toBe(200_000);
	});
});

describe("ViewConductor — resync rebuild", () => {
	it("rebuilds tracked folds from actual truth state, so a later []-desire undoes them", async () => {
		const host = liveHostWith(3);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }];
		await host.commitTurn();
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(true);
		await host.resync(); // adapter rebuilds its tracked folded-set from truth
		c.desired = []; // now wants nothing folded
		await host.commitTurn();
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(false); // undone via the rebuild
	});

	// S4 — a resync must not strand a group the conductor still owns: it has to be re-claimed into
	// `appliedGroups` so a later []-desire diffs it away with `ungroup` instead of leaving it stuck
	// in Truth forever.
	it("re-claims a strategy-owned group across a resync, so a later []-desire ungroups it instead of stranding it", async () => {
		const host = liveHostWith(5);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }];
		await host.commitTurn();
		expect(host.truth.groups.length).toBe(1);
		await host.resync(); // structural resync — WITHOUT a truth state reset; the group is still there
		c.desired = []; // now wants no group at all
		await host.commitTurn();
		expect(host.truth.groups.length).toBe(0); // ungrouped via the rebuild, not stranded
	});
});

describe("ViewConductor — group diffing", () => {
	it("proposes a group op and undoes it when no longer desired", async () => {
		const host = liveHostWith(5);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "group", ids: ["a:b1:p0", "a:b2:p0"] }];
		await host.commitTurn();
		expect(host.truth.groups.length).toBe(1);
		expect(host.truth.isFolded(host.truth.get("a:b1:p0")!)).toBe(true);
		c.desired = [];
		await host.commitTurn();
		expect(host.truth.groups.length).toBe(0); // ungrouped
	});
});

describe("ViewConductor — replace recoverable default (S1)", () => {
	it("a ReplaceCommand with no `recoverable` substitutes VERBATIM (no {#... FOLDED} tag); recoverable:true tags it", async () => {
		const host = liveHostWith(3);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "replace", id: "a:b0:p0", content: "plain summary" }]; // recoverable omitted
		await host.commitTurn();
		expect(host.truth.digestOf(host.truth.get("a:b0:p0")!)).toBe("plain summary"); // verbatim, no tag

		c.desired = [{ kind: "replace", id: "a:b1:p0", content: "tagged summary", recoverable: true }];
		await host.commitTurn();
		expect(host.truth.digestOf(host.truth.get("a:b1:p0")!)).toMatch(/^\{#[0-9a-z]{6} FOLDED\} tagged summary$/);
	});
});

describe("ViewConductor — lifecycle", () => {
	it("rerun() is a no-op after detach", async () => {
		const host = liveHostWith(3);
		const c = new ScriptedConductor();
		c.attach(host);
		c.detach();
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }];
		const rev = host.truth.rev;
		await c.runNow(); // guarded — must do nothing
		expect(host.truth.rev).toBe(rev);
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(false);
	});

	it("wire-departing only triggers a rerun when holdWireUpToMs > 0", async () => {
		const host = liveHostWith(3);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }];
		await host.departWire(); // holdWireUpToMs defaults to 0 → no rerun
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(false);
	});
});

describe("ViewConductor — state-changed reruns immediately (Fix 4, restores main's per-pass UX)", () => {
	it("a config change (budget/protect) triggers a rerun WITHOUT waiting for a turn to commit", async () => {
		const host = liveHostWith(4);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }];

		// No commitTurn() anywhere — only a config dial change (`setBudget` emits a Truth "config"
		// event, which `hostAdapter.ts`'s `hostEventsFromTruthEvent` maps to `state-changed`).
		host.setBudget(500);
		await flush();

		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(true);
	});

	it("a conductor's own successful propose does not recursively re-trigger itself (busy guard)", async () => {
		const host = liveHostWith(4);
		const c = new ScriptedConductor();
		c.attach(host);
		c.desired = [{ kind: "fold", ids: ["a:b0:p0"] }];

		// turn-committed -> rerun -> conduct() #1 -> propose folds b0 -> Truth.apply fires
		// ops-applied SYNCHRONOUSLY (inside the same call stack as propose itself) -> state-changed
		// -> onHostEvent -> would call rerun() again if not guarded by `busy`.
		await host.commitTurn();

		expect(c.conductCalls).toBe(1); // the self-triggered state-changed must NOT cause a second call
		expect(host.truth.isFolded(host.truth.get("a:b0:p0")!)).toBe(true);

		// The guard only suppresses the reentrant self-triggered event — a genuinely later, external
		// state-changed still reacts normally (the guard does not wedge shut).
		host.setBudget(700);
		await flush();
		expect(c.conductCalls).toBe(2);
	});
});
