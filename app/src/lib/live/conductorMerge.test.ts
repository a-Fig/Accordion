import { describe, it, expect } from "vitest";
import { mergeExternalConductors, type ExternalRow } from "./conductorMerge";
import type { ConductorEntry } from "./registry";

function entry(id: string, label = id, url = `ws://localhost/${id}`): ConductorEntry {
	return {
		registryProtocol: 1,
		conductorProtocol: 3,
		id,
		label,
		url,
		pid: 0,
		startedAt: 0,
		heartbeatAt: Date.now(),
	};
}

describe("mergeExternalConductors — ordering and deduplication", () => {
	it("returns discovered first, then launchable-stopped, then configured-only", () => {
		const discovered = [entry("alpha")];
		const launchable = [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }];
		const configured = [entry("gamma", "Gamma")];

		const rows = mergeExternalConductors(discovered, launchable, configured, new Set());

		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ kind: "running", id: "alpha" });
		expect(rows[1]).toMatchObject({ kind: "stopped", id: "beta" });
		expect(rows[2]).toMatchObject({ kind: "configured", id: "gamma" });
	});

	it("dedupes by id — a discovered entry wins over launchable and configured", () => {
		const discovered = [entry("shared")];
		const launchable = [{ id: "shared", label: "Shared" }];
		const configured = [entry("shared", "Shared-cfg")];

		const rows = mergeExternalConductors(discovered, launchable, configured, new Set());

		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("running");
	});

	it("launchable-stopped dedupes against configured (launchable wins)", () => {
		const launchable = [{ id: "overlap", label: "Overlap" }];
		const configured = [entry("overlap", "Overlap-cfg")];

		const rows = mergeExternalConductors([], launchable, configured, new Set());

		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("stopped");
		expect(rows[0].id).toBe("overlap");
	});
});

describe("mergeExternalConductors — canLaunch / canForget flags", () => {
	it("running entry gets canLaunch=true when it is also in the launchable list", () => {
		const discovered = [entry("foo")];
		const launchable = [{ id: "foo", label: "Foo" }];
		const rows = mergeExternalConductors(discovered, launchable, [], new Set());
		const row = rows[0] as Extract<ExternalRow, { kind: "running" }>;
		expect(row.canLaunch).toBe(true);
		expect(row.canForget).toBe(false);
	});

	it("running entry gets canForget=true when it is also configured", () => {
		const discovered = [entry("bar")];
		const configured = [entry("bar", "Bar-cfg")];
		const rows = mergeExternalConductors(discovered, [], configured, new Set());
		const row = rows[0] as Extract<ExternalRow, { kind: "running" }>;
		expect(row.canForget).toBe(true);
		expect(row.canLaunch).toBe(false);
	});

	it("running entry can have both canLaunch and canForget when discovered + launchable + configured", () => {
		const discovered = [entry("baz")];
		const launchable = [{ id: "baz", label: "Baz" }];
		const configured = [entry("baz", "Baz-cfg")];
		const rows = mergeExternalConductors(discovered, launchable, configured, new Set());
		const row = rows[0] as Extract<ExternalRow, { kind: "running" }>;
		expect(row.canLaunch).toBe(true);
		expect(row.canForget).toBe(true);
	});
});

describe("mergeExternalConductors — launching flag is decorative (doesn't change row structure)", () => {
	it("a stopped entry stays 'stopped' whether or not it is launching", () => {
		const launchable = [{ id: "qux", label: "Qux" }];
		const rowsIdle     = mergeExternalConductors([], launchable, [], new Set());
		const rowsLaunching = mergeExternalConductors([], launchable, [], new Set(["qux"]));
		// Both produce a 'stopped' row — the launching decoration is applied by the UI, not here.
		expect(rowsIdle[0].kind).toBe("stopped");
		expect(rowsLaunching[0].kind).toBe("stopped");
	});
});

describe("mergeExternalConductors — edge cases", () => {
	it("returns empty array when all three sources are empty", () => {
		expect(mergeExternalConductors([], [], [], new Set())).toEqual([]);
	});

	it("preserves the url of configured-only entries", () => {
		const cfg = entry("remote", "Remote", "ws://192.168.1.5:4000");
		const rows = mergeExternalConductors([], [], [cfg], new Set());
		const row = rows[0] as Extract<ExternalRow, { kind: "configured" }>;
		expect(row.url).toBe("ws://192.168.1.5:4000");
	});
});
