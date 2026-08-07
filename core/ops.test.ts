/*
 * ops.test.ts — the host-only op guard (`applyGuardingHostOnly` / `isHostOnlyOp`).
 *
 * `freeze` is the conductor-detach kill switch: it is intentionally ungated in `Truth.opFreeze`
 * (host-only detach semantics). These tests pin the wire-entry guard that keeps it from reaching
 * `Truth.apply` when it arrives from a GUI `ops` command or a conductor `propose` — the guard strips
 * it, reports a `locked` clamp in the op's original position, and passes everything else through.
 */
import { describe, it, expect } from "vitest";
import { applyGuardingHostOnly, isHostOnlyOp, HOST_ONLY_OP_KINDS, type Op, type OpResult, type TxnResult } from "./ops";

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
});
