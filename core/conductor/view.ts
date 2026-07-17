/*
 * view.ts — the ViewConductor adapter.
 *
 * Bridges the OLD `conduct(view) → Command[]` strategy shape (ported verbatim from the
 * pre-excision contract) onto the NEW resident conductor-v2 contract. A pre-excision conductor
 * ports nearly mechanically: subclass `ViewConductor`, implement `conduct()`, done.
 *
 * The adapter subscribes to `turn-committed` (and `wire-departing` when the subclass declares
 * `holdWireUpToMs > 0`), materializes a read-only `ConductorView` from host queries, calls
 * `conduct()`, and interprets the returned `Command[]` as the strategy's COMPLETE desired state.
 * It diffs that against the desired state it previously applied and proposes only the DELTA ops
 * (including `auto`/`ungroup` for blocks it no longer wants folded). `null` = keep current state.
 */
import type { Conductor, ConductorHost, HostEvent, ViewBlock, GroupInfo, LockName } from "./contract";
import type { Op } from "../ops";
import { foldTag } from "../digest";

// ─── OLD read surface + command vocabulary (ported verbatim) ─────────────────

/**
 * A read-only view of the context the conductor reasons over. `liveTokens` is the baseline to
 * fold down FROM; `protectedFromIndex`/`protectTokens` surface the host's protected working tail
 * as policy; `contextWindow` is the model's total window (or null) — output-token math depends on
 * it. The conductor MUST treat everything here as immutable.
 */
export interface ConductorView {
	blocks: ViewBlock[];
	budget: number;
	contextWindow: number | null;
	liveTokens: number;
	protectedFromIndex: number;
	protectTokens: number;
}

/** Collapse blocks to a digest. No `digest` → the engine's per-kind digest; a `digest` → verbatim. */
export interface FoldCommand {
	kind: "fold";
	ids: string[];
	digest?: string;
}
/**
 * Substitute a block's content with arbitrary text. `content:""` folds to the engine digest.
 * `recoverable` (default false in the OLD vocabulary): when true the host prepends the
 * `{#code FOLDED}` tag so the agent can unfold/recall the ORIGINAL content.
 */
export interface ReplaceCommand {
	kind: "replace";
	id: string;
	content: string;
	recoverable?: boolean;
}
/**
 * Collapse a contiguous run into a single summary entry. `digest`:
 *   - `undefined` → the host's default recap summary (tagged).
 *   - `null` / `""` → DROP (no wire message inserted).
 *   - a non-empty string → that exact summary verbatim (no fold tag added).
 */
export interface GroupCommand {
	kind: "group";
	ids: string[];
	digest?: string | null;
}
/** Return blocks to full, live content (undo a fold/replace). No-op on human-held blocks. */
export interface RestoreCommand {
	kind: "restore";
	ids: string[];
}
/** Assert blocks should stay live and open (force live an id an earlier command folded). */
export interface PinCommand {
	kind: "pin";
	ids: string[];
}

export type Command = FoldCommand | ReplaceCommand | GroupCommand | RestoreCommand | PinCommand;

// ─── The adapter ─────────────────────────────────────────────────────────────

interface TrackedGroup {
	ids: string[];
	digest?: string | null;
	groupId: string;
}

export abstract class ViewConductor implements Conductor {
	abstract readonly id: string;
	abstract readonly label: string;
	readonly description?: string;
	readonly locks?: readonly LockName[];
	readonly tailTokens?: number;
	readonly holdWireUpToMs?: number;

	/** The host, available to subclasses between `attach` and `detach`. */
	protected host!: ConductorHost;

	private off: (() => void) | null = null;
	private attached = false;
	/** Per-block strategy folds this conductor has successfully applied and still wants. id → sig. */
	private applied = new Map<string, string>();
	/** Strategy groups successfully applied, keyed by the named-ids run. */
	private appliedGroups = new Map<string, TrackedGroup>();

	/** The strategy's complete desired state for `view`, or `null` to hold the current state. */
	abstract conduct(view: ConductorView): Command[] | null;

	attach(host: ConductorHost): void {
		this.host = host;
		this.attached = true;
		this.off = host.on((e) => this.onHostEvent(e));
	}

	detach(): void {
		this.attached = false;
		this.off?.();
		this.off = null;
		this.applied.clear();
		this.appliedGroups.clear();
	}

	private onHostEvent(e: HostEvent): void | Promise<void> {
		if (!this.attached) return;
		if (e.type === "turn-committed") return this.rerun();
		else if (e.type === "wire-departing" && (this.holdWireUpToMs ?? 0) > 0) return this.rerun();
		else if (e.type === "resync") this.rebuildFromTruth();
	}

	/**
	 * Re-materialize the view, call `conduct()`, diff, and propose. The local successor to the old
	 * `host.requestRerun()` — an in-process conductor that finishes async work (e.g. an LLM summary)
	 * calls this to emit its derived ops. `propose` is async (contract v2), so this is async too;
	 * the returned promise settles once the transaction's per-op results are reconciled. No-op while
	 * detached.
	 */
	protected async rerun(): Promise<void> {
		if (!this.attached || !this.host) return;
		const view = this.materialize();
		const cmds = this.conduct(view);
		if (cmds === null) return; // hold
		await this.applyDesired(cmds);
	}

	private materialize(): ConductorView {
		const stats = this.host.stats();
		return {
			blocks: this.host.blocks().slice(),
			budget: stats.budget,
			contextWindow: stats.contextWindow,
			liveTokens: stats.liveTokens,
			protectedFromIndex: stats.protectedFromIndex,
			protectTokens: stats.protectTokens,
		};
	}

	/** On a structural resync, rebuild the tracked folded-set AND the tracked group-set from the
	 *  host's actual state so undo-diffing stays correct: a block folded in truth this conductor no
	 *  longer wants gets an `auto` op next pass, and a GROUP it still owns (`by === "auto"`) gets
	 *  re-claimed rather than orphaned — a later pass proposing no group intention for it now
	 *  correctly emits `ungroup` instead of leaving the group stranded in Truth forever. */
	private rebuildFromTruth(): void {
		this.applied.clear();
		this.appliedGroups.clear();
		for (const b of this.host.blocks()) {
			if (b.folded && !b.held && !b.grouped) this.applied.set(b.id, "\x00resync");
		}
		for (const g of this.host.groups()) {
			if (g.by !== "auto") continue; // a human-made group is never this conductor's to reclaim
			this.appliedGroups.set(g.memberIds.join("|"), { ids: g.memberIds.slice(), digest: g.summary, groupId: g.id });
		}
	}

	private async applyDesired(cmds: Command[]): Promise<void> {
		const baseRev = this.host.stats().rev;
		const desiredFolds = new Map<string, { op: Op; sig: string }>();
		const desiredGroups = new Map<string, { ids: string[]; digest?: string | null }>();
		const explicitLive = new Set<string>();
		for (const c of cmds) {
			if (c.kind === "fold") {
				for (const id of c.ids) desiredFolds.set(id, { op: { kind: "fold", ids: [id], digest: c.digest }, sig: `fold:${c.digest ?? ""}` });
			} else if (c.kind === "replace") {
				// The OLD vocabulary's `recoverable` default is false (verbatim substitution) — distinct
				// from the core Op-level default of true. Pin it here so a ported pre-excision conductor
				// keeps its old semantics regardless of what the core `replace` op would otherwise default to.
				const recoverable = c.recoverable ?? false;
				desiredFolds.set(c.id, { op: { kind: "replace", id: c.id, content: c.content, recoverable }, sig: `replace:${recoverable}:${c.content}` });
			} else if (c.kind === "group") {
				desiredGroups.set(c.ids.join("|"), { ids: c.ids.slice(), digest: c.digest });
			} else if (c.kind === "restore" || c.kind === "pin") {
				for (const id of c.ids) explicitLive.add(id);
			}
		}
		const groupMemberIds = new Set<string>();
		for (const g of desiredGroups.values()) for (const id of g.ids) groupMemberIds.add(id);

		const ops: Op[] = [];
		// Ungroup prior groups no longer desired (or whose summary changed).
		for (const [key, g] of this.appliedGroups) {
			const want = desiredGroups.get(key);
			if (!want || want.digest !== g.digest) ops.push({ kind: "ungroup", groupId: g.groupId });
		}
		// Undo prior folds no longer desired / now explicitly live / now swept into a group.
		for (const id of this.applied.keys()) {
			if (!desiredFolds.has(id) || explicitLive.has(id) || groupMemberIds.has(id)) ops.push({ kind: "auto", ids: [id] });
		}
		// Add / refresh folds the strategy now wants.
		for (const [id, d] of desiredFolds) {
			if (explicitLive.has(id) || groupMemberIds.has(id)) continue; // an explicit-live wins
			if (this.applied.get(id) !== d.sig) ops.push(d.op);
		}
		// Add new / changed groups.
		for (const [key, g] of desiredGroups) {
			const prior = this.appliedGroups.get(key);
			if (!prior || prior.digest !== g.digest) ops.push({ kind: "group", ids: g.ids, summary: g.digest });
		}
		if (!ops.length) return;

		const res = await this.host.propose({ baseRev, ops });
		// Reconcile tracked desired-state with what ACTUALLY applied. A clamped op must NOT enter
		// the tracked state (or it would never be retried / would be wrongly diffed next pass).
		for (const r of res.results) {
			const op = r.op;
			if (op.kind === "auto") {
				if (r.applied) for (const id of op.ids) this.applied.delete(id);
			} else if (op.kind === "fold") {
				if (r.applied) this.applied.set(op.ids[0], `fold:${op.digest ?? ""}`);
			} else if (op.kind === "replace") {
				if (r.applied) this.applied.set(op.id, `replace:${op.recoverable ?? false}:${op.content}`);
			} else if (op.kind === "ungroup") {
				if (r.applied) for (const [k, g] of this.appliedGroups) if (g.groupId === op.groupId) { this.appliedGroups.delete(k); break; }
			} else if (op.kind === "group") {
				if (r.applied && r.detail) this.appliedGroups.set(op.ids.join("|"), { ids: op.ids.slice(), digest: op.summary, groupId: r.detail });
			}
		}
	}

	/** The engine's canonical fold tag for `id`, for subclasses building recoverable substitutions. */
	protected foldTag(id: string): string {
		return foldTag(id);
	}
}
