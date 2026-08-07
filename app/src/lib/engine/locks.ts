/*
 * locks.ts — the involvement-lock vocabulary (ADR 0011).
 *
 * An involvement lock lets a context-management strategy take UNCONTESTED control of a
 * specific steering control: while a lock is held, the human (or the agent) can no longer
 * reach in and override that control by hand. "Human overrides always win" becomes "human
 * overrides win for every control the holder did NOT lock." Trust moves from *override* to
 * *revocability* — you can always take the keys back (the future conductor host's kill
 * switch), you just can't surgically fight a locked control mid-run.
 *
 * Only STEERING — actions that change the agent's context — is ever lockable. The sacred
 * tier is NEVER lockable in any way: observation (peek / the live map / the activity log /
 * the budget readout), the budget dial, the agent's `recall`, and detach. Locking is about
 * *touching*, never *seeing*.
 *
 * This module is deliberately dependency-free and runes-free — it defines the vocabulary the
 * engine store gates on and the future conductor host drives. The lock STATE (which locks are
 * held, by whom, with what tail) lives on the store (`AccordionStore.setLocks/clearLocks`);
 * this file is only the names + predicates.
 *
 * HISTORY: this vocabulary previously lived in the (removed) conductor contract. It is
 * restored here as a first-class ENGINE capability. NO conductor object holds a lock today —
 * locks are set programmatically via the store's `setLocks`/`clearLocks`; the conductor
 * redesign's host will drive that API and reinstate the consent flow.
 */

/**
 * The three steering controls a holder may take EXCLUSIVE control of (ADR 0011 §2):
 *
 *  - `human-steering` — the human's hand fold / unfold / pin / unpin / group / reset. Under
 *    this lock every human steering entry point is refused by the engine (no override is ever
 *    created), and the human's only recourse is to release the lock.
 *  - `agent-unfold` — the agent's `unfold` tool (forcing a folded block standing-open). A
 *    SEPARATE axis from `human-steering`: a holder can lock the human and leave the agent
 *    free, or the reverse, or both. The agent's `recall` is NOT gated by this (it is sacred),
 *    so locking `agent-unfold` never blinds the agent — it only stops it from *forcing* a
 *    block to stand open against the strategy.
 *  - `tail-size` — the protected-tail dial (`setProtect`) AND the tail's no-fold floor. Under
 *    this lock the human can no longer resize the tail and the host stops treating the
 *    protected tail as an absolute floor; the holder declares how much tail it wants via
 *    `tailTokens` (`0` ⇒ own the whole context, no protected tail; `> 0` ⇒ protect the newest
 *    ~N tokens, which stay unfoldable).
 */
export type LockName = "human-steering" | "agent-unfold" | "tail-size";

/**
 * All lockable controls, in canonical order (for UIs that render the lock table / the future
 * consent gate). The single source of truth for iterating the vocabulary.
 */
export const LOCK_NAMES: readonly LockName[] = ["human-steering", "agent-unfold", "tail-size"];

/**
 * Human-readable descriptions of what each lock claims — the "What it claims" column of the
 * ADR 0011 §2 table. Surfaced by any UI that explains a lock to the user (the future consent
 * gate's checks-and-x's table). Keyed by `LockName` so a UI can render every lock.
 */
export const LOCK_LABELS: Record<LockName, string> = {
	"human-steering": "hand fold / unfold / pin / unpin / group / reset",
	"agent-unfold": "the agent's unfold tool (forcing a block standing-open)",
	"tail-size": "the protected-tail dial (setProtect) and the tail's no-fold floor",
};

/** True if `locks` claims `name`. The single predicate the engine/UI use to test a lock. */
export function hasLock(locks: readonly LockName[] | undefined, name: LockName): boolean {
	return !!locks && locks.includes(name);
}

/** True if `locks` declares any lock at all (exclusive vs collaborative). */
export function isExclusive(locks: readonly LockName[] | undefined): boolean {
	return !!locks && locks.length > 0;
}
