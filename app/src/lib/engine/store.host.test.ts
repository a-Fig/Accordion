/*
 * store.host.test.ts — tests for the ConductorHost wiring in AccordionStore.
 *
 * Verifies the host-capabilities object the store builds and passes to conductors:
 *   - can("complete") reflects store.completer
 *   - can("countTokens") and can("digest") are always true
 *   - complete() rejects when no completer; delegates when one is set
 *   - countTokens() returns a number
 *   - digestOf(id) returns engine digest for a known block, null for unknown
 *   - requestRerun() triggers a refold (conduct is re-called)
 *   - Lifecycle: outgoing conductor is detached before incoming is attached;
 *               detach is called exactly once per instance
 */

import { describe, it, expect } from "vitest";
import { AccordionStore } from "./store.svelte";
import type { Block, ParsedSession } from "./types";
import type {
	Conductor,
	ConductorHost,
	ConductorView,
	Command,
	CompletionRequest,
	CompletionResult,
} from "$conductors/contract";

// ── Test helpers ──────────────────────────────────────────────────────────────

function blk(
	i: number,
	kind: Block["kind"] = "text",
	tokens = 1000,
	extra: Partial<Block> = {},
): Block {
	return {
		id: `m${i}:p0`,
		kind,
		turn: i + 1,
		order: i,
		text: `block ${i} ` + "x".repeat(tokens * 4),
		tokens,
		override: null,
		autoFolded: false,
		by: null,
		...extra,
	};
}

function makeStore(blocks: Block[]): AccordionStore {
	const parsed: ParsedSession = {
		meta: { format: "pi", title: "t", cwd: "", model: "" },
		blocks,
		lineCount: 0,
		skipped: 0,
	};
	return new AccordionStore(parsed);
}

// ── Lifecycle-tracking conductor ──────────────────────────────────────────────

class TrackingConductor implements Conductor {
	readonly id: string;
	readonly label: string;
	attachCalls = 0;
	detachCalls = 0;
	conductCalls = 0;
	capturedHost: ConductorHost | null = null;
	cmds: Command[] | null = [];

	constructor(id = "tracking") {
		this.id = id;
		this.label = id;
	}

	attach(host: ConductorHost): void {
		this.attachCalls++;
		this.capturedHost = host;
	}

	conduct(_view: ConductorView): Command[] | null {
		this.conductCalls++;
		return this.cmds;
	}

	detach(): void {
		this.detachCalls++;
	}
}

// ── 1. can() reflects capabilities ───────────────────────────────────────────

describe("AccordionStore host — can()", () => {
	it("can('complete') is false when store.completer is null (default)", () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		expect(conductor.capturedHost).not.toBeNull();
		expect(conductor.capturedHost!.can("complete")).toBe(false);
	});

	it("can('complete') is true when store.completer is set", () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		// Set a stub completer
		s.completer = (_req: CompletionRequest) =>
			Promise.resolve({ text: "stub", model: "stub-model" });

		expect(conductor.capturedHost!.can("complete")).toBe(true);
	});

	it("can('complete') goes back to false when completer is cleared", () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		s.completer = () => Promise.resolve({ text: "x", model: "m" });
		expect(conductor.capturedHost!.can("complete")).toBe(true);

		s.completer = null;
		expect(conductor.capturedHost!.can("complete")).toBe(false);
	});

	it("can('countTokens') is always true", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		expect(conductor.capturedHost!.can("countTokens")).toBe(true);
	});

	it("can('digest') is always true", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		expect(conductor.capturedHost!.can("digest")).toBe(true);
	});
});

// ── 2. complete() delegation ──────────────────────────────────────────────────

describe("AccordionStore host — complete()", () => {
	it("rejects immediately when store.completer is null", async () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const req: CompletionRequest = { prompt: "test prompt" };
		await expect(conductor.capturedHost!.complete(req)).rejects.toThrow(
			"completion capability unavailable",
		);
	});

	it("delegates to store.completer when set and returns its result", async () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const receivedReqs: CompletionRequest[] = [];
		const expectedResult: CompletionResult = { text: "LLM output", model: "test-model-123" };

		s.completer = (req: CompletionRequest) => {
			receivedReqs.push(req);
			return Promise.resolve(expectedResult);
		};

		const req: CompletionRequest = { prompt: "summarize this", system: "be brief" };
		const result = await conductor.capturedHost!.complete(req);

		// The completer received the exact request object
		expect(receivedReqs).toHaveLength(1);
		expect(receivedReqs[0]).toBe(req);

		// The resolved value flows back unchanged
		expect(result).toBe(expectedResult);
		expect(result.text).toBe("LLM output");
		expect(result.model).toBe("test-model-123");
	});

	it("rejection from the completer propagates through the host", async () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const boom = new Error("model unavailable");
		s.completer = () => Promise.reject(boom);

		await expect(conductor.capturedHost!.complete({ prompt: "x" })).rejects.toThrow(
			"model unavailable",
		);
	});

	it("completer set AFTER attach is still reachable via the stable host reference", async () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor); // attach is called here; completer is null at this point

		// Set completer AFTER attach
		s.completer = () => Promise.resolve({ text: "late", model: "late-model" });

		// The host reference given at attach should still see the new completer
		const result = await conductor.capturedHost!.complete({ prompt: "p" });
		expect(result.text).toBe("late");
	});
});

// ── 3. countTokens() ─────────────────────────────────────────────────────────

describe("AccordionStore host — countTokens()", () => {
	it("returns a positive number for non-empty text", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const count = conductor.capturedHost!.countTokens("hello world");
		expect(typeof count).toBe("number");
		expect(count).toBeGreaterThan(0);
	});

	it("returns 0 or a small number for empty string", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const count = conductor.capturedHost!.countTokens("");
		expect(typeof count).toBe("number");
		expect(count).toBeGreaterThanOrEqual(0);
	});

	it("longer text yields more tokens than shorter text", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const host = conductor.capturedHost!;
		const short = host.countTokens("hi");
		const long = host.countTokens("x".repeat(1000));
		expect(long).toBeGreaterThan(short);
	});

	it("uses the chars/4 estimate consistent with the engine", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		// 400 chars / 4 = 100 tokens (using estTokens from engine/tokens.ts)
		const text = "a".repeat(400);
		const count = conductor.capturedHost!.countTokens(text);
		expect(count).toBe(100);
	});
});

// ── 4. digestOf() ────────────────────────────────────────────────────────────

describe("AccordionStore host — digestOf()", () => {
	it("returns a non-null string for a known block id", () => {
		const s = makeStore([blk(0), blk(1)]);
		s.setProtect(0); // unprotect so blocks have digests
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const d = conductor.capturedHost!.digestOf("m0:p0");
		expect(d).not.toBeNull();
		expect(typeof d).toBe("string");
		expect(d!.length).toBeGreaterThan(0);
	});

	it("returns null for an unknown block id", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const d = conductor.capturedHost!.digestOf("ghost:p999");
		expect(d).toBeNull();
	});

	it("digest for a foldable kind (text) contains the {# FOLDED tag", () => {
		const s = makeStore([blk(0, "text")]);
		s.setProtect(0);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const d = conductor.capturedHost!.digestOf("m0:p0");
		expect(d).not.toBeNull();
		expect(d).toContain("FOLDED");
	});

	it("returns different digests for different block ids", () => {
		const s = makeStore([blk(0), blk(1)]);
		s.setProtect(0);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const d0 = conductor.capturedHost!.digestOf("m0:p0");
		const d1 = conductor.capturedHost!.digestOf("m1:p0");
		expect(d0).not.toBeNull();
		expect(d1).not.toBeNull();
		// Different blocks → different digests (they encode the block id)
		expect(d0).not.toBe(d1);
	});
});

// ── 5. requestRerun() triggers a refold ────────────────────────────────────────

describe("AccordionStore host — requestRerun()", () => {
	it("calling requestRerun() causes the conductor's conduct() to be called again", async () => {
		const s = makeStore([blk(0), blk(1), blk(2)]);
		s.setProtect(0);

		const conductor = new TrackingConductor();
		s.attach(conductor);

		const callsBefore = conductor.conductCalls;

		// requestRerun() should schedule/trigger a refold which calls conduct
		conductor.capturedHost!.requestRerun();
		await Promise.resolve();

		expect(conductor.conductCalls).toBeGreaterThan(callsBefore);
	});

	it("store state changes after requestRerun() + conduct emitting commands", async () => {
		const s = makeStore([blk(0), blk(1), blk(2), blk(3)]);
		s.setProtect(0);

		const conductor = new TrackingConductor();
		conductor.cmds = []; // initially: nothing folded
		s.attach(conductor);

		expect(s.foldedCount).toBe(0);

		// Now the conductor will ask to fold m0:p0 on the next pass
		conductor.cmds = [{ kind: "fold", ids: ["m0:p0"] }];
		conductor.capturedHost!.requestRerun();
		await Promise.resolve();

		expect(s.isFolded(s.get("m0:p0")!)).toBe(true);
	});

	it("requestRerun() from a detached conductor is a no-op — does not trigger a refold on the current conductor", async () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor1 = new TrackingConductor("c1");
		s.attach(conductor1);

		const host1 = conductor1.capturedHost!;

		// Swap to a new conductor — conductor1 is now detached
		const conductor2 = new TrackingConductor("c2");
		s.attach(conductor2);

		const conductCalls2Before = conductor2.conductCalls;

		// The old host's requestRerun must NOT trigger another pass on conductor2 and must not throw
		expect(() => host1.requestRerun()).not.toThrow();
		await Promise.resolve();

		// The identity guard: host1 was built for conductor1, which is no longer attached.
		// conductor2.conductCalls must NOT increase — the stale requestRerun() is silently ignored.
		expect(conductor2.conductCalls).toBe(conductCalls2Before);

		// State remains coherent regardless.
		expect(s.foldedCount).toBeGreaterThanOrEqual(0);
	});
});

// ── 6. Lifecycle: detach / attach order ───────────────────────────────────────

describe("AccordionStore host — conductor lifecycle (attach / detach)", () => {
	it("attach() calls the new conductor's attach(host) before the first conduct()", () => {
		const s = makeStore([blk(0), blk(1)]);

		const conductor = new TrackingConductor();
		s.attach(conductor);

		expect(conductor.attachCalls).toBe(1);
		expect(conductor.capturedHost).not.toBeNull();
		// conduct is called during refold() triggered by attach
		expect(conductor.conductCalls).toBeGreaterThan(0);
	});

	it("attach() detaches the outgoing conductor before attaching the incoming one", () => {
		const s = makeStore([blk(0), blk(1)]);

		const order: string[] = [];

		class OrderedConductor extends TrackingConductor {
			constructor(id: string) {
				super(id);
			}
			override attach(host: ConductorHost): void {
				order.push(`attach:${this.id}`);
				super.attach(host);
			}
			override detach(): void {
				order.push(`detach:${this.id}`);
				super.detach();
			}
		}

		const c1 = new OrderedConductor("c1");
		const c2 = new OrderedConductor("c2");

		s.attach(c1);
		order.length = 0; // reset after first attach

		s.attach(c2);

		// detach(c1) must come before attach(c2)
		const detachIdx = order.indexOf("detach:c1");
		const attachIdx = order.indexOf("attach:c2");
		expect(detachIdx).toBeGreaterThanOrEqual(0);
		expect(attachIdx).toBeGreaterThanOrEqual(0);
		expect(detachIdx).toBeLessThan(attachIdx);
	});

	it("detach() is called exactly once per conductor instance when swapped out", () => {
		const s = makeStore([blk(0), blk(1)]);

		const c1 = new TrackingConductor("c1");
		const c2 = new TrackingConductor("c2");

		s.attach(c1);
		s.attach(c2); // swaps out c1

		expect(c1.detachCalls).toBe(1);
		expect(c2.detachCalls).toBe(0); // c2 is still active
	});

	it("detach() detaches the active conductor exactly once", () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		expect(conductor.detachCalls).toBe(0);
		s.detach();
		expect(conductor.detachCalls).toBe(1);
	});

	it("detach() after detach does not double-detach", () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		s.detach();
		s.detach(); // second detach: no conductor active, should be a no-op

		// conductor was detached exactly once (from the first detach)
		expect(conductor.detachCalls).toBe(1);
	});

	it("attach is called exactly once per attach(), not on refold()", () => {
		const s = makeStore([blk(0), blk(1)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		// Trigger multiple refolds
		s.refold();
		s.refold();
		s.refold();

		expect(conductor.attachCalls).toBe(1); // attach only once
	});

	it("a pure conductor (no attach method) does not throw when attached", () => {
		const s = makeStore([blk(0), blk(1)]);

		// Conductor with no attach or detach methods
		class PureConductor implements Conductor {
			readonly id = "pure";
			readonly label = "Pure";
			conduct(): Command[] {
				return [];
			}
		}

		expect(() => s.attach(new PureConductor())).not.toThrow();
	});
});

// ── 7. Host object is stable per attach ──────────────────────────────────────

describe("AccordionStore host — host reference stability", () => {
	it("the same host object is passed across all conduct() calls for a single attach", () => {
		const s = makeStore([blk(0), blk(1), blk(2)]);
		s.setProtect(0);

		const hostsReceived: ConductorHost[] = [];

		class HostRecordingConductor implements Conductor {
			readonly id = "recorder";
			readonly label = "Recorder";
			private host: ConductorHost | null = null;
			attach(h: ConductorHost) {
				this.host = h;
			}
			conduct(_v: ConductorView): Command[] {
				if (this.host) hostsReceived.push(this.host);
				return [];
			}
		}

		const c = new HostRecordingConductor();
		s.attach(c);

		// Trigger multiple refolds
		s.refold();
		s.refold();

		expect(hostsReceived.length).toBeGreaterThan(1);
		// All conduct() calls received the same host object (reference equality)
		const first = hostsReceived[0];
		for (const h of hostsReceived) {
			expect(h).toBe(first);
		}
	});

	it("a new host object is built for each fresh attach", () => {
		const s = makeStore([blk(0)]);

		const c1 = new TrackingConductor("c1");
		const c2 = new TrackingConductor("c2");

		s.attach(c1);
		const host1 = c1.capturedHost;

		s.attach(c2);
		const host2 = c2.capturedHost;

		expect(host1).not.toBeNull();
		expect(host2).not.toBeNull();
		expect(host1).not.toBe(host2);
	});
});

// ── 8. complete() passes signal through ──────────────────────────────────────

describe("AccordionStore host — complete() request forwarding", () => {
	it("passes the full CompletionRequest including system, maxOutputTokens, signal, and model", async () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		const receivedReqs: CompletionRequest[] = [];
		s.completer = (req) => {
			receivedReqs.push(req);
			return Promise.resolve({ text: "ok", model: "m" });
		};

		const controller = new AbortController();
		const req: CompletionRequest = {
			prompt: "do the thing",
			system: "be terse",
			maxOutputTokens: 500,
			signal: controller.signal,
			model: "test-model",
		};

		await conductor.capturedHost!.complete(req);

		expect(receivedReqs).toHaveLength(1);
		expect(receivedReqs[0].prompt).toBe("do the thing");
		expect(receivedReqs[0].system).toBe("be terse");
		expect(receivedReqs[0].maxOutputTokens).toBe(500);
		expect(receivedReqs[0].signal).toBe(controller.signal);
		expect(receivedReqs[0].model).toBe("test-model");
	});

	it("rejects complete() from a stale host after conductor swap without calling the completer", async () => {
		const s = makeStore([blk(0)]);
		const c1 = new TrackingConductor("c1");
		const c2 = new TrackingConductor("c2");
		s.attach(c1);
		const oldHost = c1.capturedHost!;

		let calls = 0;
		s.completer = async () => {
			calls++;
			return { text: "should not run", model: "m" };
		};

		s.attach(c2);

		expect(oldHost.can("complete")).toBe(false);
		await expect(oldHost.complete({ prompt: "stale" })).rejects.toThrow("stale conductor host");
		expect(calls).toBe(0);
	});

	it("rejects complete() from a stale host after detach without calling the completer", async () => {
		const s = makeStore([blk(0)]);
		const c = new TrackingConductor("c");
		s.attach(c);
		const oldHost = c.capturedHost!;

		let calls = 0;
		s.completer = async () => {
			calls++;
			return { text: "should not run", model: "m" };
		};

		s.detach();

		expect(oldHost.can("complete")).toBe(false);
		await expect(oldHost.complete({ prompt: "stale" })).rejects.toThrow("stale conductor host");
		expect(calls).toBe(0);
	});
});

// ── 9. setStatus() display telemetry ────────────────────────────────────────

describe("AccordionStore host — setStatus()", () => {
	it("surfaces and clears display-only status from the attached conductor", () => {
		const s = makeStore([blk(0)]);
		const conductor = new TrackingConductor();
		s.attach(conductor);

		conductor.capturedHost!.setStatus("waiting for live model link", { aged: 3 });
		expect(s.conductorStatus.text).toBe("waiting for live model link");
		expect(s.conductorStatus.metrics.aged).toBe(3);

		conductor.capturedHost!.setStatus(null);
		expect(s.conductorStatus.text).toBe("");
		expect(s.conductorStatus.metrics).toEqual({});
	});

	it("ignores setStatus() from a stale detached conductor host", () => {
		const s = makeStore([blk(0)]);
		const c1 = new TrackingConductor("c1");
		const c2 = new TrackingConductor("c2");
		s.attach(c1);
		const oldHost = c1.capturedHost!;
		s.attach(c2);

		oldHost.setStatus("stale");
		expect(s.conductorStatus.text).toBe("");
	});
});
