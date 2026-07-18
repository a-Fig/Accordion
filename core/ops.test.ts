/*
 * ops.test.ts — the host-only op guard (`applyGuardingHostOnly` / `isHostOnlyOp`).
 *
 * `freeze` is the conductor-detach kill switch: it is intentionally ungated in `Truth.opFreeze`
 * (host-only detach semantics). These tests pin the wire-entry guard that keeps it from reaching
 * `Truth.apply` when it arrives from a GUI `ops` command or a conductor `propose` — the guard strips
 * it, reports a `locked` clamp in the op's original position, and passes everything else through.
 */
import { describe, it, expect } from "vitest";
import { applyGuardingHostOnly, isHostOnlyOp, isValidOp, sanitizeOps, HOST_ONLY_OP_KINDS, type Op, type OpResult, type TxnResult } from "./ops";

describe("host-only op guard", () => {
	it("classifies freeze as host-only and ordinary ops as not", () => {
		expect(HOST_ONLY_OP_KINDS.has("freeze")).toBe(true);
		expect(isHostOnlyOp({ kind: "freeze" })).toBe(true);
		expect(isHostOnlyOp({ kind: "fold", ids: ["a"] })).toBe(false);
		expect(isHostOnlyOp({ kind: "resetAll" })).toBe(false);
	});

	it("passes a freeze-free batch straight through (same ops reach apply)", () => {
		const ops: Op[] = [{ kind: "fold", ids: ["a"] }, { kind: "pin", ids: ["b"] }];
		let seen: Op[] | null = null;
		const inner: TxnResult = { rev: 7, results: ops.map((op) => ({ op, applied: true })) };
		const out = applyGuardingHostOnly(ops, (allowed) => {
			seen = allowed;
			return inner;
		});
		expect(seen).toBe(ops); // no filtering / no array churn on the fast path
		expect(out).toBe(inner);
	});

	it("strips a freeze op, reports it as a locked clamp in-position, threads the rest", () => {
		const ops: Op[] = [
			{ kind: "fold", ids: ["a"] },
			{ kind: "freeze" },
			{ kind: "pin", ids: ["b"] },
		];
		let seen: Op[] | null = null;
		const out = applyGuardingHostOnly(ops, (allowed) => {
			seen = allowed;
			// The apply closure only ever sees the allowed ops (freeze never reaches Truth).
			const results: OpResult[] = allowed.map((op) => ({ op, applied: true }));
			return { rev: 42, results };
		});
		expect(seen).toEqual([{ kind: "fold", ids: ["a"] }, { kind: "pin", ids: ["b"] }]);
		expect(out.rev).toBe(42); // the real post-apply rev
		expect(out.results).toHaveLength(3); // one result per ORIGINAL op
		expect(out.results[0].applied).toBe(true);
		expect(out.results[1].applied).toBe(false);
		expect(out.results[1].clamped).toBe("locked");
		expect(out.results[1].op.kind).toBe("freeze");
		expect(out.results[2].applied).toBe(true);
	});

	it("refuses an all-freeze batch without ever calling apply with a freeze", () => {
		let seen: Op[] | null = null;
		const out = applyGuardingHostOnly([{ kind: "freeze" }, { kind: "freeze" }], (allowed) => {
			seen = allowed;
			return { rev: 3, results: [] };
		});
		expect(seen).toEqual([]); // nothing allowed through
		expect(out.results.every((r) => r.clamped === "locked" && !r.applied)).toBe(true);
		expect(out.results).toHaveLength(2);
	});

	// `isHostOnlyOp` runs on the wire ingress path where an authorized-but-buggy client can send a
	// non-object op. A raw `op.kind` deref would throw out of the WS callback and can kill the
	// extension; it must be shape-safe (a non-object is simply "not host-only").
	it("isHostOnlyOp is shape-safe on null / non-object / missing-kind input", () => {
		expect(isHostOnlyOp(null as unknown as Op)).toBe(false);
		expect(isHostOnlyOp(undefined as unknown as Op)).toBe(false);
		expect(isHostOnlyOp("freeze" as unknown as Op)).toBe(false); // a bare string, not an op object
		expect(isHostOnlyOp({} as unknown as Op)).toBe(false);
	});
});

// Structural op validation at the engine edge (fix #5): the message guards vet only the `type`
// tag, so a `command`/`propose` with a malformed `ops` array reaches Truth.apply and throws inside
// `applyOne`'s `op.kind` switch — out of the WS callback, taking down the extension. `isValidOp` /
// `sanitizeOps` are the shape gate the ingress runs first.
describe("isValidOp / sanitizeOps — structural op gate (fix #5)", () => {
	it("accepts every well-formed op kind", () => {
		const ok: unknown[] = [
			{ kind: "fold", ids: ["a"] },
			{ kind: "fold", ids: ["a"], digest: "x" },
			{ kind: "unfold", ids: ["a", "b"] },
			{ kind: "pin", ids: ["a"] },
			{ kind: "unpin", ids: ["a"] },
			{ kind: "auto", ids: ["a"] },
			{ kind: "replace", id: "a", content: "x" },
			{ kind: "replace", id: "a", content: "", recoverable: false },
			{ kind: "group", ids: ["a", "b"] },
			{ kind: "group", ids: ["a"], summary: null },
			{ kind: "ungroup", groupId: "g:a" },
			{ kind: "foldGroup", groupId: "g:a" },
			{ kind: "unfoldGroup", groupId: "g:a" },
			{ kind: "resetAll" },
			{ kind: "freeze" },
		];
		for (const o of ok) expect(isValidOp(o)).toBe(true);
	});

	it("rejects malformed shapes that would throw or mis-apply inside Truth", () => {
		expect(isValidOp(null)).toBe(false);
		expect(isValidOp("fold")).toBe(false);
		expect(isValidOp({})).toBe(false); // no kind
		expect(isValidOp({ kind: "bogus" })).toBe(false); // unknown kind
		expect(isValidOp({ kind: "fold" })).toBe(false); // missing ids
		expect(isValidOp({ kind: "fold", ids: "a" })).toBe(false); // ids not an array
		expect(isValidOp({ kind: "fold", ids: ["a", 3] })).toBe(false); // non-string id
		expect(isValidOp({ kind: "fold", ids: ["a"], digest: 7 })).toBe(false); // digest not a string
		expect(isValidOp({ kind: "replace", id: "a" })).toBe(false); // missing content
		expect(isValidOp({ kind: "replace", id: 1, content: "x" })).toBe(false); // id not a string
		expect(isValidOp({ kind: "ungroup" })).toBe(false); // missing groupId
	});

	it("sanitizeOps filters invalid elements and returns null on a non-array payload", () => {
		expect(sanitizeOps([{ kind: "fold", ids: ["a"] }, null, { kind: "bogus" }, { kind: "pin", ids: ["b"] }])).toEqual([
			{ kind: "fold", ids: ["a"] },
			{ kind: "pin", ids: ["b"] },
		]);
		expect(sanitizeOps([null, 3, "x"])).toEqual([]); // all invalid → empty (not null)
		expect(sanitizeOps(null)).toBeNull(); // not even an array → null
		expect(sanitizeOps({ kind: "fold", ids: ["a"] })).toBeNull(); // a single op, not an array
	});
});
