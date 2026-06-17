/*
 * autopilot.ts — Accordion's worked example of a FULLY EXCLUSIVE conductor (ADR 0011).
 *
 * AutopilotConductor declares all three involvement locks:
 *   - "human-steering"  — no manual fold/unfold/pin/group/reset from the human
 *   - "agent-unfold"    — the agent's `unfold` tool is gated
 *   - "tail-size"       — the protected-tail dial is locked; the conductor may fold
 *                         recent blocks (the host lifts its tail floor under this lock)
 *
 * Under the "tail-size" lock the host sets `protectedFromIndex = blocks.length`, so
 * every block arrives with `protected: false`. The candidate filter below therefore
 * naturally includes recent blocks — no special-case needed.
 *
 * STRATEGY: Identical to the built-in (oldest-first, lowest-value-kind-first, greedy
 * fold until liveTokens ≤ budget). The ONLY behavioural difference is that it is
 * allowed to fold recent blocks because the tail-size lock lifts the host floor.
 *
 * This is a PURE function of the view — no `$state`, no store reference, no mutation,
 * no engine reach-in. It consumes ONLY the public `ConductorView`, the same surface any
 * out-of-process conductor gets. It is the worked example: show that an exclusive
 * conductor needs nothing special beyond declaring its locks.
 */
import type { Conductor, ConductorView, ConductorBlockKind, Command } from "../contract";

/**
 * Lower value → folded sooner. Mirrors the built-in's FOLD_RANK exactly; the
 * Autopilot conductor makes no different judgement — it just has more authority.
 */
const FOLD_RANK: Record<ConductorBlockKind, number> = {
	tool_result: 0, // huge, decays fastest → fold first, hardest
	thinking: 1,    // ephemeral reasoning
	text: 2,        // conclusions, medium durable value
	tool_call: 3,   // tiny + durable record of an action → fold last
	user: 4,        // the instruction/intent → fold last of all
};

export class AutopilotConductor implements Conductor {
	readonly id = "autopilot";
	readonly label = "Autopilot";

	/**
	 * All three steering controls are locked. The host gates the human and agent from
	 * interfering; the human's only recourse is detach (the kill switch). See ADR 0011.
	 *
	 * `tailTokens` is deliberately omitted (defaults to 0 = own the whole context, no
	 * protected tail). A conductor that wants to preserve a protected tail can declare
	 * e.g. `tailTokens = 8000` to keep the newest ~8 k tokens protected while managing
	 * everything older.
	 */
	readonly locks = ["human-steering", "agent-unfold", "tail-size"] as const;

	/**
	 * Fold lowest-value, oldest candidates until the live context fits the budget.
	 *
	 * Identical algorithm to BuiltinConductor — the point is that with the "tail-size"
	 * lock the host will have set `protectedFromIndex = blocks.length`, so all blocks
	 * arrive with `protected: false` and the candidate filter naturally reaches recent
	 * blocks without any extra logic here.
	 */
	conduct(view: ConductorView): Command[] {
		let live = view.liveTokens;
		if (live <= view.budget) return [];

		const cand = view.blocks
			.filter((b) => !b.held && !b.protected && !b.grouped && b.foldedTokens < b.tokens)
			.sort((a, b) => FOLD_RANK[a.kind] - FOLD_RANK[b.kind] || a.order - b.order);

		const ids: string[] = [];
		for (const b of cand) {
			if (live <= view.budget) break;
			ids.push(b.id);
			live += b.foldedTokens - b.tokens;
		}
		return ids.length ? [{ kind: "fold", ids }] : [];
	}
}
