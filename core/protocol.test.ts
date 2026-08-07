/*
 * protocol.test.ts — wire-message guard coverage for `core/protocol.ts`.
 *
 * There was no dedicated protocol-guard test file before Phase C's v13 additions (the app side
 * exercises `isServerMessage`/`isWireBlock` only indirectly, through `liveClient.svelte.ts`'s
 * message pump). This file targets `isServerMessage`/`isClientMessage` directly: every message
 * `type` the v13 protocol introduces must be ACCEPTED (the guards vet only the `type` tag — an
 * authorized peer may still send a malformed body, which is each consumer's job to guard further),
 * and an unrecognized/malformed `type` must be REJECTED by both.
 */
import { describe, it, expect } from "vitest";
import { isServerMessage, isClientMessage, PROTOCOL_VERSION } from "./protocol";
import type {
	HelloMessage,
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
	WireCommand,
} from "./protocol";

describe("PROTOCOL_VERSION", () => {
	it("is bumped to 13 for the Phase C additions", () => {
		expect(PROTOCOL_VERSION).toBe(13);
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

	it("accepts wireDeparting", () => {
		const msg: WireDepartingMessage = { type: "wireDeparting", rev: 3, liveTokens: 400, budget: 70_000, freshIds: ["a:b0:p0"], holdMs: 150 };
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
