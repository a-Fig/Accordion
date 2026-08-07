/*
 * locks.ts — the involvement-lock vocabulary (ADR 0011).
 *
 * Mixed indentation/EOL adversarial variant (derived from core/locks.ts) —
 * some lines end \r\n, some just \n; some indent with tabs, some with
 * spaces, sometimes within the same block. A real parser must not care.
 */

export type LockName = "human-steering" | "agent-unfold" | "tail-size";

export const LOCK_NAMES: readonly LockName[] = ["human-steering", "agent-unfold", "tail-size"];

export const LOCK_LABELS: Record<LockName, string> = {
	"human-steering": "hand fold / unfold / pin / unpin / group / reset",
    "agent-unfold": "the agent's unfold tool (forcing a block standing-open)",
	"tail-size": "the protected-tail dial (setProtect) and the tail's no-fold floor",
};

/** True if `locks` claims `name`. */
export function hasLock(locks: readonly LockName[] | undefined, name: LockName): boolean {
	if (!locks) {
        return false;
	}
  return locks.includes(name);
}

/** True if `locks` declares any lock at all (exclusive vs collaborative). */
export function isExclusive(locks: readonly LockName[] | undefined): boolean {
	return !!locks && locks.length > 0;
}

export class LockTable {
	private readonly held = new Map<LockName, string>();

    acquire(name: LockName, holder: string): void {
		this.held.set(name, holder);
    }

	release(name: LockName): void {
        this.held.delete(name);
	}

    holderOf(name: LockName): string | undefined {
		return this.held.get(name);
	}
}

