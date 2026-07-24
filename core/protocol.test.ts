/*
 * protocol.test.ts — wire-message guard coverage for `core/protocol.ts`.
 *
 * There was no dedicated protocol-guard test file before Phase C's v13 additions (the app side
 * exercises `isServerMessage`/`isWireBlock` only indirectly, through `liveClient.svelte.ts`'s
 * message pump). This file targets `isServerMessage`/`isClientMessage` directly: every message
 * `type` the protocol introduces must be ACCEPTED (the guards vet only the `type` tag — an
 * authorized peer may still send a malformed body, which is each consumer's job to guard further),
 * and an unrecognized/malformed `type` must be REJECTED by both. v14 adds the client-side
 * `holdRelease`/`cancelComplete` messages and a `holdId` on `wireDeparting`.
 */
import { describe, it, expect } from "vitest";
import { isServerMessage, isClientMessage, sanitizeCommand, sanitizeSurfaceId, sanitizeSurfaceLabel, PROTOCOL_VERSION } from "./protocol";
import type {
	HelloMessage,
	ControllerMessage,
	ClaimControllerMessage,
	ControllerInfo,
	CommandResultMessage,
	ActiveConductorMeta,
	ConductorStateMessage,
	ConductorStatusMessage,
	WireDepartingMessage,
	TurnCommittedMessage,
	ProposeResultMessage,
	CompleteResultMessage,
	TelemetryMessage,
	ProposeMessage,
	CompleteRequestMessage,
	SetConductorStatusMessage,
	HoldReleaseMessage,
	CancelCompleteMessage,
	WireCommand,
	NoticeMessage,
} from "./protocol";

describe("PROTOCOL_VERSION", () => {
	it("is bumped to 18 for provider-anchored token calibration (issue #11 stage 1, ADR 0025)", () => {
		expect(PROTOCOL_VERSION).toBe(18);
	});
});

describe("isServerMessage — v13 additions", () => {
	const conductorMeta: ActiveConductorMeta = {
		id: "doorman",
		label: "Doorman",
		locks: ["human-steering"],
		tailTokens: 5000,
		holdWireUpToMs: 200,
		remote: false,
	};

	it("accepts a hello WITHOUT `conductors` (backward-compatible shape)", () => {
		const msg: HelloMessage = {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			role: "gui",
			meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: null, format: "pi" },
		};
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts a hello WITH a `conductors` catalog", () => {
		const msg: HelloMessage = {
			type: "hello",
			protocolVersion: PROTOCOL_VERSION,
			role: "gui",
			meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: null, format: "pi" },
			conductors: [conductorMeta],
		};
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts conductorState (active conductor and null alike)", () => {
		const active: ConductorStateMessage = { type: "conductorState", active: conductorMeta };
		const none: ConductorStateMessage = { type: "conductorState", active: null };
		expect(isServerMessage(active)).toBe(true);
		expect(isServerMessage(none)).toBe(true);
	});

	it("accepts conductorStatus", () => {
		const msg: ConductorStatusMessage = { type: "conductorStatus", text: "compacting turn 4", metrics: { savedTokens: 1200 } };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts wireDeparting (carrying the v14 holdId)", () => {
		const msg: WireDepartingMessage = { type: "wireDeparting", rev: 3, liveTokens: 400, budget: 70_000, freshIds: ["a:b0:p0"], holdMs: 150, holdId: 1 };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts turnCommitted", () => {
		const msg: TurnCommittedMessage = { type: "turnCommitted", turn: 2, rev: 5 };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts proposeResult", () => {
		const msg: ProposeResultMessage = { type: "proposeResult", seq: 1, rev: 6, results: [{ op: { kind: "fold", ids: ["x"] }, applied: true }] };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts completeResult (success and failure alike)", () => {
		const ok: CompleteResultMessage = { type: "completeResult", reqId: 1, ok: true, text: "summary", model: "current" };
		const failed: CompleteResultMessage = { type: "completeResult", reqId: 2, ok: false, error: "model unavailable" };
		expect(isServerMessage(ok)).toBe(true);
		expect(isServerMessage(failed)).toBe(true);
	});

	it("accepts telemetry carrying the new lastHoldMs/holdTimeouts fields", () => {
		const msg: TelemetryMessage = { type: "telemetry", lastHookMs: 2, maxHookMs: 9, p95HookMs: 5, rebuilds: 0, hookCount: 12, lastHoldMs: 40, holdTimeouts: 1 };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("negative case: rejects an unrecognized server message type", () => {
		expect(isServerMessage({ type: "not-a-real-message" })).toBe(false);
		expect(isServerMessage({ type: "conductorStatee" })).toBe(false); // typo — must not fuzzy-match
		expect(isServerMessage(null)).toBe(false);
		expect(isServerMessage({})).toBe(false);
	});
});

describe("isClientMessage — v13 additions", () => {
	it("accepts propose", () => {
		const msg: ProposeMessage = { type: "propose", seq: 1, baseRev: 4, ops: [{ kind: "fold", ids: ["a:b0:p0"] }] };
		expect(isClientMessage(msg)).toBe(true);
	});

	it("accepts completeRequest", () => {
		const msg: CompleteRequestMessage = { type: "completeRequest", reqId: 7, prompt: "summarize this", maxOutputTokens: 200 };
		expect(isClientMessage(msg)).toBe(true);
	});

	it("accepts setConductorStatus", () => {
		const msg: SetConductorStatusMessage = { type: "setConductorStatus", text: "idle" };
		expect(isClientMessage(msg)).toBe(true);
	});

	it("accepts holdRelease (v14 wire-departing hold release)", () => {
		const msg: HoldReleaseMessage = { type: "holdRelease", holdId: 7 };
		expect(isClientMessage(msg)).toBe(true);
	});

	it("accepts cancelComplete (v14 completion abort forwarding)", () => {
		const msg: CancelCompleteMessage = { type: "cancelComplete", reqId: 3 };
		expect(isClientMessage(msg)).toBe(true);
	});

	it("still accepts the pre-v13 command/resnapshot shapes", () => {
		expect(isClientMessage({ type: "command", seq: 1, cmd: { kind: "setBudget", value: 1000 } })).toBe(true);
		expect(isClientMessage({ type: "resnapshot" })).toBe(true);
	});

	it("negative case: rejects an unrecognized client message type", () => {
		expect(isClientMessage({ type: "not-a-real-command" })).toBe(false);
		expect(isClientMessage(null)).toBe(false);
		expect(isClientMessage({})).toBe(false);
	});
});

describe("WireCommand — selectConductor (type-level shape, v13)", () => {
	it("selectConductor carries an id or null (attach vs. detach)", () => {
		const attach: WireCommand = { kind: "selectConductor", id: "doorman" };
		const detach: WireCommand = { kind: "selectConductor", id: null };
		expect(attach.kind).toBe("selectConductor");
		expect(detach.id).toBeNull();
	});
});

// The numeric-dial ingress gate: an authorized-but-buggy client can send a `command` whose `cmd`
// carries a NaN/Infinity/negative budget/protect, which would poison Truth's dial and fork replicas
// (JSON serializes NaN/Infinity as null). `sanitizeCommand` coerces or refuses before Truth ever
// sees it. `ops` commands route through `sanitizeOps` (structural per-op gate).
describe("sanitizeCommand — numeric-dial + ops ingress gate (fix #5)", () => {
	it("refuses a NaN / Infinity / non-number setBudget (would poison the dial + fork replicas)", () => {
		expect(sanitizeCommand({ kind: "setBudget", value: NaN })).toBeNull();
		expect(sanitizeCommand({ kind: "setBudget", value: Infinity })).toBeNull();
		expect(sanitizeCommand({ kind: "setBudget", value: "50000" })).toBeNull();
	});
	it("clamps a negative setProtect to ≥0 and passes a finite value through", () => {
		expect(sanitizeCommand({ kind: "setProtect", value: -5 })).toEqual({ kind: "setProtect", value: 0 });
		expect(sanitizeCommand({ kind: "setBudget", value: 50_000 })).toEqual({ kind: "setBudget", value: 50_000 });
	});
	it("sanitizes an ops command (drops malformed ops), and returns null when ops is not an array", () => {
		const out = sanitizeCommand({ kind: "ops", ops: [{ kind: "fold", ids: ["a"] }, null, { kind: "bogus" }] });
		expect(out).toEqual({ kind: "ops", ops: [{ kind: "fold", ids: ["a"] }] });
		expect(sanitizeCommand({ kind: "ops", ops: "not-an-array" })).toBeNull();
	});
	it("validates setFolding (boolean only) and selectConductor (string | null)", () => {
		expect(sanitizeCommand({ kind: "setFolding", value: true })).toEqual({ kind: "setFolding", value: true });
		expect(sanitizeCommand({ kind: "setFolding", value: 1 })).toBeNull();
		expect(sanitizeCommand({ kind: "selectConductor", id: "doorman" })).toEqual({ kind: "selectConductor", id: "doorman" });
		expect(sanitizeCommand({ kind: "selectConductor", id: null })).toEqual({ kind: "selectConductor", id: null });
		expect(sanitizeCommand({ kind: "selectConductor", id: 42 })).toBeNull();
	});
	it("returns null on a non-object or an unknown kind", () => {
		expect(sanitizeCommand(null)).toBeNull();
		expect(sanitizeCommand({ kind: "not-a-command" })).toBeNull();
	});
});

// ── v16: single-controller + the stable door (ADR 0024) ──────────────────────
describe("v16 — controller/claimController message guards", () => {
	it("accepts a hello carrying the controller lease (present and null alike)", () => {
		const info: ControllerInfo = { surfaceId: "s-abc", label: "Desktop app", fresh: true };
		const withLease: HelloMessage = {
			type: "hello", protocolVersion: PROTOCOL_VERSION, role: "gui",
			meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: null, format: "pi" }, controller: info,
		};
		const noLease: HelloMessage = {
			type: "hello", protocolVersion: PROTOCOL_VERSION, role: "gui",
			meta: { title: "t", cwd: "/tmp", model: "m", contextWindow: null, format: "pi" }, controller: null,
		};
		expect(isServerMessage(withLease)).toBe(true);
		expect(isServerMessage(noLease)).toBe(true);
	});

	it("accepts a controller broadcast (server→client)", () => {
		const msg: ControllerMessage = { type: "controller", surfaceId: "s-abc", label: "Browser tab" };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("accepts a claimController request (client→server)", () => {
		const msg: ClaimControllerMessage = { type: "claimController" };
		expect(isClientMessage(msg)).toBe(true);
	});

	it("a commandResult may carry the read-only refusal (type-level)", () => {
		const refused: CommandResultMessage = { type: "commandResult", seq: 3, results: [], rev: 9, refused: "read-only" };
		expect(isServerMessage(refused)).toBe(true);
		expect(refused.refused).toBe("read-only");
	});
});

// ── v17: the generic `notice` broadcast ───────────────────────────────────────
describe("v17 — notice message guard", () => {
	it("accepts a notice broadcast (server→client)", () => {
		const msg: NoticeMessage = { type: "notice", text: "pi compacted the session natively — Accordion's map has been rebuilt to match." };
		expect(isServerMessage(msg)).toBe(true);
	});

	it("rejects an unrecognized type (guards don't merely check for a `text` field)", () => {
		expect(isServerMessage({ type: "notic", text: "typo'd type" })).toBe(false);
	});
});

// Surface-identity dial params are the SAME "authorized ≠ well-formed" ingress class as
// sanitizeCommand: a malformed/hostile value must never reach the controller.json lease or a broadcast.
describe("v16 — sanitizeSurfaceId / sanitizeSurfaceLabel ingress gates", () => {
	it("accepts a UUID-shaped surface id and other bounded [A-Za-z0-9._-] tokens", () => {
		expect(sanitizeSurfaceId("3f9a2c00-1111-2222-3333-444455556666")).toBe("3f9a2c00-1111-2222-3333-444455556666");
		expect(sanitizeSurfaceId("surface_A.1-2")).toBe("surface_A.1-2");
		expect(sanitizeSurfaceId("  trimmed  ")).toBe("trimmed");
	});
	it("refuses a non-string, empty, over-length, or charset-violating surface id", () => {
		expect(sanitizeSurfaceId(42)).toBeNull();
		expect(sanitizeSurfaceId("")).toBeNull();
		expect(sanitizeSurfaceId("   ")).toBeNull();
		expect(sanitizeSurfaceId("bad id with spaces")).toBeNull();
		expect(sanitizeSurfaceId("inject/../path")).toBeNull();
		expect(sanitizeSurfaceId("x".repeat(65))).toBeNull();
	});
	it("keeps a printable label (spaces allowed), strips control chars, caps length", () => {
		expect(sanitizeSurfaceLabel("Desktop app")).toBe("Desktop app");
		expect(sanitizeSurfaceLabel("Browser tab")).toBe("Browser tab");
		expect(sanitizeSurfaceLabel("bad	chars")).toBe("badchars");
		expect(sanitizeSurfaceLabel("  spaced  ")).toBe("spaced");
		expect(sanitizeSurfaceLabel("x".repeat(80))!.length).toBe(48);
	});
	it("refuses a non-string or an all-control/empty label", () => {
		expect(sanitizeSurfaceLabel(7)).toBeNull();
		expect(sanitizeSurfaceLabel("")).toBeNull();
		expect(sanitizeSurfaceLabel("")).toBeNull();
	});
});
