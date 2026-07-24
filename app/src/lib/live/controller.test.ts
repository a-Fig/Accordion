/*
 * controller.test.ts — the controller-lease freshness/shape guards (v16, ADR 0024).
 *
 * These pure predicates are the decision core the extension's READ-ONLY enforcement and a client's
 * auto-claim/takeover choice both read: `isFreshLease` decides "is this session controlled right
 * now" (a stale heartbeat ⇒ uncontrolled ⇒ any surface may silently claim), and `isControllerLease`
 * vets the on-disk shape before it is ever trusted (authorized ≠ well-formed — controller.json is a
 * shared, any-extension-writable blackboard).
 */
import { describe, it, expect } from "vitest";
import {
	isFreshLease,
	isControllerLease,
	CONTROLLER_STALE_AFTER_MS,
	REGISTRY_PROTOCOL,
	type ControllerLease,
} from "./registry";

const NOW = 1_000_000_000;

function lease(over: Partial<ControllerLease> = {}): ControllerLease {
	return {
		registryProtocol: REGISTRY_PROTOCOL,
		surfaceId: "s-abc",
		label: "Desktop app",
		claimedAt: NOW - 10_000,
		heartbeatAt: NOW,
		...over,
	};
}

describe("isFreshLease — the 'is this session controlled' predicate", () => {
	it("is fresh when the heartbeat is within the staleness window", () => {
		expect(isFreshLease(lease({ heartbeatAt: NOW }), NOW)).toBe(true);
		expect(isFreshLease(lease({ heartbeatAt: NOW - CONTROLLER_STALE_AFTER_MS }), NOW)).toBe(true); // exactly at the edge
	});

	it("is STALE once the heartbeat is older than the window (uncontrolled ⇒ any surface may claim)", () => {
		expect(isFreshLease(lease({ heartbeatAt: NOW - CONTROLLER_STALE_AFTER_MS - 1 }), NOW)).toBe(false);
		expect(isFreshLease(lease({ heartbeatAt: NOW - 60_000 }), NOW)).toBe(false);
	});

	it("rejects a null/mis-shaped/old-protocol value rather than treating it as a fresh lease", () => {
		expect(isFreshLease(null, NOW)).toBe(false);
		expect(isFreshLease({}, NOW)).toBe(false);
		expect(isFreshLease(lease({ surfaceId: "" }), NOW)).toBe(false);
		expect(isFreshLease({ ...lease(), registryProtocol: 999 }, NOW)).toBe(false);
		expect(isFreshLease({ ...lease(), heartbeatAt: "nope" as unknown as number }, NOW)).toBe(false);
	});
});

describe("isControllerLease — shape guard (freshness-independent)", () => {
	it("accepts a well-formed lease regardless of heartbeat age", () => {
		expect(isControllerLease(lease({ heartbeatAt: NOW - 999_999 }))).toBe(true);
	});

	it("rejects a non-object, wrong protocol, or a lease missing required fields", () => {
		expect(isControllerLease(null)).toBe(false);
		expect(isControllerLease("controller.json")).toBe(false);
		expect(isControllerLease({ ...lease(), registryProtocol: 2 })).toBe(false);
		expect(isControllerLease({ surfaceId: "s", label: "L" })).toBe(false); // no claimedAt/heartbeatAt
		expect(isControllerLease({ ...lease(), surfaceId: 42 })).toBe(false);
	});
});
