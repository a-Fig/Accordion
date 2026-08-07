import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mySurfaceId, markSurfaceDialed, _resetSurfaceIdForTests } from "./surfaceId";

/*
 * surfaceId.test.ts — the per-tab surface identity + duplicate-tab dedupe (v16, ADR 0024 §5, F1).
 *
 * Two properties are load-bearing and both are unit-testable without a real browser:
 *   1. The id is read/written through `window.sessionStorage` — NEVER localStorage (the whole reason
 *      per-tab identity survives the door putting every surface on one origin).
 *   2. The BroadcastChannel dedupe: a not-yet-dialed newcomer re-mints when a peer announces its id
 *      is taken; an established/dialed context defends its id and never re-mints; failure-open when
 *      BroadcastChannel is unavailable.
 *
 * A REAL two-browser-tab end-to-end (open a duplicate, watch its sessionStorage diverge) is NOT
 * feasible in a headless vitest process — there is only one JS realm here. Instead we drive the
 * module's own channel directly with a controllable fake BroadcastChannel, which exercises the exact
 * same message paths a second tab would trigger.
 */

const KEY = "accordion_surface_id";

/** A minimal in-memory Storage stand-in (vitest "node" env has no real Storage). */
function fakeStorage(seed?: Record<string, string>): Storage {
	const m = new Map<string, string>(seed ? Object.entries(seed) : []);
	return {
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
		key: () => null,
		get length() {
			return m.size;
		},
	} as Storage;
}

/** A fake BroadcastChannel: records posts and lets a test DELIVER inbound messages by invoking the
 *  module's own `onmessage`. `last` grabs whatever instance the module just constructed. */
class FakeBroadcastChannel {
	static last: FakeBroadcastChannel | null = null;
	static reset() {
		FakeBroadcastChannel.last = null;
	}
	name: string;
	onmessage: ((ev: { data: unknown }) => void) | null = null;
	posted: unknown[] = [];
	closed = false;
	constructor(name: string) {
		this.name = name;
		FakeBroadcastChannel.last = this;
	}
	postMessage(m: unknown): void {
		this.posted.push(m);
	}
	close(): void {
		this.closed = true;
	}
	/** Simulate another live context posting `m` onto the channel. */
	deliver(m: unknown): void {
		this.onmessage?.({ data: m });
	}
}

let hadWindow: boolean;
let savedWindow: unknown;
let hadBC: boolean;
let savedBC: unknown;

function installWindow(session: Storage, local?: Storage): void {
	(globalThis as any).window = { sessionStorage: session, localStorage: local ?? fakeStorage() };
}

beforeEach(() => {
	hadWindow = "window" in globalThis;
	savedWindow = (globalThis as any).window;
	hadBC = "BroadcastChannel" in globalThis;
	savedBC = (globalThis as any).BroadcastChannel;
	FakeBroadcastChannel.reset();
	_resetSurfaceIdForTests();
});

afterEach(() => {
	_resetSurfaceIdForTests();
	if (hadWindow) (globalThis as any).window = savedWindow;
	else delete (globalThis as any).window;
	if (hadBC) (globalThis as any).BroadcastChannel = savedBC;
	else delete (globalThis as any).BroadcastChannel;
	vi.useRealTimers();
});

describe("mySurfaceId — sessionStorage, never localStorage", () => {
	it("mints into sessionStorage and leaves localStorage untouched", () => {
		const ss = fakeStorage();
		const ls = fakeStorage();
		const lsSet = vi.spyOn(ls, "setItem");
		installWindow(ss, ls);
		delete (globalThis as any).BroadcastChannel; // isolate this from the dedupe path

		const id = mySurfaceId();
		expect(id).toBeTruthy();
		expect(id).not.toBe("ephemeral");
		expect(ss.getItem(KEY)).toBe(id); // persisted to sessionStorage
		expect(ls.getItem(KEY)).toBeNull(); // localStorage NEVER written
		expect(lsSet).not.toHaveBeenCalled();
	});

	it("is stable across repeated reads within the tab (survives this tab's reloads)", () => {
		installWindow(fakeStorage({ [KEY]: "existing-id" }));
		delete (globalThis as any).BroadcastChannel;
		expect(mySurfaceId()).toBe("existing-id");
		expect(mySurfaceId()).toBe("existing-id");
	});

	it("returns 'ephemeral' under SSR (no window) without throwing", () => {
		delete (globalThis as any).window;
		expect(mySurfaceId()).toBe("ephemeral");
	});

	it("returns 'ephemeral' when storage throws (private mode)", () => {
		const throwing = {
			getItem() {
				throw new Error("blocked");
			},
			setItem() {
				throw new Error("blocked");
			},
		} as unknown as Storage;
		installWindow(throwing);
		delete (globalThis as any).BroadcastChannel;
		expect(mySurfaceId()).toBe("ephemeral");
	});

	it("two distinct storage contexts mint DISTINCT ids", () => {
		const ssA = fakeStorage();
		installWindow(ssA);
		delete (globalThis as any).BroadcastChannel;
		const idA = mySurfaceId();

		_resetSurfaceIdForTests();
		const ssB = fakeStorage();
		installWindow(ssB);
		const idB = mySurfaceId();

		expect(idA).not.toBe(idB);
		expect(ssA.getItem(KEY)).toBe(idA);
		expect(ssB.getItem(KEY)).toBe(idB);
	});
});

describe("BroadcastChannel duplicate-tab dedupe", () => {
	beforeEach(() => {
		(globalThis as any).BroadcastChannel = FakeBroadcastChannel;
	});

	it("announces its id with an id-check on startup", () => {
		installWindow(fakeStorage({ [KEY]: "shared-id" }));
		mySurfaceId();
		const ch = FakeBroadcastChannel.last!;
		expect(ch).not.toBeNull();
		expect(ch.posted).toContainEqual(expect.objectContaining({ kind: "id-check", id: "shared-id" }));
	});

	it("newcomer re-mints a fresh id when a peer replies in-use (the duplicated-tab case)", () => {
		const ss = fakeStorage({ [KEY]: "shared-id" });
		installWindow(ss);
		expect(mySurfaceId()).toBe("shared-id"); // starts on the copied id

		// Another live context that already owns "shared-id" answers in-use.
		FakeBroadcastChannel.last!.deliver({ kind: "in-use", id: "shared-id", nonce: "other-context" });

		const after = mySurfaceId();
		expect(after).not.toBe("shared-id"); // re-minted
		expect(ss.getItem(KEY)).toBe(after); // and persisted to OUR sessionStorage
	});

	it("newcomer re-mints when it sees another context's id-check for our id (both freshly duplicated)", () => {
		const ss = fakeStorage({ [KEY]: "shared-id" });
		installWindow(ss);
		mySurfaceId();
		FakeBroadcastChannel.last!.deliver({ kind: "id-check", id: "shared-id", nonce: "other-newcomer" });
		expect(mySurfaceId()).not.toBe("shared-id");
	});

	it("keeps its id on timeout silence (no peer owns it → nobody replies)", () => {
		vi.useFakeTimers();
		installWindow(fakeStorage({ [KEY]: "solo-id" }));
		expect(mySurfaceId()).toBe("solo-id");
		vi.advanceTimersByTime(500); // window closes with no reply
		expect(mySurfaceId()).toBe("solo-id");
	});

	it("does NOT re-mint on an in-use that arrives AFTER the newcomer window closed (defends its id)", () => {
		vi.useFakeTimers();
		installWindow(fakeStorage({ [KEY]: "older-id" }));
		mySurfaceId();
		vi.advanceTimersByTime(500); // newcomer window closes → we now defend the id
		FakeBroadcastChannel.last!.deliver({ kind: "in-use", id: "older-id", nonce: "late-peer" });
		expect(mySurfaceId()).toBe("older-id");
	});

	it("an established (dialed) context replies in-use to a peer id-check and NEVER re-mints", () => {
		installWindow(fakeStorage({ [KEY]: "held-id" }));
		mySurfaceId();
		markSurfaceDialed(); // this surface is now connected/established
		const ch = FakeBroadcastChannel.last!;
		ch.posted.length = 0; // ignore the startup id-check

		ch.deliver({ kind: "id-check", id: "held-id", nonce: "a-newcomer" });

		expect(ch.posted).toContainEqual(expect.objectContaining({ kind: "in-use", id: "held-id" })); // defended
		expect(mySurfaceId()).toBe("held-id"); // never re-minted
	});

	it("ignores messages for a DIFFERENT id and our own nonce echoes", () => {
		installWindow(fakeStorage({ [KEY]: "my-id" }));
		mySurfaceId();
		const ch = FakeBroadcastChannel.last!;
		const startPost = (ch.posted[0] as { nonce: string }).nonce;
		ch.deliver({ kind: "in-use", id: "someone-elses-id", nonce: "x" }); // different id → ignored
		ch.deliver({ kind: "in-use", id: "my-id", nonce: startPost }); // our own nonce → ignored
		expect(mySurfaceId()).toBe("my-id");
	});
});

describe("failure-open", () => {
	it("proceeds with the sessionStorage id when BroadcastChannel is unavailable", () => {
		installWindow(fakeStorage({ [KEY]: "no-bc-id" }));
		delete (globalThis as any).BroadcastChannel;
		expect(() => mySurfaceId()).not.toThrow();
		expect(mySurfaceId()).toBe("no-bc-id");
	});

	it("proceeds with the sessionStorage id when the BroadcastChannel constructor throws", () => {
		installWindow(fakeStorage({ [KEY]: "throw-bc-id" }));
		(globalThis as any).BroadcastChannel = class {
			constructor() {
				throw new Error("BC blocked");
			}
		};
		expect(() => mySurfaceId()).not.toThrow();
		expect(mySurfaceId()).toBe("throw-bc-id");
	});
});
